import type { AIConfig } from './types'

interface ComfyUIEndpointState {
  active: number
  selected: number
}

export interface ComfyUIReservation {
  config: AIConfig
  baseUrl: string
  release: () => void
}

const endpointStates = new Map<string, ComfyUIEndpointState>()
const poolCursors = new Map<string, number>()
const TASK_PREFIX = 'huobao-comfyui:'

export function isComfyUIProvider(provider: string) {
  return provider.toLowerCase().startsWith('comfyui')
}

export function getComfyUIBaseUrls(config: AIConfig) {
  const seen = new Set<string>()
  return String(config.baseUrl || '')
    .split(/[\s,]+/)
    .map(item => normalizeBaseUrl(item))
    .filter(Boolean)
    .filter((item) => {
      if (seen.has(item)) return false
      seen.add(item)
      return true
    })
}

export function selectComfyUIConfig(config: AIConfig) {
  const reservation = reserveComfyUIConfig(config)
  reservation.release()
  return reservation.config
}

export function reserveComfyUIConfig(config: AIConfig): ComfyUIReservation {
  const urls = getComfyUIBaseUrls(config)
  const candidates = urls.length ? urls : [normalizeBaseUrl(config.baseUrl)]
  const poolKey = getComfyUIPoolKey(config)
  const cursor = poolCursors.get(poolKey) || 0
  const start = cursor % candidates.length
  const ordered = [...candidates.slice(start), ...candidates.slice(0, start)]
  const selected = ordered.reduce((best, candidate) => {
    const bestState = getEndpointState(best)
    const candidateState = getEndpointState(candidate)
    if (candidateState.active !== bestState.active) {
      return candidateState.active < bestState.active ? candidate : best
    }
    if (candidateState.selected !== bestState.selected) {
      return candidateState.selected < bestState.selected ? candidate : best
    }
    return best
  }, ordered[0])

  const selectedIndex = candidates.indexOf(selected)
  poolCursors.set(poolKey, selectedIndex >= 0 ? selectedIndex + 1 : cursor + 1)
  retainComfyUIEndpoint(selected)
  let released = false

  return {
    config: { ...config, baseUrl: selected },
    baseUrl: selected,
    release: () => {
      if (released) return
      released = true
      releaseComfyUIEndpoint(selected)
    },
  }
}

export function retainComfyUIEndpoint(baseUrl: string) {
  const normalized = normalizeBaseUrl(baseUrl)
  if (!normalized) return () => {}
  const state = getEndpointState(normalized)
  state.active += 1
  state.selected += 1
  let released = false
  return () => {
    if (released) return
    released = true
    releaseComfyUIEndpoint(normalized)
  }
}

function releaseComfyUIEndpoint(baseUrl: string) {
  const normalized = normalizeBaseUrl(baseUrl)
  if (!normalized) return
  const state = getEndpointState(normalized)
  state.active = Math.max(0, state.active - 1)
}

function getEndpointState(baseUrl: string) {
  const normalized = normalizeBaseUrl(baseUrl)
  const current = endpointStates.get(normalized)
  if (current) return current
  const created = { active: 0, selected: 0 }
  endpointStates.set(normalized, created)
  return created
}

function getComfyUIPoolKey(config: AIConfig) {
  const settings = config.settings || {}
  return String(
    settings.comfyuiPool
    || settings.comfyui_pool
    || settings.poolKey
    || settings.pool_key
    || 'global',
  )
}

function normalizeBaseUrl(value: string | null | undefined) {
  return String(value || '').trim().replace(/\/+$/, '')
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
