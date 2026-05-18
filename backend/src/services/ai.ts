/**
 * AI 服务抽象层 — 从数据库配置中获取 provider 和 API key
 */
import { db, schema } from '../db/index.js'
import { eq } from 'drizzle-orm'
import { logTaskProgress, logTaskWarn } from '../utils/task-logger.js'
import { joinProviderUrl } from './adapters/url.js'

export type ServiceType = 'text' | 'image' | 'video' | 'audio'

export interface AIConfig {
  id?: number
  name?: string
  provider: string
  baseUrl: string
  apiKey: string
  model: string
  endpoint?: string
  queryEndpoint?: string
  settings?: Record<string, any>
}

const textConfigRoundRobinCursor = new Map<string, number>()
const audioConfigRoundRobinCursor = new Map<string, number>()
type AudioPurpose = 'design' | 'clone'

export function getTextProviderBaseUrl(config: AIConfig) {
  const provider = config.provider.toLowerCase()

  if (config.endpoint) {
    return joinProviderUrl(config.baseUrl, '', config.endpoint)
  }

  if (provider === 'openai' || provider === 'openrouter' || provider === 'chatfire' || provider === 'custom') {
    return joinProviderUrl(config.baseUrl, '/v1', '')
  }

  if (provider === 'volcengine') {
    return joinProviderUrl(config.baseUrl, '/api/v3', '')
  }

  if (provider === 'ali') {
    return joinProviderUrl(config.baseUrl, '/api/v1', '')
  }

  return config.baseUrl
}

function parseSettings(value: string | null | undefined): Record<string, any> {
  if (!value) return {}
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function splitBaseUrls(value: string | null | undefined) {
  return String(value || '')
    .split(/[\n,]+/)
    .map(item => item.trim())
    .filter(Boolean)
}

function rowToConfig(row: any, baseUrl?: string, nameSuffix = ''): AIConfig {
  const models = row.model ? JSON.parse(row.model) : []
  return {
    id: row.id,
    name: `${row.name || ''}${nameSuffix}`,
    provider: row.provider || '',
    baseUrl: baseUrl || row.baseUrl || '',
    apiKey: row.apiKey,
    model: models[0] || '',
    endpoint: row.endpoint || undefined,
    queryEndpoint: row.queryEndpoint || undefined,
    settings: parseSettings(row.settings),
  }
}

function rowToTextConfigs(row: any): AIConfig[] {
  const urls = splitBaseUrls(row.baseUrl)
  if (urls.length <= 1) return [rowToConfig(row)]
  return urls.map((url, index) => {
    const config = rowToConfig(row, url, ` #${index + 1}`)
    config.settings = {
      ...(config.settings || {}),
      baseUrlIndex: index,
      base_url_index: index,
    }
    return config
  })
}

function rotateConfigs(configs: AIConfig[], key: string) {
  if (configs.length <= 1) return configs
  const cursor = textConfigRoundRobinCursor.get(key) || 0
  textConfigRoundRobinCursor.set(key, (cursor + 1) % configs.length)
  const offset = cursor % configs.length
  return [...configs.slice(offset), ...configs.slice(0, offset)]
}

function rowToTextConfig(row: any): AIConfig {
  return rotateConfigs(rowToTextConfigs(row), `text-row:${row.id}`)[0]
}

function rowToAudioConfig(row: any, purpose = 'audio'): AIConfig {
  const urls = splitBaseUrls(row.baseUrl)
  if (urls.length <= 1) return rowToConfig(row)

  const key = `${row.id}:${purpose}`
  const cursor = audioConfigRoundRobinCursor.get(key) || 0
  audioConfigRoundRobinCursor.set(key, (cursor + 1) % urls.length)
  const index = cursor % urls.length
  const config = rowToConfig(row, urls[index], ` #${index + 1}`)
  config.settings = {
    ...(config.settings || {}),
    baseUrlIndex: index,
    base_url_index: index,
  }
  return config
}

function activeConfigRows(serviceType: ServiceType) {
  return db.select().from(schema.aiServiceConfigs)
    .where(eq(schema.aiServiceConfigs.serviceType, serviceType))
    .all()
    .filter(r => r.isActive)
    .sort((a, b) => {
      if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1
      return (b.priority || 0) - (a.priority || 0)
    })
}

export function getActiveConfig(serviceType: ServiceType): AIConfig | null {
  const rows = activeConfigRows(serviceType)

  const active = rows[0]
  if (!active) {
    logTaskWarn('AIConfig', 'active-config-missing', { serviceType })
    return null
  }

  const config = serviceType === 'audio'
    ? rowToAudioConfig(active)
    : serviceType === 'text'
      ? rowToTextConfig(active)
      : rowToConfig(active)
  logTaskProgress('AIConfig', 'active-config-selected', {
    serviceType,
    configId: active.id,
    provider: active.provider,
    model: config.model,
    priority: active.priority,
    isDefault: active.isDefault,
  })
  return config
}

export function getActiveConfigs(serviceType: ServiceType): AIConfig[] {
  const rows = activeConfigRows(serviceType)
  if (serviceType === 'text') return rows.flatMap(rowToTextConfigs)
  return rows.map(row => rowToConfig(row))
}

export function getTextConfigCandidates(preferredId?: number | null): AIConfig[] {
  const configs = getActiveConfigs('text')
  if (!configs.length) {
    logTaskWarn('AIConfig', 'text-config-candidates-missing', {})
    return []
  }

  if (preferredId) {
    const preferred = configs.filter(config => config.id === preferredId)
    if (preferred.length) {
      return rotateConfigs(preferred, `text-preferred:${preferredId}`)
    }
    return rotateConfigs(configs, 'text-all')
  }

  return rotateConfigs(configs, 'text-all')
}

export function getTextConfig(): AIConfig {
  const config = getActiveConfig('text')
  if (!config) throw new Error('No active text AI config')
  return config
}

export function getAudioConfig(): AIConfig {
  const config = getActiveConfig('audio')
  if (!config) throw new Error('No active audio AI config — 请在设置中添加音频服务')
  return config
}

export function getAudioConfigById(id?: number | null): AIConfig {
  if (id) {
    const config = getConfigById(id)
    if (config) return config
  }
  return getAudioConfig()
}

function audioPurposeOf(row: any): AudioPurpose | null {
  const settings = parseSettings(row.settings)
  const value = String(settings.purpose || settings.audioPurpose || settings.ttsPurpose || row.name || '').toLowerCase()
  if (value.includes('design')) return 'design'
  if (value.includes('clone')) return 'clone'
  return null
}

export function getAudioConfigForPurpose(purpose: AudioPurpose, preferredId?: number | null): AIConfig {
  const rows = activeConfigRows('audio')
  if (!rows.length) throw new Error('No active audio AI config — 请在设置中添加音频服务')

  const preferredRow = preferredId ? rows.find(row => row.id === preferredId) : null
  if (preferredRow && audioPurposeOf(preferredRow) === purpose) return rowToAudioConfig(preferredRow, purpose)

  const matched = rows.find(row => audioPurposeOf(row) === purpose)
  if (matched) return rowToAudioConfig(matched, purpose)

  if (preferredRow) return rowToAudioConfig(preferredRow, purpose)
  return rowToAudioConfig(rows[0], purpose)
}

export function getConfigById(id: number): AIConfig | null {
  const [row] = db.select().from(schema.aiServiceConfigs)
    .where(eq(schema.aiServiceConfigs.id, id)).all()
  if (!row || !row.isActive) {
    logTaskWarn('AIConfig', 'config-by-id-missing', { configId: id })
    return null
  }
  const config = row.serviceType === 'audio'
    ? rowToAudioConfig(row)
    : row.serviceType === 'text'
      ? rowToTextConfig(row)
      : rowToConfig(row)
  logTaskProgress('AIConfig', 'config-by-id-selected', {
    configId: id,
    provider: row.provider,
    model: config.model,
    serviceType: row.serviceType,
  })
  return config
}
