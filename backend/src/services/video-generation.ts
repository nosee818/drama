import { db, schema } from '../db/index.js'
import { eq } from 'drizzle-orm'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { getActiveConfig, getConfigById } from './ai.js'
import { now } from '../utils/response.js'
import { downloadFile, readImageAsCompressedDataUrl, saveUploadedFile } from '../utils/storage.js'
import { getVideoAdapter } from './adapters/registry'
import { joinProviderUrl } from './adapters/url.js'
import type { AIConfig, ProviderRequest } from './adapters/types'
import { configForComfyUITask, encodeComfyUITaskId, isComfyUIProvider, selectComfyUIConfig } from './adapters/comfyui-lb'
import { logTaskError, logTaskPayload, logTaskProgress, logTaskStart, logTaskSuccess, logTaskWarn, redactUrl } from '../utils/task-logger.js'

const genericVideoCounters = new Map<string, number>()
const videoServerActiveUrls = new Map<string, Set<string>>()
const videoServerQueues = new Map<string, VideoServerQueueEntry[]>()
const execFileAsync = promisify(execFile)

interface VideoServerReservation {
  config: AIConfig
  key: string
  baseUrl: string
  release: () => void
}

interface VideoServerQueueEntry {
  config: AIConfig
  urls: string[]
  resolve: (reservation: VideoServerReservation) => void
}

interface GenerateVideoParams {
  storyboardId?: number
  dramaId?: number
  prompt: string
  model?: string
  referenceMode?: string
  imageUrl?: string
  firstFrameUrl?: string
  lastFrameUrl?: string
  referenceImageUrls?: string[]
  duration?: number
  aspectRatio?: string
  width?: number
  height?: number
  configId?: number
}

function videoReferenceCapabilities(config: AIConfig) {
  const settings = config.settings || {}
  const provider = String(config.provider || '').toLowerCase()
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

export async function generateVideo(params: GenerateVideoParams): Promise<number> {
  const ts = now()
  const config = params.configId
    ? getConfigById(params.configId)
    : getActiveConfig('video')
  if (!config) throw new Error('No active video AI config')
  const caps = videoReferenceCapabilities(config)
  let referenceMode = params.referenceMode || 'none'
  let imageUrl = params.imageUrl
  let firstFrameUrl = params.firstFrameUrl
  let lastFrameUrl = params.lastFrameUrl
  let referenceImageUrls = params.referenceImageUrls
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

  const res = db.insert(schema.videoGenerations).values({
    storyboardId: params.storyboardId,
    dramaId: params.dramaId,
    prompt: params.prompt,
    model: params.model || config.model,
    provider: config.provider,
    referenceMode,
    imageUrl,
    firstFrameUrl,
    lastFrameUrl,
    referenceImageUrls: referenceImageUrls ? JSON.stringify(referenceImageUrls) : null,
    duration: params.duration || 5,
    aspectRatio: params.aspectRatio || '16:9',
    width: params.width,
    height: params.height,
    status: 'pending',
    createdAt: ts,
    updatedAt: ts,
  }).run()

  const lastId = Number(res.lastInsertRowid)
  logTaskStart('VideoTask', 'enqueue', {
    id: lastId,
    provider: config.provider,
    storyboardId: params.storyboardId,
    dramaId: params.dramaId,
    referenceMode,
    duration: params.duration || 5,
  })
  logTaskPayload('VideoTask', 'enqueue params', {
    id: lastId,
    config: {
      provider: config.provider,
      model: config.model,
      baseUrl: config.baseUrl,
    },
    params,
  })
  processVideoGeneration(lastId, config).catch(err => {
    logTaskError('VideoTask', 'process', { id: lastId, error: err.message })
    console.error(`Video generation ${lastId} failed:`, err)
  })
  return lastId
}

async function processVideoGeneration(id: number, config: AIConfig) {
  const adapter = getVideoAdapter(config.provider)
  const reservation = await acquireVideoServerSlot(config)
  const requestConfig = reservation.config

  try {
    const rows = db.select().from(schema.videoGenerations).where(eq(schema.videoGenerations.id, id)).all()
    const record = rows[0]
    if (!record) return
    db.update(schema.videoGenerations)
      .set({ status: 'processing', updatedAt: now() })
      .where(eq(schema.videoGenerations.id, id))
      .run()
    logTaskProgress('VideoTask', 'build-request', {
      id,
      provider: config.provider,
      baseUrl: requestConfig.baseUrl,
      storyboardId: record.storyboardId,
      referenceMode: record.referenceMode,
    })

    let resolvedImageUrl = await normalizeVideoReferenceUrl(record.imageUrl)
    let resolvedFirstFrameUrl = await normalizeVideoReferenceUrl(record.firstFrameUrl)
    let resolvedLastFrameUrl = await normalizeVideoReferenceUrl(record.lastFrameUrl)
    let resolvedReferenceImageUrls = await normalizeVideoReferenceUrls(record.referenceImageUrls)

    if (isComfyUIProvider(config.provider)) {
      resolvedImageUrl = await uploadComfyUIImageIfNeeded(requestConfig, resolvedImageUrl)
      resolvedFirstFrameUrl = await uploadComfyUIImageIfNeeded(requestConfig, resolvedFirstFrameUrl)
      resolvedLastFrameUrl = await uploadComfyUIImageIfNeeded(requestConfig, resolvedLastFrameUrl)
      resolvedReferenceImageUrls = (await Promise.all(
        resolvedReferenceImageUrls.map((item) => uploadComfyUIImageIfNeeded(requestConfig, item)),
      )).filter((item): item is string => !!item)
    }

    // 使用 Adapter 构建请求
    const request = adapter.buildGenerateRequest(requestConfig, {
      id: record.id,
      model: record.model,
      prompt: record.prompt,
      referenceMode: record.referenceMode,
      imageUrl: resolvedImageUrl,
      firstFrameUrl: resolvedFirstFrameUrl,
      lastFrameUrl: resolvedLastFrameUrl,
      referenceImageUrls: resolvedReferenceImageUrls ? JSON.stringify(resolvedReferenceImageUrls) : null,
      duration: record.duration,
      aspectRatio: record.aspectRatio,
      width: record.width,
      height: record.height,
    })
    const { url, method, headers, body, responseType, fileExtension } = request
    logTaskProgress('VideoTask', 'request', {
      id,
      provider: config.provider,
      method,
      url: redactUrl(url),
      model: record.model,
      referenceMode: record.referenceMode,
    })
    logTaskPayload('VideoTask', 'request payload', {
      id,
      method,
      url,
      headers,
      body,
    })

    if (responseType === 'file' && request.multipart?.file) {
      const localPath = await postMultipartFileWithCurl(request)
      logTaskProgress('VideoTask', 'sync-file-complete', { id, localPath })
      await finalizeVideoComplete(id, localPath, record.duration, record.storyboardId, undefined)
      return
    }

    const isFormData = typeof FormData !== 'undefined' && body instanceof FormData
    const resp = await fetch(url, {
      method,
      headers,
      body: isFormData ? body : JSON.stringify(body),
      signal: AbortSignal.timeout(request.timeoutMs || (responseType === 'file' ? 1_800_000 : 600_000)),
    })

    if (!resp.ok) throw new Error(`API error ${resp.status}: ${await resp.text()}`)

    if (responseType === 'file') {
      const ext = String(fileExtension || 'mp4').replace(/^\./, '') || 'mp4'
      const localPath = await saveUploadedFile(await resp.arrayBuffer(), 'videos', `video.${ext}`)
      logTaskProgress('VideoTask', 'sync-file-complete', { id, localPath })
      await finalizeVideoComplete(id, localPath, record.duration, record.storyboardId, undefined)
      return
    }

    const result = await resp.json() as any

    let { isAsync, taskId, videoUrl } = adapter.parseGenerateResponse(result)
    if (isAsync && taskId && isComfyUIProvider(config.provider)) {
      taskId = encodeComfyUITaskId(taskId, requestConfig.baseUrl)
    }

    if (!isAsync && videoUrl) {
      logTaskProgress('VideoTask', 'sync-complete', { id, videoUrl })
      // 同步模式
      await handleVideoComplete(id, videoUrl, record.duration, record.storyboardId)
      return
    }

    // 异步模式：更新 taskId，开始轮询
    db.update(schema.videoGenerations)
      .set({ taskId, status: 'processing', updatedAt: now() })
      .where(eq(schema.videoGenerations.id, id))
      .run()
    logTaskProgress('VideoTask', 'poll-start', { id, taskId, provider: config.provider })

    // Vidu 没有轮询端点，跳过轮询（依赖 Webhook 回调）
    if (adapter.provider === 'vidu') {
      logTaskProgress('VideoTask', 'webhook-wait', { id, taskId, provider: adapter.provider })
      return
    }

    await pollVideoTask(id, requestConfig, taskId!, record.storyboardId)
  } catch (err: any) {
    logTaskError('VideoTask', 'process', { id, provider: config.provider, error: err.message })
    db.update(schema.videoGenerations)
      .set({ status: 'failed', errorMsg: err.message, updatedAt: now() })
      .where(eq(schema.videoGenerations.id, id))
      .run()
  } finally {
    reservation.release()
  }
}

function parseDataUrlBuffer(dataUrl: string): { buffer: Buffer; ext: string; mimeType: string } {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/)
  if (!match) throw new Error('Invalid multipart image data URL')
  const mimeType = match[1]
  const ext = mimeType.includes('png') ? 'png' : mimeType.includes('webp') ? 'webp' : 'jpg'
  return {
    buffer: Buffer.from(match[2], 'base64'),
    ext,
    mimeType,
  }
}

async function postMultipartFileWithCurl(request: ProviderRequest): Promise<string> {
  if (!request.multipart?.file) throw new Error('Multipart file is required')
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'veryai-video-'))
  const timeoutSeconds = Math.ceil((request.timeoutMs || 1_800_000) / 1000)
  try {
    const file = request.multipart.file
    const parsed = parseDataUrlBuffer(file.dataUrl)
    const inputPath = path.join(tempDir, file.filename || `input.${parsed.ext}`)
    const outputPath = path.join(tempDir, `output.${String(request.fileExtension || 'mp4').replace(/^\./, '')}`)
    fs.writeFileSync(inputPath, parsed.buffer)

    const args = [
      '-sS',
      '-L',
      '-X', request.method || 'POST',
      '--max-time', String(timeoutSeconds),
      '-o', outputPath,
      '-w', '%{http_code}',
    ]

    for (const [key, value] of Object.entries(request.headers || {})) {
      args.push('-H', `${key}: ${value}`)
    }
    args.push('-F', `${file.fieldName}=@${inputPath};filename=${file.filename || path.basename(inputPath)}`)
    for (const [key, value] of Object.entries(request.multipart.fields || {})) {
      args.push('-F', `${key}=${value}`)
    }
    args.push(request.url)

    const { stdout, stderr } = await execFileAsync('curl', args, {
      timeout: (request.timeoutMs || 1_800_000) + 30_000,
      maxBuffer: 1024 * 1024,
    })
    const status = Number(String(stdout || '').trim().slice(-3))
    if (!status || status < 200 || status >= 300) {
      const preview = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf-8').slice(0, 500) : ''
      throw new Error(`API error ${status || 'unknown'}: ${preview || stderr || 'curl request failed'}`)
    }

    const buffer = fs.readFileSync(outputPath)
    const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer
    return saveUploadedFile(arrayBuffer, 'videos', `video.${request.fileExtension || 'mp4'}`)
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}

function splitVideoBaseUrls(baseUrl: string) {
  return String(baseUrl || '')
    .split(/[\s,]+/)
    .map(item => item.trim())
    .filter(Boolean)
}

function selectVideoRequestConfig(config: AIConfig) {
  if (isComfyUIProvider(config.provider)) return selectComfyUIConfig(config)

  const urls = splitVideoBaseUrls(config.baseUrl)
  if (urls.length <= 1) return { ...config, baseUrl: urls[0] || config.baseUrl }

  const key = [
    config.provider,
    config.endpoint || '',
    config.queryEndpoint || '',
    urls.join('|'),
  ].join('::')
  const next = genericVideoCounters.get(key) || 0
  genericVideoCounters.set(key, next + 1)
  return { ...config, baseUrl: urls[next % urls.length] }
}

function getVideoServerQueueKey(config: AIConfig, urls: string[]) {
  return [
    config.provider,
    config.endpoint || '',
    config.queryEndpoint || '',
    urls.join('|'),
  ].join('::')
}

async function acquireVideoServerSlot(config: AIConfig): Promise<VideoServerReservation> {
  if (isComfyUIProvider(config.provider)) {
    const selected = selectComfyUIConfig(config)
    return {
      config: selected,
      key: 'comfyui',
      baseUrl: selected.baseUrl,
      release: () => {},
    }
  }

  const urls = splitVideoBaseUrls(config.baseUrl)
  const candidates = urls.length ? urls : [config.baseUrl]
  const key = getVideoServerQueueKey(config, candidates)

  const reserveNow = reserveVideoServerSlot(config, key, candidates)
  if (reserveNow) return reserveNow

  logTaskProgress('VideoTask', 'queued-wait-server', {
    provider: config.provider,
    endpoint: config.endpoint,
    servers: candidates.length,
    active: videoServerActiveUrls.get(key)?.size || 0,
    waiting: (videoServerQueues.get(key)?.length || 0) + 1,
  })

  return new Promise<VideoServerReservation>((resolve) => {
    const queue = videoServerQueues.get(key) || []
    queue.push({ config, urls: candidates, resolve })
    videoServerQueues.set(key, queue)
  })
}

function reserveVideoServerSlot(config: AIConfig, key: string, urls: string[]): VideoServerReservation | null {
  const active = videoServerActiveUrls.get(key) || new Set<string>()
  videoServerActiveUrls.set(key, active)

  const counter = genericVideoCounters.get(key) || 0
  for (let offset = 0; offset < urls.length; offset++) {
    const idx = (counter + offset) % urls.length
    const baseUrl = urls[idx]
    if (!active.has(baseUrl)) {
      active.add(baseUrl)
      genericVideoCounters.set(key, idx + 1)
      logTaskProgress('VideoTask', 'server-reserved', {
        provider: config.provider,
        endpoint: config.endpoint,
        baseUrl,
        active: active.size,
        capacity: urls.length,
      })
      return {
        config: { ...config, baseUrl },
        key,
        baseUrl,
        release: () => releaseVideoServerSlot(key, baseUrl, config, urls),
      }
    }
  }
  return null
}

function releaseVideoServerSlot(key: string, baseUrl: string, config: AIConfig, urls: string[]) {
  const active = videoServerActiveUrls.get(key)
  active?.delete(baseUrl)
  logTaskProgress('VideoTask', 'server-released', {
    provider: config.provider,
    endpoint: config.endpoint,
    baseUrl,
    active: active?.size || 0,
    capacity: urls.length,
  })

  const queue = videoServerQueues.get(key)
  if (!queue?.length) return
  const nextEntry = queue.shift()
  if (!nextEntry) return
  const next = reserveVideoServerSlot(nextEntry.config, key, nextEntry.urls)
  if (!next) return
  if (!queue.length) videoServerQueues.delete(key)
  nextEntry.resolve(next)
}

async function normalizeVideoReferenceUrl(value: string | null | undefined): Promise<string | null> {
  const raw = String(value || '').trim()
  if (!raw) return null
  if (raw.startsWith('data:image/')) return raw
  if (raw.startsWith('static/') || raw.startsWith('/static/')) {
    const localPath = raw.startsWith('/static/') ? raw.slice(1) : raw
    try {
      return await readImageAsCompressedDataUrl(localPath, {
        maxWidth: 768,
        maxHeight: 768,
        quality: 68,
      })
    } catch (err) {
      logTaskWarn('VideoTask', 'reference-read-failed', { path: localPath, error: (err as Error).message })
      return null
    }
  }
  return raw
}

async function normalizeVideoReferenceUrls(raw: string | null | undefined): Promise<string[]> {
  if (!raw) return []
  let refs: string[] = []
  try {
    refs = JSON.parse(raw)
  } catch {
    refs = []
  }
  const normalized = await Promise.all(
    Array.from(new Set(refs.map((item) => String(item || '').trim()).filter(Boolean))).map((item) => normalizeVideoReferenceUrl(item)),
  )
  return normalized.filter((item): item is string => !!item)
}

async function uploadComfyUIImageIfNeeded(config: AIConfig, value: string | null): Promise<string | null> {
  if (!value) return null
  if (!value.startsWith('data:image/')) return value

  const match = value.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/)
  if (!match) return value

  const mimeType = match[1]
  const ext = mimeType.includes('png') ? 'png' : mimeType.includes('webp') ? 'webp' : 'jpg'
  const bytes = Uint8Array.from(Buffer.from(match[2], 'base64'))
  const blob = new Blob([bytes], { type: mimeType })
  const filename = `huobao-${Date.now()}-${Math.random().toString(16).slice(2)}.${ext}`
  const form = new FormData()
  form.append('image', blob, filename)
  form.append('overwrite', 'true')
  form.append('type', 'input')

  const uploadUrl = joinProviderUrl(config.baseUrl, '', '/upload/image')
  logTaskProgress('VideoTask', 'comfyui-upload-image', {
    url: redactUrl(uploadUrl),
    filename,
    mimeType,
  })
  const resp = await fetch(uploadUrl, {
    method: 'POST',
    headers: config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : undefined,
    body: form,
    signal: AbortSignal.timeout(120_000),
  })

  if (!resp.ok) throw new Error(`ComfyUI image upload failed ${resp.status}: ${await resp.text()}`)
  const result = await resp.json() as any
  return result.name || result.filename || filename
}

async function pollVideoTask(id: number, config: AIConfig, taskId: string, storyboardId?: number | null) {
  const adapter = getVideoAdapter(config.provider)
  const pollTarget = isComfyUIProvider(config.provider)
    ? configForComfyUITask(config, taskId)
    : { config, taskId }

  for (let i = 0; i < 300; i++) {
    await new Promise(r => setTimeout(r, 10000))
    try {
      const { url, method, headers } = adapter.buildPollRequest(pollTarget.config, pollTarget.taskId)
      logTaskProgress('VideoTask', 'poll-request', {
        id,
        taskId: pollTarget.taskId,
        provider: config.provider,
        method,
        url: redactUrl(url),
        attempt: i + 1,
      })
      const resp = await fetch(url, { method, headers })
      if (!resp.ok) continue
      const result = await resp.json() as any

      const pollResp = adapter.parsePollResponse(result)

      if (pollResp.status === 'completed' && pollResp.videoUrl) {
        logTaskSuccess('VideoTask', 'poll-complete', { id, taskId, videoUrl: pollResp.videoUrl })
        await handleVideoComplete(id, pollResp.videoUrl, null, storyboardId)
        return
      }
      if (pollResp.status === 'failed') {
        logTaskError('VideoTask', 'poll-failed', { id, taskId, error: pollResp.error || 'Video generation failed' })
        throw new Error(pollResp.error || 'Video generation failed')
      }
    } catch (err: any) {
      if (i === 299) {
        logTaskError('VideoTask', 'poll-timeout', { id, taskId, error: err.message })
        db.update(schema.videoGenerations)
          .set({ status: 'failed', errorMsg: `Timeout: ${err.message}`, updatedAt: now() })
          .where(eq(schema.videoGenerations.id, id))
          .run()
        return
      }
      logTaskWarn('VideoTask', 'poll-retry', { id, taskId: pollTarget.taskId, attempt: i + 1, error: err.message })
    }
  }
}

async function handleVideoComplete(id: number, videoUrl: string, duration: number | null | undefined, storyboardId?: number | null) {
  const localPath = await downloadFile(videoUrl, 'videos')
  await finalizeVideoComplete(id, localPath, duration, storyboardId, videoUrl)
}

async function finalizeVideoComplete(id: number, localPath: string, duration: number | null | undefined, storyboardId?: number | null, videoUrl?: string) {
  db.update(schema.videoGenerations)
    .set({ videoUrl, localPath, status: 'completed', completedAt: now(), updatedAt: now() })
    .where(eq(schema.videoGenerations.id, id))
    .run()
  logTaskSuccess('VideoTask', 'downloaded', { id, localPath, storyboardId, duration })

  if (storyboardId) {
    db.update(schema.storyboards)
      .set({ videoUrl: localPath, duration: duration || undefined, updatedAt: now() })
      .where(eq(schema.storyboards.id, storyboardId))
      .run()
  }
}
