import { db, schema } from '../db/index.js'
import { eq } from 'drizzle-orm'
import { getActiveConfig, getConfigById } from './ai.js'
import { now } from '../utils/response.js'
import { downloadFile, readImageAsCompressedDataUrl, saveBase64Image } from '../utils/storage.js'
import { getImageAdapter } from './adapters/registry'
import type { AIConfig } from './adapters/types'
import { configForComfyUITask, encodeComfyUITaskId, isComfyUIProvider, reserveComfyUIConfig, retainComfyUIEndpoint } from './adapters/comfyui-lb'
import { logTaskError, logTaskPayload, logTaskProgress, logTaskStart, logTaskSuccess, logTaskWarn, redactUrl } from '../utils/task-logger.js'
import { applyDramaStylePrompt } from './style-prompts.js'

const DEFAULT_IMAGE_TIMEOUT_MS = 30 * 60 * 1000
const MIN_IMAGE_TIMEOUT_MS = 60 * 1000
const MAX_IMAGE_TIMEOUT_MS = 2 * 60 * 60 * 1000

interface GenerateImageParams {
  storyboardId?: number
  dramaId?: number
  sceneId?: number
  characterId?: number
  prompt: string
  model?: string
  size?: string
  referenceImages?: string[]
  frameType?: string
  configId?: number
}

export async function generateImage(params: GenerateImageParams): Promise<number> {
  const ts = now()
  const config = params.configId
    ? getConfigById(params.configId)
    : getActiveConfig('image')
  if (!config) throw new Error('No active image AI config')

  const dramaId = resolveImageDramaId(params)
  const isSceneAsset = !!params.sceneId && !params.storyboardId && !params.characterId
  const isCharacterAsset = !!params.characterId && !params.storyboardId && !params.sceneId
  const sourcePrompt = isSceneAsset
    ? withEmptySceneConstraint(params.prompt)
    : isCharacterAsset
      ? withFullBodyCharacterConstraint(params.prompt)
      : params.prompt
  const styledPrompt = applyDramaStylePrompt(dramaId, sourcePrompt)
  const finalPrompt = isCharacterAsset
    ? prioritizeFullBodyCharacterConstraint(styledPrompt)
    : normalizeSceneStylePrompt(styledPrompt, isSceneAsset)

  const res = db.insert(schema.imageGenerations).values({
    storyboardId: params.storyboardId,
    dramaId,
    sceneId: params.sceneId,
    characterId: params.characterId,
    prompt: finalPrompt,
    model: params.model || config.model,
    provider: config.provider,
    size: params.size || '1920x1080',
    frameType: params.frameType,
    referenceImages: params.referenceImages ? JSON.stringify(params.referenceImages) : null,
    status: 'processing',
    createdAt: ts,
    updatedAt: ts,
  }).run()

  const lastId = Number(res.lastInsertRowid)
  logTaskStart('ImageTask', 'enqueue', {
    id: lastId,
    provider: config.provider,
    storyboardId: params.storyboardId,
    sceneId: params.sceneId,
    characterId: params.characterId,
    dramaId,
    frameType: params.frameType,
    model: params.model || config.model,
  })
  logTaskPayload('ImageTask', 'enqueue params', {
    id: lastId,
    config: {
      provider: config.provider,
      model: config.model,
      baseUrl: config.baseUrl,
    },
    params: { ...params, prompt: finalPrompt, originalPrompt: params.prompt },
  })
  processImageGeneration(lastId, config).catch(err => {
    logTaskError('ImageTask', 'process', { id: lastId, error: err.message })
    console.error(`Image generation ${lastId} failed:`, err)
  })
  return lastId
}


const EMPTY_SCENE_CONSTRAINT = '空场景环境参考图，只表现地点、空间结构、陈设、道具、光线、天气、时代背景和氛围；画面中禁止出现任何人物、路人、群众、角色、脸、身体、手、背影、剪影或人形轮廓；不要出现人物动作或剧情表演；无文字、无水印。'
const FULL_BODY_CHARACTER_CONSTRAINT = '单人全身角色立绘，完整人物从头顶到脚底全部进入画面，头发、脸、上半身、双手、腿、脚踝、鞋子都必须清楚可见；人物直立站姿，居中构图，镜头距离足够远，身体上下留有少量空白，不裁切头部、手臂、腿部、脚部或衣摆；服装必须完整展示到鞋子，禁止半身照、胸像、头像、近景、特写、坐姿、蹲姿、趴卧、被遮挡、多人、文字、标签、水印。'

function withEmptySceneConstraint(prompt: string) {
  const base = String(prompt || '').trim()
  if (!base) return EMPTY_SCENE_CONSTRAINT
  if (/空场景|无人物|没有人物|禁止出现任何人物/.test(base)) return base
  return `${base}。${EMPTY_SCENE_CONSTRAINT}`
}

function withFullBodyCharacterConstraint(prompt: string) {
  const base = String(prompt || '').trim()
  if (!base) return FULL_BODY_CHARACTER_CONSTRAINT
  if (/完整人物从头顶到脚底全部进入画面|脚踝、鞋子都必须清楚可见|禁止半身照/.test(base)) return base
  return `${FULL_BODY_CHARACTER_CONSTRAINT}。${base}`
}

function prioritizeFullBodyCharacterConstraint(prompt: string) {
  const base = String(prompt || '')
    .replace(FULL_BODY_CHARACTER_CONSTRAINT, '')
    .replace(/^[，,、；;。\s]+|[，,、；;。\s]+$/g, '')
    .trim()
  return base ? `${FULL_BODY_CHARACTER_CONSTRAINT}。${base}` : FULL_BODY_CHARACTER_CONSTRAINT
}

function normalizeSceneStylePrompt(prompt: string, isSceneAsset: boolean) {
  if (!isSceneAsset) return prompt
  return String(prompt || '')
    .replace(/二次元角色设计，?/g, '二次元环境美术风格，')
    .replace(/真实人物与真实环境/g, '真实环境')
    .replace(/人物和场景/g, '画面和场景')
    .replace(/人物表情朴素真实，?/g, '')
    .replace(/角色轮廓明确，?/g, '')
}

function resolveImageDramaId(params: GenerateImageParams): number | undefined {
  if (params.dramaId) return Number(params.dramaId)

  if (params.storyboardId) {
    const [row] = db.select({
      dramaId: schema.episodes.dramaId,
    })
      .from(schema.storyboards)
      .leftJoin(schema.episodes, eq(schema.episodes.id, schema.storyboards.episodeId))
      .where(eq(schema.storyboards.id, Number(params.storyboardId)))
      .all()
    if (row?.dramaId) return Number(row.dramaId)
  }

  if (params.sceneId) {
    const [scene] = db.select({ dramaId: schema.scenes.dramaId })
      .from(schema.scenes)
      .where(eq(schema.scenes.id, Number(params.sceneId)))
      .all()
    if (scene?.dramaId) return Number(scene.dramaId)
  }

  if (params.characterId) {
    const [character] = db.select({ dramaId: schema.characters.dramaId })
      .from(schema.characters)
      .where(eq(schema.characters.id, Number(params.characterId)))
      .all()
    if (character?.dramaId) return Number(character.dramaId)
  }

  return undefined
}

export function recoverProcessingImageGenerations() {
  const config = getActiveConfig('image')
  if (!config || !isComfyUIProvider(config.provider)) return

  const rows = db.select().from(schema.imageGenerations)
    .where(eq(schema.imageGenerations.status, 'processing'))
    .all()
    .filter(row => isComfyUIProvider(row.provider || '') && String(row.taskId || '').startsWith('huobao-comfyui:'))

  for (const row of rows) {
    const pollTarget = configForComfyUITask(config, row.taskId!)
    const release = retainComfyUIEndpoint(pollTarget.config.baseUrl)
    logTaskProgress('ImageTask', 'recover-poll', {
      id: row.id,
      taskId: row.taskId,
      provider: row.provider,
    })
    pollImageTask(row.id, config, row.taskId!, release).catch((err: any) => {
      logTaskError('ImageTask', 'recover-poll', { id: row.id, error: err.message })
    })
  }
}

async function processImageGeneration(id: number, config: AIConfig) {
  const adapter = getImageAdapter(config.provider)
  const reservation = isComfyUIProvider(config.provider)
    ? reserveComfyUIConfig(config)
    : { config, release: () => {} }
  const requestConfig = reservation.config

  try {
    const rows = db.select().from(schema.imageGenerations).where(eq(schema.imageGenerations.id, id)).all()
    const record = rows[0]
    if (!record) return
    logTaskProgress('ImageTask', 'build-request', {
      id,
      provider: config.provider,
      baseUrl: requestConfig.baseUrl,
      storyboardId: record.storyboardId,
      sceneId: record.sceneId,
      characterId: record.characterId,
      frameType: record.frameType,
    })

    // 使用 Adapter 构建请求
    const resolvedReferenceImages = await normalizeReferenceImages(record.referenceImages)
    const { url, method, headers, body, timeoutMs } = await adapter.buildGenerateRequest(requestConfig, {
      id: record.id,
      model: record.model,
      prompt: record.prompt,
      size: record.size,
      frameType: record.frameType,
      referenceImages: resolvedReferenceImages ? JSON.stringify(resolvedReferenceImages) : null,
    })
    logTaskProgress('ImageTask', 'request', {
      id,
      provider: config.provider,
      method,
      url: redactUrl(url),
      model: record.model,
    })
    logTaskPayload('ImageTask', 'request payload', {
      id,
      method,
      url,
      headers,
      body,
    })

    const resp = await fetch(url, {
      method,
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(resolveImageRequestTimeoutMs(requestConfig, timeoutMs)),
    })

    if (!resp.ok) throw new Error(`API error ${resp.status}: ${await resp.text()}`)
    const result = await resp.json() as any
    logTaskPayload('ImageTask', 'response payload', {
      id,
      provider: config.provider,
      result,
    })

    let { isAsync, taskId, imageUrl } = adapter.parseGenerateResponse(result)
    if (isAsync && taskId && isComfyUIProvider(config.provider)) {
      taskId = encodeComfyUITaskId(taskId, requestConfig.baseUrl)
    }

    if (!isAsync && imageUrl) {
      logTaskProgress('ImageTask', 'sync-complete', { id, imageUrl })
      // 同步模式：直接下载图片
      await handleImageComplete(id, config.provider, imageUrl)
      return
    }

    if (!isAsync && !imageUrl) {
      // 同步模式但无 URL（Gemini 等返回 base64）
      const b64 = adapter.extractImageBase64(result)
      if (b64) {
        logTaskProgress('ImageTask', 'sync-base64-complete', { id, mimeType: b64.mimeType })
        await handleImageCompleteBase64(id, config.provider, b64.data, b64.mimeType)
        return
      }
      throw new Error('No image URL or base64 data in response')
    }

    // 异步模式：更新 taskId，开始轮询
    db.update(schema.imageGenerations)
      .set({ taskId, status: 'processing', updatedAt: now() })
      .where(eq(schema.imageGenerations.id, id))
      .run()
    logTaskProgress('ImageTask', 'poll-start', { id, taskId, provider: config.provider })
    await pollImageTask(id, requestConfig, taskId!, reservation.release, resolveImageTimeoutMs(requestConfig))
  } catch (err: any) {
    logTaskError('ImageTask', 'process', { id, provider: config.provider, error: err.message })
    db.update(schema.imageGenerations)
      .set({ status: 'failed', errorMsg: err.message, updatedAt: now() })
      .where(eq(schema.imageGenerations.id, id))
      .run()
  } finally {
    reservation.release()
  }
}

async function normalizeReferenceImages(raw: string | null | undefined): Promise<string[]> {
  if (!raw) return []
  let refs: string[] = []
  try {
    refs = JSON.parse(raw)
  } catch {
    refs = []
  }

  const deduped = Array.from(
    new Set(
      refs
        .map((item) => String(item || '').trim())
        .filter(Boolean),
    ),
  )

  const normalized = await Promise.all(deduped.map(async (value) => {
    if (value.startsWith('data:image/')) return value
    if (value.startsWith('static/') || value.startsWith('/static/')) {
      const localPath = value.startsWith('/static/') ? value.slice(1) : value
      try {
        return await readImageAsCompressedDataUrl(localPath, {
          maxWidth: 768,
          maxHeight: 768,
          quality: 68,
        })
      } catch (err) {
        logTaskWarn('ImageTask', 'reference-read-failed', { path: localPath, error: (err as Error).message })
        return null
      }
    }
    return value
  }))

  return normalized.filter((item): item is string => !!item).slice(0, 6)
}

async function pollImageTask(id: number, config: AIConfig, taskId: string, release: () => void = () => {}, maxDurationMs = resolveImageTimeoutMs(config)) {
  const adapter = getImageAdapter(config.provider)
  const pollTarget = isComfyUIProvider(config.provider)
    ? configForComfyUITask(config, taskId)
    : { config, taskId }
  const startedAt = Date.now()
  const timeoutMinutes = Math.ceil(maxDurationMs / 60_000)
  let attempt = 0

  try {
    while (Date.now() - startedAt < maxDurationMs) {
      if (Date.now() - startedAt >= maxDurationMs) {
        logTaskError('ImageTask', 'poll-timeout', { id, taskId, error: `Polling exceeded ${timeoutMinutes} minutes` })
        db.update(schema.imageGenerations)
          .set({ status: 'failed', errorMsg: `Timeout: Polling exceeded ${timeoutMinutes} minutes`, updatedAt: now() })
          .where(eq(schema.imageGenerations.id, id))
          .run()
        return
      }
      await new Promise(r => setTimeout(r, 5000))
      attempt++

      try {
        const { url, method, headers } = adapter.buildPollRequest(pollTarget.config, pollTarget.taskId)
        logTaskProgress('ImageTask', 'poll-request', {
          id,
          taskId: pollTarget.taskId,
          provider: config.provider,
          method,
          url: redactUrl(url),
          attempt,
        })
        const remainingMs = Math.max(1_000, maxDurationMs - (Date.now() - startedAt))
        const resp = await fetch(url, {
          method,
          headers,
          signal: AbortSignal.timeout(remainingMs),
        })
        if (!resp.ok) continue
        const result = await resp.json() as any

        const pollResp = adapter.parsePollResponse(result, pollTarget.config, pollTarget.taskId)

        if (pollResp.status === 'completed' && pollResp.imageUrl) {
          logTaskSuccess('ImageTask', 'poll-complete', { id, taskId, imageUrl: pollResp.imageUrl })
          await handleImageComplete(id, config.provider, pollResp.imageUrl)
          return
        }
        if (pollResp.status === 'completed' && adapter.provider === 'gemini') {
          // Gemini 可能返回 base64
          const b64 = adapter.extractImageBase64(result)
          if (b64) {
            logTaskSuccess('ImageTask', 'poll-base64-complete', { id, taskId, mimeType: b64.mimeType })
            await handleImageCompleteBase64(id, config.provider, b64.data, b64.mimeType)
            return
          }
        }
        if (pollResp.status === 'failed') {
          logTaskError('ImageTask', 'poll-failed', { id, taskId, error: pollResp.error || 'Generation failed' })
          throw new Error(pollResp.error || 'Generation failed')
        }
      } catch (err: any) {
        if (Date.now() - startedAt >= maxDurationMs) {
          logTaskError('ImageTask', 'poll-timeout', { id, taskId, error: err.message })
          db.update(schema.imageGenerations)
            .set({ status: 'failed', errorMsg: `Timeout: ${err.message}`, updatedAt: now() })
            .where(eq(schema.imageGenerations.id, id))
            .run()
          return
        }
        logTaskWarn('ImageTask', 'poll-retry', { id, taskId: pollTarget.taskId, attempt, error: err.message })
      }
    }

    logTaskError('ImageTask', 'poll-timeout', { id, taskId, error: `Polling exceeded ${timeoutMinutes} minutes` })
    db.update(schema.imageGenerations)
      .set({ status: 'failed', errorMsg: `Timeout: Polling exceeded ${timeoutMinutes} minutes`, updatedAt: now() })
      .where(eq(schema.imageGenerations.id, id))
      .run()
  } finally {
    release()
  }
}

function resolveImageTimeoutMs(config: AIConfig) {
  const settings = config.settings || {}
  const raw = [
    settings.timeoutMs,
    settings.timeout_ms,
    settings.pollTimeoutMs,
    settings.poll_timeout_ms,
  ].find(value => value !== undefined && value !== null && String(value).trim() !== '')
  const secondsRaw = [
    settings.timeoutSeconds,
    settings.timeout_seconds,
    settings.pollTimeoutSeconds,
    settings.poll_timeout_seconds,
  ].find(value => value !== undefined && value !== null && String(value).trim() !== '')
  const value = raw !== undefined ? Number(raw) : secondsRaw !== undefined ? Number(secondsRaw) * 1000 : DEFAULT_IMAGE_TIMEOUT_MS
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_IMAGE_TIMEOUT_MS
  return Math.min(MAX_IMAGE_TIMEOUT_MS, Math.max(MIN_IMAGE_TIMEOUT_MS, Math.round(value)))
}

function resolveImageRequestTimeoutMs(config: AIConfig, requestTimeoutMs?: number) {
  if (Number.isFinite(requestTimeoutMs) && Number(requestTimeoutMs) > 0) {
    return Math.min(MAX_IMAGE_TIMEOUT_MS, Math.max(MIN_IMAGE_TIMEOUT_MS, Math.round(Number(requestTimeoutMs))))
  }
  return resolveImageTimeoutMs(config)
}

async function handleImageComplete(id: number, provider: string, imageUrl: string) {
  const localPath = await downloadFile(imageUrl, 'images')
  const rows = db.select().from(schema.imageGenerations).where(eq(schema.imageGenerations.id, id)).all()
  const record = rows[0]

  db.update(schema.imageGenerations)
    .set({ imageUrl, localPath, status: 'completed', updatedAt: now() })
    .where(eq(schema.imageGenerations.id, id))
    .run()
  logTaskSuccess('ImageTask', 'downloaded', { id, provider, localPath })

  // 更新关联表
  if (record?.storyboardId) {
    const sbUpdate: Record<string, any> = { updatedAt: now() }
    if (record.frameType === 'first_frame') sbUpdate.firstFrameImage = localPath
    else if (record.frameType === 'last_frame') sbUpdate.lastFrameImage = localPath
    else sbUpdate.composedImage = localPath
    db.update(schema.storyboards).set(sbUpdate).where(eq(schema.storyboards.id, record.storyboardId)).run()
  }
  if (record?.characterId) {
    db.update(schema.characters).set({ imageUrl: localPath, updatedAt: now() }).where(eq(schema.characters.id, record.characterId)).run()
  }
  if (record?.sceneId) {
    db.update(schema.scenes).set({ imageUrl: localPath, status: 'completed', updatedAt: now() }).where(eq(schema.scenes.id, record.sceneId)).run()
  }
}

async function handleImageCompleteBase64(id: number, provider: string, base64Data: string, mimeType: string) {
  const localPath = await saveBase64Image(base64Data, mimeType, 'images')
  const rows = db.select().from(schema.imageGenerations).where(eq(schema.imageGenerations.id, id)).all()
  const record = rows[0]

  db.update(schema.imageGenerations)
    .set({ localPath, status: 'completed', updatedAt: now() })
    .where(eq(schema.imageGenerations.id, id))
    .run()
  logTaskSuccess('ImageTask', 'saved-base64', { id, provider, mimeType, localPath })

  // 更新关联表
  if (record?.storyboardId) {
    const sbUpdate: Record<string, any> = { updatedAt: now() }
    if (record.frameType === 'first_frame') sbUpdate.firstFrameImage = localPath
    else if (record.frameType === 'last_frame') sbUpdate.lastFrameImage = localPath
    else sbUpdate.composedImage = localPath
    db.update(schema.storyboards).set(sbUpdate).where(eq(schema.storyboards.id, record.storyboardId)).run()
  }
  if (record?.characterId) {
    db.update(schema.characters).set({ imageUrl: localPath, updatedAt: now() }).where(eq(schema.characters.id, record.characterId)).run()
  }
  if (record?.sceneId) {
    db.update(schema.scenes).set({ imageUrl: localPath, status: 'completed', updatedAt: now() }).where(eq(schema.scenes.id, record.sceneId)).run()
  }
}
