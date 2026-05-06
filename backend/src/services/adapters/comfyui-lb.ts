import type { AIConfig } from './types'

const counters = new Map<string, number>()
const TASK_PREFIX = 'huobao-comfyui:'

export function isComfyUIProvider(provider: string) {
  return provider.toLowerCase().startsWith('comfyui')
}

export function getComfyUIBaseUrls(config: AIConfig) {
  return String(config.baseUrl || '')
    .split(/[\s,]+/)
    .map(item => item.trim())
    .filter(Boolean)
}

export function selectComfyUIConfig(config: AIConfig) {
  const urls = getComfyUIBaseUrls(config)
  if (urls.length <= 1) return { ...config, baseUrl: urls[0] || config.baseUrl }

  const key = [
    config.provider,
    config.endpoint || '',
    config.queryEndpoint || '',
    urls.join('|'),
  ].join('::')
  const next = counters.get(key) || 0
  counters.set(key, next + 1)
  return { ...config, baseUrl: urls[next % urls.length] }
}

export function encodeComfyUITaskId(taskId: string, baseUrl: string) {
  const payload = Buffer.from(JSON.stringify({ taskId, baseUrl }), 'utf-8').toString('base64url')
  return `${TASK_PREFIX}${payload}`
}

export function decodeComfyUITaskId(rawTaskId: string) {
  if (!rawTaskId.startsWith(TASK_PREFIX)) return { taskId: rawTaskId, baseUrl: '' }
  try {
    const parsed = JSON.parse(Buffer.from(rawTaskId.slice(TASK_PREFIX.length), 'base64url').toString('utf-8'))
    return {
      taskId: String(parsed.taskId || rawTaskId),
      baseUrl: String(parsed.baseUrl || ''),
    }
  } catch {
    return { taskId: rawTaskId, baseUrl: '' }
  }
}

export function configForComfyUITask(config: AIConfig, rawTaskId: string) {
  const decoded = decodeComfyUITaskId(rawTaskId)
  return {
    config: decoded.baseUrl ? { ...config, baseUrl: decoded.baseUrl } : config,
    taskId: decoded.taskId,
  }
}
