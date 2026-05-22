import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { success, created, badRequest } from '../utils/response.js'
import { generateVideo } from '../services/video-generation.js'
import { logTaskError, logTaskPayload, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'
import { dramaOrientation, orientationAspectRatio, orientationVideoSize, parseSize } from '../utils/aspect.js'

const app = new Hono()

function getDramaForVideoRequest(body: any) {
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
  return null
}

function safeSettings(config: any) {
  const settings = config?.settings
  if (!settings) return {}
  if (typeof settings === 'object') return settings
  try { return JSON.parse(settings) || {} } catch { return {} }
}

function videoReferenceCapabilities(config: any) {
  const settings = safeSettings(config)
  const provider = String(config?.provider || '').toLowerCase()
  const capabilities = settings.referenceCapabilities || settings.capabilities || {}
  const maxReferenceImages = Number(
    settings.maxReferenceImages
    ?? settings.max_reference_images
    ?? capabilities.maxReferenceImages
    ?? capabilities.max_reference_images
    ?? 1,
  )
  const supportsFirstLast = Boolean(
    settings.supportsFirstLast
    ?? settings.supports_first_last
    ?? capabilities.firstLast
    ?? capabilities.supportsFirstLast
    ?? ['vidu', 'volcengine', 'minimax', 'seedance', 'jimeng'].includes(provider),
  )
  const supportsMultiple = Boolean(
    settings.supportsMultipleReferences
    ?? settings.supports_multiple_references
    ?? capabilities.multiple
    ?? capabilities.supportsMultipleReferences
    ?? maxReferenceImages > 1,
  )
  return {
    maxReferenceImages: Math.max(1, maxReferenceImages || 1),
    supportsFirstLast,
    supportsMultiple,
  }
}

function firstFiniteNumber(...values: any[]) {
  for (const value of values) {
    const num = Number(value)
    if (Number.isFinite(num) && num > 0) return num
  }
  return null
}

function configuredVideoSize(config: any, orientation: string) {
  const settings = safeSettings(config)
  const resolution = String(settings.videoResolution ?? settings.video_resolution ?? settings.resolution ?? '').toLowerCase()
  const preset = resolution === '720p' || resolution === '720'
    ? { width: 1280, height: 720 }
    : resolution === '1080p' || resolution === '1080'
      ? { width: 1920, height: 1080 }
      : null
  const width = firstFiniteNumber(preset?.width, settings.defaultWidth, settings.default_width, settings.videoWidth, settings.video_width, settings.width)
  const height = firstFiniteNumber(preset?.height, settings.defaultHeight, settings.default_height, settings.videoHeight, settings.video_height, settings.height)
  if (!width || !height) {
    if (String(config?.provider || '').toLowerCase().startsWith('comfyui')) {
      return orientation === 'landscape' ? '1920x1080' : '1080x1920'
    }
    return orientationVideoSize(orientation)
  }

  const wide = Math.max(width, height)
  const narrow = Math.min(width, height)
  return orientation === 'landscape' ? `${wide}x${narrow}` : `${narrow}x${wide}`
}

// POST /videos — Generate video
function configuredVideoFps(config: any) {
  const settings = safeSettings(config)
  return firstFiniteNumber(settings.fps, settings.defaultFps, settings.default_fps, settings.frameRate, settings.frame_rate)
}

app.post('/', async (c) => {
  const body = await c.req.json()
  if (!body.prompt) return badRequest(c, 'prompt is required')

  try {
    let configId: number | undefined = body.config_id
    const hasExplicitConfigId = body.config_id != null && body.config_id !== ''
    let config: any = null
    let storyboard: any = null
    if (body.storyboard_id) {
      const [sb] = db.select().from(schema.storyboards).where(eq(schema.storyboards.id, Number(body.storyboard_id))).all()
      storyboard = sb
      if (sb) {
        const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, sb.episodeId)).all()
        if (!hasExplicitConfigId && ep?.videoConfigId != null) configId = ep.videoConfigId
      }
    }
    if (configId) {
      ;[config] = db.select().from(schema.aiServiceConfigs).where(eq(schema.aiServiceConfigs.id, Number(configId))).all()
    }
    if (!config) {
      ;[config] = db.select().from(schema.aiServiceConfigs).all()
        .filter((item: any) => item.serviceType === 'video' && item.isActive !== false)
        .sort((a: any, b: any) => {
          if (!!a.isDefault !== !!b.isDefault) return a.isDefault ? -1 : 1
          return (Number(b.priority) || 0) - (Number(a.priority) || 0)
        })
    }
    const caps = videoReferenceCapabilities(config)
    let referenceMode = body.reference_mode
    let imageUrl = body.image_url
    let firstFrameUrl = body.first_frame_url
    let lastFrameUrl = body.last_frame_url
    let referenceImageUrls = Array.isArray(body.reference_image_urls) ? body.reference_image_urls.filter(Boolean) : undefined
    if (storyboard && !imageUrl && !firstFrameUrl && !referenceImageUrls?.length) {
      firstFrameUrl = storyboard.firstFrameImage || storyboard.composedImage || null
      if (firstFrameUrl) referenceMode = 'single'
    }
    if (referenceMode === 'first_last' && !caps.supportsFirstLast) {
      referenceMode = firstFrameUrl || imageUrl ? 'single' : (referenceImageUrls?.length ? 'single' : 'none')
      imageUrl = firstFrameUrl || imageUrl || referenceImageUrls?.[0]
      firstFrameUrl = undefined
      lastFrameUrl = undefined
      referenceImageUrls = undefined
    }
    if (referenceMode === 'multiple' && !caps.supportsMultiple) {
      referenceMode = referenceImageUrls?.[0] ? 'single' : 'none'
      imageUrl = referenceImageUrls?.[0] || imageUrl
      referenceImageUrls = undefined
    } else if (referenceMode === 'multiple' && referenceImageUrls?.length) {
      referenceImageUrls = referenceImageUrls.slice(0, caps.maxReferenceImages)
    }

    logTaskStart('VideoAPI', 'generate', {
      storyboardId: body.storyboard_id,
      dramaId: body.drama_id,
      referenceMode: body.reference_mode,
      duration: body.duration,
    })
    logTaskPayload('VideoAPI', 'request body', body)
    const drama = getDramaForVideoRequest(body)
    const orientation = dramaOrientation(drama)
    const size = parseSize(body.size || configuredVideoSize(config, orientation), '1280x720')
    const fps = firstFiniteNumber(body.fps, configuredVideoFps(config))
    const id = await generateVideo({
      storyboardId: body.storyboard_id,
      dramaId: body.drama_id,
      prompt: body.prompt,
      model: body.model,
      referenceMode,
      imageUrl,
      firstFrameUrl,
      lastFrameUrl,
      referenceImageUrls,
      duration: body.duration,
      aspectRatio: body.aspect_ratio || orientationAspectRatio(orientation),
      width: Number(body.width || size.width),
      height: Number(body.height || size.height),
      fps: fps || undefined,
      configId,
    })

    const [record] = db.select().from(schema.videoGenerations)
      .where(eq(schema.videoGenerations.id, id)).all()
    logTaskSuccess('VideoAPI', 'generate', { generationId: id, provider: record?.provider })
    return created(c, record)
  } catch (err: any) {
    logTaskError('VideoAPI', 'generate', { error: err.message })
    return badRequest(c, err.message)
  }
})

// GET /videos/:id
app.get('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const [row] = db.select().from(schema.videoGenerations)
    .where(eq(schema.videoGenerations.id, id)).all()
  return success(c, row || null)
})

// GET /videos — List by storyboard_id or drama_id
app.get('/', async (c) => {
  const storyboardId = c.req.query('storyboard_id')
  const dramaId = c.req.query('drama_id')

  let rows = db.select().from(schema.videoGenerations).all()

  if (storyboardId) rows = rows.filter(r => r.storyboardId === Number(storyboardId))
  if (dramaId) rows = rows.filter(r => r.dramaId === Number(dramaId))

  return success(c, rows)
})

// DELETE /videos/:id
app.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  db.delete(schema.videoGenerations).where(eq(schema.videoGenerations.id, id)).run()
  return success(c)
})

export default app
