import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { success, created, badRequest, now } from '../utils/response.js'
import { generateImage } from '../services/image-generation.js'
import { saveUploadedFile } from '../utils/storage.js'
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
  return String(prompt || '').trim()
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

  const prompt = emptyScenePrompt(scene.prompt || [scene.location, scene.time].filter(Boolean).join('，'))
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

// POST /scenes/:id/upload-image — 上传并设为当前场景图
app.post('/:id/upload-image', async (c) => {
  const id = Number(c.req.param('id'))
  const [scene] = db.select().from(schema.scenes).where(eq(schema.scenes.id, id)).all()
  if (!scene) return badRequest(c, 'Scene not found')

  const body = await c.req.parseBody()
  const file = body['file']
  if (!file || !(file instanceof File)) return badRequest(c, 'file is required')

  const buffer = await file.arrayBuffer()
  const localPath = await saveUploadedFile(buffer, 'images', file.name)
  const ts = now()
  db.insert(schema.imageGenerations).values({
    dramaId: scene.dramaId,
    sceneId: id,
    imageType: 'scene',
    provider: 'manual',
    prompt: '用户上传场景图',
    localPath,
    imageUrl: localPath,
    status: 'completed',
    createdAt: ts,
    updatedAt: ts,
    completedAt: ts,
  }).run()
  db.update(schema.scenes)
    .set({ imageUrl: localPath, localPath, status: 'completed', updatedAt: ts })
    .where(eq(schema.scenes.id, id))
    .run()
  return success(c, { image_url: localPath })
})

// DELETE /scenes/:id
app.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  db.delete(schema.scenes).where(eq(schema.scenes.id, id)).run()
  return success(c)
})

export default app
