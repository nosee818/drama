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

function dataUrlToBlob(value: string): { blob: Blob; filename: string } | null {
  const match = value.match(/^data:([^;]+);base64,(.+)$/)
  if (!match) return null
  const mimeType = match[1]
  const ext = mimeType.includes('png') ? 'png' : mimeType.includes('webp') ? 'webp' : 'jpg'
  const bytes = Uint8Array.from(Buffer.from(match[2], 'base64'))
  return {
    blob: new Blob([bytes], { type: mimeType }),
    filename: `input.${ext}`,
  }
}

function pickImageForMultipart(record: VideoGenerationRecord, settings: Record<string, any>) {
  const source = String(settings.imageSource || 'firstFrameUrl')
  if (source === 'imageUrl') return record.imageUrl
  if (source === 'lastFrameUrl') return record.lastFrameUrl
  if (source === 'firstFrameUrl') return record.firstFrameUrl || record.imageUrl
  return record.firstFrameUrl || record.imageUrl || record.lastFrameUrl
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

    if (settings.requestType === 'multipart') {
      const form = new FormData()
      const promptField = settings.promptField || 'prompt'
      const imageField = settings.imageField || 'image'
      const imageValue = pickImageForMultipart(record, settings)
      const imageBlob = imageValue ? dataUrlToBlob(imageValue) : null
      const multipartFields: Record<string, string> = {
        [promptField]: record.prompt || '',
      }

      form.append(promptField, record.prompt || '')
      if (imageBlob) {
        form.append(imageField, imageBlob.blob, settings.imageFilename || imageBlob.filename)
      } else if (imageValue && settings.allowImageUrlField) {
        form.append(imageField, imageValue)
      }

      const formFields = settings.formFields && typeof settings.formFields === 'object' ? settings.formFields : {}
      const renderedFields = renderTemplateObject(formFields, fallbackBody)
      for (const [key, value] of Object.entries(renderedFields)) {
        if (value == null || value === '') continue
        const renderedValue = String(value)
        form.append(key, renderedValue)
        multipartFields[key] = renderedValue
      }

      const responseType = settings.responseType === 'file' ? 'file' : 'json'
      return {
        url: joinProviderUrl(config.baseUrl, '', path),
        method: settings.method || 'POST',
        headers: {
          ...(config.apiKey ? { Authorization: `${settings.authScheme || 'Bearer'} ${config.apiKey}` } : {}),
          ...(settings.headers && typeof settings.headers === 'object' ? settings.headers : {}),
        },
        body: form,
        responseType,
        fileExtension: settings.fileExtension || 'mp4',
        timeoutMs: Number(settings.timeoutMs || settings.timeout_ms || (responseType === 'file' ? 1_800_000 : 600_000)),
        multipart: imageValue && imageValue.startsWith('data:image/')
          ? {
              fields: multipartFields,
              file: {
                fieldName: imageField,
                dataUrl: imageValue,
                filename: settings.imageFilename || imageBlob?.filename || 'input.jpg',
              },
            }
          : { fields: multipartFields },
      }
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
      responseType: settings.responseType === 'file' ? 'file' : 'json',
      fileExtension: settings.fileExtension || 'mp4',
      timeoutMs: Number(settings.timeoutMs || settings.timeout_ms || 600_000),
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
