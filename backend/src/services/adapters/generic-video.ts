import type {
  AIConfig,
  ProviderRequest,
  VideoGenResponse,
  VideoGenerationRecord,
  VideoPollResponse,
  VideoProviderAdapter,
} from './types'
import { joinProviderUrl } from './url'

function pathFromTemplate(template: string, taskId: string) {
  return template.replace(/\{taskId\}/g, encodeURIComponent(taskId)).replace(/\{id\}/g, encodeURIComponent(taskId))
}

function pickString(...values: any[]) {
  return values.find((value) => typeof value === 'string' && value.trim()) || null
}

export class GenericVideoAdapter implements VideoProviderAdapter {
  provider = 'custom'

  buildGenerateRequest(config: AIConfig, record: VideoGenerationRecord): ProviderRequest {
    const settings = config.settings || {}
    const path = config.endpoint || settings.endpoint || settings.generatePath || '/v1/videos/generations'
    const template = settings.requestTemplate
    const fallbackBody = {
      model: record.model || config.model,
      prompt: record.prompt,
      image_url: record.imageUrl || undefined,
      first_frame_url: record.firstFrameUrl || undefined,
      last_frame_url: record.lastFrameUrl || undefined,
      reference_image_urls: record.referenceImageUrls ? JSON.parse(record.referenceImageUrls) : undefined,
      duration: record.duration || undefined,
      aspect_ratio: record.aspectRatio || undefined,
    }
    const body = template && typeof template === 'object'
      ? renderTemplateObject(template, fallbackBody)
      : fallbackBody

    return {
      url: joinProviderUrl(config.baseUrl, '', path),
      method: settings.method || 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(config.apiKey ? { Authorization: `${settings.authScheme || 'Bearer'} ${config.apiKey}` } : {}),
        ...(settings.headers && typeof settings.headers === 'object' ? settings.headers : {}),
      },
      body,
    }
  }

  parseGenerateResponse(result: any): VideoGenResponse {
    const videoUrl = pickString(result.video_url, result.videoUrl, result.url, result.data?.[0]?.url, result.output?.video_url)
    if (videoUrl) return { isAsync: false, videoUrl }
    const taskId = pickString(result.task_id, result.taskId, result.id, result.data?.id, result.output?.task_id)
    if (taskId) return { isAsync: true, taskId }
    throw new Error('No task id or video URL in response')
  }

  buildPollRequest(config: AIConfig, taskId: string): ProviderRequest {
    const settings = config.settings || {}
    const path = pathFromTemplate(config.queryEndpoint || settings.queryEndpoint || settings.pollPath || '/v1/videos/tasks/{taskId}', taskId)
    return {
      url: joinProviderUrl(config.baseUrl, '', path),
      method: settings.pollMethod || 'GET',
      headers: {
        ...(config.apiKey ? { Authorization: `${settings.authScheme || 'Bearer'} ${config.apiKey}` } : {}),
        ...(settings.headers && typeof settings.headers === 'object' ? settings.headers : {}),
      },
      body: undefined,
    }
  }

  parsePollResponse(result: any): VideoPollResponse {
    const status = String(result.status || result.state || result.data?.status || '').toLowerCase()
    const videoUrl = pickString(result.video_url, result.videoUrl, result.url, result.data?.video_url, result.data?.url, result.output?.video_url)
    if (videoUrl || ['succeeded', 'success', 'completed', 'done'].includes(status)) {
      return { status: 'completed', videoUrl }
    }
    if (['failed', 'error', 'cancelled', 'canceled'].includes(status)) {
      return { status: 'failed', error: result.error?.message || result.message || 'Video generation failed' }
    }
    return { status: 'processing' }
  }

  extractVideoUrl(result: any): string | null {
    return pickString(result.video_url, result.videoUrl, result.url, result.data?.video_url, result.data?.url, result.output?.video_url)
  }
}

function renderTemplateObject(template: any, values: Record<string, any>): any {
  if (Array.isArray(template)) return template.map((item) => renderTemplateObject(item, values))
  if (template && typeof template === 'object') {
    return Object.fromEntries(Object.entries(template).map(([key, value]) => [key, renderTemplateObject(value, values)]))
  }
  if (typeof template !== 'string') return template
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => values[key] == null ? '' : String(values[key]))
}
