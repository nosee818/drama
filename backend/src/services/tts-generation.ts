/**
 * TTS 语音合成服务
 * 支持 MiniMax TTS (hex 音频响应) 和 OpenAI 兼容 /audio/speech
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { v4 as uuid } from 'uuid'
import { getAudioConfigById, getAudioConfigForPurpose } from './ai.js'
import { getTTSAdapter } from './adapters/registry.js'
import { joinProviderUrl } from './adapters/url.js'
import { logTaskError, logTaskPayload, logTaskProgress, logTaskStart, logTaskSuccess, redactUrl } from '../utils/task-logger.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const STORAGE_ROOT = process.env.STORAGE_PATH || path.resolve(__dirname, '../../../data/static')
const DEFAULT_TTS_TIMEOUT_MS = 1_800_000

interface TTSParams {
  text: string
  voice: string
  purpose?: 'design' | 'clone'
  instruct?: string
  refText?: string
  referenceAudioUrl?: string | null
  model?: string
  speed?: number
  emotion?: string
  configId?: number | null
}

function isFormDataBody(value: any) {
  return typeof FormData !== 'undefined' && value instanceof FormData
}

async function executeProviderRequest(request: any) {
  const body = request.body == null
    ? undefined
    : isFormDataBody(request.body)
      ? request.body
      : JSON.stringify(request.body)
  return fetch(request.url, {
    method: request.method,
    headers: request.headers,
    body,
    signal: AbortSignal.timeout(Number(request.timeoutMs || DEFAULT_TTS_TIMEOUT_MS)),
  })
}

function bufferFromDataUrl(value: string) {
  const match = value.match(/^data:([^;]+);base64,(.+)$/)
  if (!match) return null
  const mimeType = match[1]
  const ext = mimeType.includes('wav') ? 'wav' : mimeType.includes('mpeg') || mimeType.includes('mp3') ? 'mp3' : 'bin'
  return { buffer: Buffer.from(match[2], 'base64'), format: ext }
}

function mimeFromAudioPath(value: string) {
  const clean = value.split('?')[0].toLowerCase()
  if (clean.endsWith('.wav')) return 'audio/wav'
  if (clean.endsWith('.flac')) return 'audio/flac'
  if (clean.endsWith('.m4a')) return 'audio/mp4'
  if (clean.endsWith('.ogg')) return 'audio/ogg'
  return 'audio/mpeg'
}

function localStaticPath(value?: string | null) {
  if (!value) return null
  const clean = value.replace(/^\/+/, '')
  if (!clean.startsWith('static/')) return null
  return path.join(STORAGE_ROOT, clean.replace(/^static\//, ''))
}

function audioPathToDataUrl(value?: string | null) {
  const localPath = localStaticPath(value)
  if (!localPath || !fs.existsSync(localPath)) return value || ''
  const mimeType = mimeFromAudioPath(localPath)
  const data = fs.readFileSync(localPath).toString('base64')
  return `data:${mimeType};base64,${data}`
}

function resolveAudioUrl(config: any, audioUrl: string) {
  if (/^https?:\/\//i.test(audioUrl) || audioUrl.startsWith('data:')) return audioUrl
  return joinProviderUrl(config.baseUrl, '', audioUrl)
}

async function downloadAudioUrl(config: any, audioUrl: string, fallbackFormat = 'mp3') {
  const data = bufferFromDataUrl(audioUrl)
  if (data) return data

  const resp = await fetch(resolveAudioUrl(config, audioUrl), { signal: AbortSignal.timeout(600_000) })
  if (!resp.ok) throw new Error(`Audio download failed ${resp.status}: ${await resp.text()}`)
  const contentType = resp.headers.get('content-type') || ''
  const filename = new URL(resolveAudioUrl(config, audioUrl)).searchParams.get('filename') || audioUrl
  const ext = filename.match(/\.([a-z0-9]+)(?:$|[?#])/i)?.[1]
  const format = contentType.includes('flac') ? 'flac'
    : contentType.includes('wav') ? 'wav'
      : contentType.includes('mpeg') || contentType.includes('mp3') ? 'mp3'
        : ext || fallbackFormat
  return { buffer: Buffer.from(await resp.arrayBuffer()), format }
}

async function pollTTSResult(adapter: any, config: any, taskId: string, timeoutMs: number) {
  const started = Date.now()
  const intervalMs = Number(config.settings?.pollIntervalMs || config.settings?.poll_interval_ms || 3000)
  while (Date.now() - started < timeoutMs) {
    await new Promise(resolve => setTimeout(resolve, intervalMs))
    const request = adapter.buildPollRequest(config, taskId)
    const resp = await executeProviderRequest({ ...request, timeoutMs: Math.min(120_000, timeoutMs) })
    if (!resp.ok) {
      throw new Error(`TTS poll failed ${resp.status}: ${await resp.text()}`)
    }
    const result = await resp.json()
    const parsed = adapter.parsePollResponse ? adapter.parsePollResponse(result) : adapter.parseResponse(result)
    if (parsed.status === 'failed') throw new Error(parsed.error || 'TTS generation failed')
    if (parsed.audioUrl || parsed.audioBase64 || parsed.audioHex) return parsed
  }
  throw new Error('TTS generation timeout')
}

/**
 * 生成 TTS 音频，返回本地文件路径
 */
export async function generateTTS(params: TTSParams): Promise<string> {
  const config = params.purpose ? getAudioConfigForPurpose(params.purpose, params.configId) : getAudioConfigById(params.configId)
  const adapter = getTTSAdapter(config.provider)
  const providerParams = {
    ...params,
    referenceAudioUrl: audioPathToDataUrl(params.referenceAudioUrl),
    audio: audioPathToDataUrl(params.referenceAudioUrl),
  }

  logTaskStart('AudioTask', 'tts-generate', {
    provider: config.provider,
    voice: params.voice,
    model: params.model || config.model,
    textPreview: params.text.slice(0, 50),
    textLength: params.text.length,
  })
  logTaskPayload('AudioTask', 'tts params', {
    config: {
      provider: config.provider,
      model: config.model,
      baseUrl: config.baseUrl,
    },
    params: providerParams,
  })

  const request = await adapter.buildGenerateRequest(config, providerParams)
  const { url, method, headers, body } = request
  logTaskProgress('AudioTask', 'request', {
    provider: config.provider,
    voice: params.voice,
    method,
    url: redactUrl(url),
    model: params.model || config.model,
  })
  logTaskPayload('AudioTask', 'request payload', {
    method,
    url,
    headers,
    body,
  })

  const resp = await executeProviderRequest(request)

  if (!resp.ok) {
    const errText = await resp.text()
    logTaskError('AudioTask', 'tts-generate', { provider: config.provider, voice: params.voice, status: resp.status, error: errText })
    throw new Error(`TTS API error ${resp.status}: ${errText}`)
  }

  let buffer: Buffer
  let format = request.fileExtension || 'mp3'
  let parsed: any = { audioLength: 0 }

  if (request.responseType === 'file') {
    buffer = Buffer.from(await resp.arrayBuffer())
  } else {
    const result = await resp.json()
    const comfyTask = (adapter as any).parseGenerateResponse?.(result)
    const pollTimeoutMs = Number(
      request.timeoutMs
      || config.settings?.pollTimeoutMs
      || config.settings?.poll_timeout_ms
      || config.settings?.timeoutMs
      || config.settings?.timeout_ms
      || DEFAULT_TTS_TIMEOUT_MS,
    )
    parsed = comfyTask?.taskId && (adapter as any).buildPollRequest
      ? await pollTTSResult(adapter, config, comfyTask.taskId, pollTimeoutMs)
      : (comfyTask?.audioUrl || comfyTask?.audioBase64 || comfyTask?.audioHex)
        ? comfyTask
        : adapter.parseResponse(result)

    if (parsed.audioUrl) {
      const downloaded = await downloadAudioUrl(config, parsed.audioUrl, parsed.format || format)
      buffer = downloaded.buffer
      format = downloaded.format
    } else if (parsed.audioBase64) {
      buffer = Buffer.from(parsed.audioBase64, 'base64')
      format = parsed.format || format
    } else {
      buffer = Buffer.from(parsed.audioHex, 'hex')
      format = parsed.format || format
    }
  }

  // 保存到本地
  const audioDir = path.join(STORAGE_ROOT, 'audio')
  fs.mkdirSync(audioDir, { recursive: true })
  const filename = `${uuid()}.${format}`
  const filePath = path.join(audioDir, filename)
  fs.writeFileSync(filePath, buffer)

  const relativePath = `static/audio/${filename}`
  logTaskSuccess('AudioTask', 'tts-saved', {
    provider: config.provider,
    voice: params.voice,
    path: relativePath,
    bytes: buffer.length,
    audioMs: parsed.audioLength,
  })
  return relativePath
}

/**
 * 为角色生成试听音频
 */
export async function generateVoiceSample(characterName: string, voiceId: string, configId?: number | null): Promise<string> {
  const sampleText = `我是${characterName}，这是我的声音。`
  return generateTTS({ text: sampleText, voice: voiceId, instruct: voiceId, purpose: 'design', configId })
}

export function voiceSampleText(characterName: string): string {
  return `我是${characterName}，这是我的声音。`
}
