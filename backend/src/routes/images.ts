import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { success, created, now, badRequest } from '../utils/response.js'
import { generateImage } from '../services/image-generation.js'
import { logTaskError, logTaskPayload, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'
import { dramaOrientation, orientationImageSize } from '../utils/aspect.js'

const app = new Hono()

function getDramaForImageRequest(body: any) {
  if (body.drama_id) {
    return db.select().from(schema.dramas).where(eq(schema.dramas.id, Number(body.drama_id))).all()[0]
  }
  if (body.storyboard_id) {
    const sb = db.select().from(schema.storyboards).where(eq(schema.storyboards.id, Number(body.storyboard_id))).all()[0]
    if (sb) {
      const ep = db.select().from(schema.episodes).where(eq(schema.episodes.id, sb.episodeId)).all()[0]
      if (ep) return db.select().from(schema.dramas).where(eq(schema.dramas.id, ep.dramaId)).all()[0]
    }
  }
  if (body.scene_id) {
    const scene = db.select().from(schema.scenes).where(eq(schema.scenes.id, Number(body.scene_id))).all()[0]
    if (scene) return db.select().from(schema.dramas).where(eq(schema.dramas.id, scene.dramaId)).all()[0]
  }
  if (body.character_id) {
    const char = db.select().from(schema.characters).where(eq(schema.characters.id, Number(body.character_id))).all()[0]
    if (char) return db.select().from(schema.dramas).where(eq(schema.dramas.id, char.dramaId)).all()[0]
  }
  return null
}

function safeJson(value?: string | null) {
  try {
    return JSON.parse(value || '{}') || {}
  } catch {
    return {}
  }
}

function imageConfigForRequest(drama: any, body: any, fallback?: number) {
  if (body.config_id) return body.config_id
  const defaults = safeJson(drama?.metadata).ai_defaults || {}
  if (body.character_id) return defaults.character_image_config_id || defaults.image_config_id || fallback
  if (body.scene_id) return defaults.scene_image_config_id || defaults.image_config_id || fallback
  if (body.storyboard_id || body.frame_type) return defaults.shot_image_config_id || defaults.image_config_id || fallback
  return defaults.image_config_id || fallback
}

// POST /images — Generate image
app.post('/', async (c) => {
  const body = await c.req.json()
  if (!body.prompt) return badRequest(c, 'prompt is required')

  try {
    let configId: number | undefined = body.config_id
    if (body.storyboard_id) {
      const [sb] = db.select().from(schema.storyboards).where(eq(schema.storyboards.id, Number(body.storyboard_id))).all()
      if (sb) {
        const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, sb.episodeId)).all()
        if (ep?.imageConfigId != null) configId = ep.imageConfigId
      }
    }

    logTaskStart('ImageAPI', 'generate', {
      storyboardId: body.storyboard_id,
      sceneId: body.scene_id,
      characterId: body.character_id,
      dramaId: body.drama_id,
      frameType: body.frame_type,
    })
    logTaskPayload('ImageAPI', 'request body', body)
    const drama = getDramaForImageRequest(body)
    configId = imageConfigForRequest(drama, body, configId)
    const id = await generateImage({
      storyboardId: body.storyboard_id,
      dramaId: body.drama_id,
      sceneId: body.scene_id,
      characterId: body.character_id,
      prompt: body.prompt,
      model: body.model,
      size: body.size || orientationImageSize(dramaOrientation(drama)),
      referenceImages: body.reference_images,
      frameType: body.frame_type,
      configId,
    })

    const [record] = db.select().from(schema.imageGenerations)
      .where(eq(schema.imageGenerations.id, id)).all()
    logTaskSuccess('ImageAPI', 'generate', { generationId: id, provider: record?.provider })
    return created(c, record)
  } catch (err: any) {
    logTaskError('ImageAPI', 'generate', { error: err.message })
    return badRequest(c, err.message)
  }
})

// GET /images/:id
app.get('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const [row] = db.select().from(schema.imageGenerations)
    .where(eq(schema.imageGenerations.id, id)).all()
  return success(c, row || null)
})

// GET /images — List by storyboard_id or drama_id
app.get('/', async (c) => {
  const storyboardId = c.req.query('storyboard_id')
  const dramaId = c.req.query('drama_id')

  let rows = db.select().from(schema.imageGenerations).all()

  if (storyboardId) rows = rows.filter(r => r.storyboardId === Number(storyboardId))
  if (dramaId) rows = rows.filter(r => r.dramaId === Number(dramaId))

  return success(c, rows)
})

// DELETE /images/:id
app.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  db.delete(schema.imageGenerations).where(eq(schema.imageGenerations.id, id)).run()
  return success(c)
})

export default app
