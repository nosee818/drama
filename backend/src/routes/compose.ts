import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { success, badRequest } from '../utils/response.js'
import { composeStoryboard } from '../services/ffmpeg-compose.js'
import { logTaskError, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'
import { toSnakeCase } from '../utils/transform.js'

const app = new Hono()

// POST /storyboards/:id/compose — 视频配音合成单个镜头
app.post('/storyboards/:id/compose', async (c) => {
  const id = Number(c.req.param('id'))
  try {
    const [sb] = db.select().from(schema.storyboards).where(eq(schema.storyboards.id, id)).all()
    if (!sb) return badRequest(c, 'Storyboard not found')
    if (!sb.videoUrl) return badRequest(c, 'Storyboard has no video')
    if (!sb.ttsAudioUrl) {
      return success(c, { id, skipped: true, reason: 'No TTS audio; use original video directly', video_url: sb.videoUrl })
    }
    logTaskStart('ComposeAPI', 'single-compose', { storyboardId: id })
    const composedUrl = await composeStoryboard(id)
    logTaskSuccess('ComposeAPI', 'single-compose', { storyboardId: id, output: composedUrl })
    return success(c, { id, composed_video_url: composedUrl })
  } catch (err: any) {
    logTaskError('ComposeAPI', 'single-compose', { storyboardId: id, error: err.message })
    return badRequest(c, err.message)
  }
})

// POST /episodes/:id/compose-all — 批量视频配音合成全部有配音镜头
app.post('/episodes/:id/compose-all', async (c) => {
  const episodeId = Number(c.req.param('id'))
  const storyboards = db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId))
    .orderBy(schema.storyboards.storyboardNumber)
    .all()

  if (storyboards.length === 0) return badRequest(c, 'No storyboards found')

  const withVideo = storyboards.filter(sb => sb.videoUrl)
  if (withVideo.length === 0) return badRequest(c, 'No storyboards have video yet')
  const withVoice = withVideo.filter(sb => !!sb.ttsAudioUrl)
  if (withVoice.length === 0) {
    logTaskSuccess('ComposeAPI', 'batch-compose-skipped', { episodeId, total: withVideo.length, skipped: withVideo.length })
    return success(c, {
      message: `Skipped voice compose: no TTS audio found. ${withVideo.length} original videos can be merged directly.`,
      total: 0,
      skipped: withVideo.length,
    })
  }

  // 异步处理
  for (const sb of withVoice) {
    db.update(schema.storyboards)
      .set({ status: 'compose_processing' })
      .where(eq(schema.storyboards.id, sb.id))
      .run()
  }

  ;(async () => {
    for (const sb of withVoice) {
      try {
        await composeStoryboard(sb.id)
      } catch (err: any) {
        logTaskError('ComposeAPI', 'batch-item', { storyboardId: sb.id, episodeId, error: err.message })
      }
    }
    logTaskSuccess('ComposeAPI', 'batch-compose', { episodeId, total: withVoice.length, skipped: withVideo.length - withVoice.length })
  })()

  logTaskStart('ComposeAPI', 'batch-compose', { episodeId, total: withVoice.length, skipped: withVideo.length - withVoice.length })
  return success(c, {
    message: `Started voice composing ${withVoice.length} storyboards; skipped ${withVideo.length - withVoice.length} without TTS`,
    total: withVoice.length,
    skipped: withVideo.length - withVoice.length,
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
  const withVoice = withVideo.filter(sb => !!sb.ttsAudioUrl)
  const completed = withVoice.filter(sb => sb.status === 'compose_completed' && !!sb.composedVideoUrl)
  const failed = withVideo.filter(sb => sb.status === 'compose_failed')
  const processing = withVideo.filter(sb => sb.status === 'compose_processing')
  const skipped = withVideo.filter(sb => !sb.ttsAudioUrl)
  const idle = withVoice.filter(sb => !sb.status || !String(sb.status).startsWith('compose_'))

  return success(c, {
    total: withVoice.length,
    completed: completed.length,
    failed: failed.length,
    processing: processing.length,
    idle: idle.length,
    skipped: skipped.length,
    items: withVideo.map((sb) => toSnakeCase({
      id: sb.id,
      storyboardNumber: sb.storyboardNumber,
      status: sb.ttsAudioUrl ? (sb.status || 'pending') : 'compose_skipped',
      composedVideoUrl: sb.composedVideoUrl,
      errorMsg: sb.status === 'compose_failed' ? '视频配音合成失败，请检查视频、配音或字幕素材' : '',
    })),
  })
})

export default app
