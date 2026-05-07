import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { success, created, badRequest, now } from '../utils/response.js'
import { generateImage } from '../services/image-generation.js'
import { logTaskError, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'
import { dramaOrientation, orientationImageSize } from '../utils/aspect.js'

const app = new Hono()

function safeJson(value?: string | null) {
  try { return JSON.parse(value || '{}') || {} } catch { return {} }
}

function sceneImageConfigId(drama: any, fallback?: number | null) {
  const defaults = safeJson(drama?.metadata).ai_defaults || {}
  return Number(defaults.scene_image_config_id || defaults.image_config_id || fallback || 0) || undefined
}

function emptyScenePrompt(prompt: string) {
  const base = String(prompt || '').trim()
  const guard = '空场景，纯环境背景，没有任何人物、脸、身体、手、剪影、人群或角色，重点表现空间结构、陈设、光线和氛围，不要文字、签名或水印'
  if (!base) return guard
  if (/空场景|无人|无人物|不要出现人物|没有任何人物/.test(base)) return base
  return `${base}，${guard}`
}

// POST /scenes
app.post('/', async (c) => {
  const body = await c.req.json()
  const ts = now()
  const res = db.insert(schema.scenes).values({
    dramaId: body.drama_id,
    episodeId: body.episode_id,
    location: body.location,
    time: body.time || '',
    prompt: body.prompt || body.location,
    createdAt: ts,
    updatedAt: ts,
  }).run()
  const [result] = db.select().from(schema.scenes)
    .where(eq(schema.scenes.id, Number(res.lastInsertRowid))).all()
  return created(c, result)
})

// PUT /scenes/:id
app.put('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json()
  const updates: Record<string, any> = { updatedAt: now() }
  if (body.location !== undefined) updates.location = body.location
  if (body.time !== undefined) updates.time = body.time
  if (body.prompt !== undefined) updates.prompt = body.prompt
  db.update(schema.scenes).set(updates).where(eq(schema.scenes.id, id)).run()
  return success(c)
})

// POST /scenes/:id/generate-image
app.post('/:id/generate-image', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json()
  const [scene] = db.select().from(schema.scenes).where(eq(schema.scenes.id, id)).all()
  if (!scene) return badRequest(c, 'Scene not found')
  if (!body.episode_id) return badRequest(c, 'episode_id is required')
  const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, Number(body.episode_id))).all()
  if (!ep) return badRequest(c, 'Episode not found')

  const prompt = emptyScenePrompt(scene.prompt || `${scene.location}, ${scene.time || ''}, 高质量场景, 电影感`)
  try {
    logTaskStart('SceneImage', 'generate', { sceneId: id, episodeId: ep.id, dramaId: scene.dramaId, location: scene.location })
    db.update(schema.scenes).set({ status: 'processing', updatedAt: now() }).where(eq(schema.scenes.id, id)).run()
    const [drama] = db.select().from(schema.dramas).where(eq(schema.dramas.id, scene.dramaId)).all()
    const genId = await generateImage({ sceneId: id, dramaId: scene.dramaId, prompt, size: orientationImageSize(dramaOrientation(drama)), configId: body.config_id || sceneImageConfigId(drama, ep.imageConfigId) })
    logTaskSuccess('SceneImage', 'generate', { sceneId: id, generationId: genId })
    return success(c, { image_generation_id: genId })
  } catch (err: any) {
    logTaskError('SceneImage', 'generate', { sceneId: id, error: err.message })
    db.update(schema.scenes).set({ status: 'failed', updatedAt: now() }).where(eq(schema.scenes.id, id)).run()
    return badRequest(c, err.message)
  }
})

// DELETE /scenes/:id
app.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  db.delete(schema.scenes).where(eq(schema.scenes.id, id)).run()
  return success(c)
})

export default app
