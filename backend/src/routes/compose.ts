import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { success, badRequest } from '../utils/response.js'
import { composeStoryboard } from '../services/ffmpeg-compose.js'
import { logTaskError, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'
import { toSnakeCase } from '../utils/transform.js'

const app = new Hono()

async function readComposeOptions(c: any) {
  const body = await c.req.json().catch(() => ({}))
  return { keepOriginalAudio: Boolean(body?.keep_original_audio ?? body?.keepOriginalAudio) }
}

// POST /storyboards/:id/compose — 视频配音合成单个镜头
app.post('/storyboards/:id/compose', async (c) => {
  const id = Number(c.req.param('id'))
  try {
    const options = await readComposeOptions(c)
    const [sb] = db.select().from(schema.storyboards).where(eq(schema.storyboards.id, id)).all()
    if (!sb) return badRequest(c, 'Storyboard not found')
    if (!sb.videoUrl) return badRequest(c, 'Storyboard has no video')
    logTaskStart('ComposeAPI', 'single-compose', { storyboardId: id, keepOriginalAudio: options.keepOriginalAudio })
    const composedUrl = await composeStoryboard(id, options)
    logTaskSuccess('ComposeAPI', 'single-compose', { storyboardId: id, output: composedUrl, keepOriginalAudio: options.keepOriginalAudio })
    return success(c, { id, composed_video_url: composedUrl })
  } catch (err: any) {
    logTaskError('ComposeAPI', 'single-compose', { storyboardId: id, error: err.message })
    return badRequest(c, err.message)
  }
})

// POST /episodes/:id/compose-all — 批量视频配音合成全部镜头
app.post('/episodes/:id/compose-all', async (c) => {
  const episodeId = Number(c.req.param('id'))
  const options = await readComposeOptions(c)
  const storyboards = db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId))
    .orderBy(schema.storyboards.storyboardNumber)
    .all()

  if (storyboards.length === 0) return badRequest(c, 'No storyboards found')

  const withVideo = storyboards.filter(sb => sb.videoUrl)
  if (withVideo.length === 0) return badRequest(c, 'No storyboards have video yet')

  // 异步处理
  for (const sb of withVideo) {
    db.update(schema.storyboards)
      .set({ status: 'compose_processing' })
      .where(eq(schema.storyboards.id, sb.id))
      .run()
  }

  ;(async () => {
    for (const sb of withVideo) {
      try {
        await composeStoryboard(sb.id, options)
      } catch (err: any) {
        logTaskError('ComposeAPI', 'batch-item', { storyboardId: sb.id, episodeId, error: err.message })
      }
    }
    logTaskSuccess('ComposeAPI', 'batch-compose', { episodeId, total: withVideo.length, keepOriginalAudio: options.keepOriginalAudio })
  })()

  logTaskStart('ComposeAPI', 'batch-compose', { episodeId, total: withVideo.length, keepOriginalAudio: options.keepOriginalAudio })
  return success(c, {
    message: `Started video and voice composing ${withVideo.length} storyboards`,
    total: withVideo.length,
    skipped: 0,
    keep_original_audio: options.keepOriginalAudio,
  })
})

// GET /episodes/:id/compose-status — 查询批量合成状态
app.get('/episodes/:id/compose-status', async (c) => {
  const episodeId = Number(c.req.param('id'))
  const storyboards = db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId))
    .orderBy(schema.storyboards.storyboardNumber)
    .all()

  const withVideo = storyboards.filter(sb => !!sb.videoUrl)
  const completed = withVideo.filter(sb => sb.status === 'compose_completed' && !!sb.composedVideoUrl)
  const failed = withVideo.filter(sb => sb.status === 'compose_failed')
  const processing = withVideo.filter(sb => sb.status === 'compose_processing')
  const idle = withVideo.filter(sb => !sb.status || !String(sb.status).startsWith('compose_'))

  return success(c, {
    total: withVideo.length,
    completed: completed.length,
    failed: failed.length,
    processing: processing.length,
    idle: idle.length,
    skipped: 0,
    items: withVideo.map((sb) => toSnakeCase({
      id: sb.id,
      storyboardNumber: sb.storyboardNumber,
      status: sb.status || 'pending',
      composedVideoUrl: sb.composedVideoUrl,
      errorMsg: sb.status === 'compose_failed' ? '视频配音合成失败，请检查视频、配音或字幕素材' : '',
    })),
  })
})

export default app
