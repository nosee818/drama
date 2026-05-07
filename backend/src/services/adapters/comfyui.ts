import type {
  AIConfig,
  ImageGenResponse,
  ImageGenerationRecord,
  ImagePollResponse,
  ImageProviderAdapter,
  ProviderRequest,
  VideoGenResponse,
  VideoGenerationRecord,
  VideoPollResponse,
  VideoProviderAdapter,
} from './types'
import { joinProviderUrl } from './url'

function parseWorkflow(settings: Record<string, any>) {
  const workflow = settings.workflow || settings.workflowApi || settings.prompt
  if (!workflow && Object.keys(settings).length > 0) return settings
  if (!workflow) throw new Error('ComfyUI workflow JSON is required. Paste the workflow directly, or wrap it as settings.workflow')
  return typeof workflow === 'string' ? JSON.parse(workflow) : workflow
}

function parseSize(size?: string | null) {
  const match = String(size || '').match(/(\d+)\s*x\s*(\d+)/i)
  return { width: Number(match?.[1] || 1024), height: Number(match?.[2] || 1024) }
}

function renderWorkflow(workflow: any, values: Record<string, any>): any {
  if (Array.isArray(workflow)) return workflow.map((item) => renderWorkflow(item, values))
  if (workflow && typeof workflow === 'object') {
    return Object.fromEntries(Object.entries(workflow).map(([key, value]) => [key, renderWorkflow(value, values)]))
  }
  if (typeof workflow !== 'string') return workflow
  const exactMatch = workflow.match(/^\{\{(\w+)\}\}$/)
  if (exactMatch) return Object.prototype.hasOwnProperty.call(values, exactMatch[1]) ? values[exactMatch[1]] : ''
  return workflow.replace(/\{\{(\w+)\}\}/g, (_, key) => values[key] == null ? '' : String(values[key]))
}

function isBlankImageName(value: any) {
  return typeof value === 'string' && !value.trim()
}

function isNodeLink(value: any, removedIds: Set<string>) {
  return Array.isArray(value)
    && value.length >= 2
    && typeof value[0] === 'string'
    && removedIds.has(value[0])
    && typeof value[1] === 'number'
}

function pruneUnavailableLoadImageNodes(workflow: any) {
  if (!workflow || typeof workflow !== 'object' || Array.isArray(workflow)) return workflow

  const removedIds = new Set<string>()
  for (const [id, node] of Object.entries(workflow) as any[]) {
    if (node?.class_type === 'LoadImage' && isBlankImageName(node?.inputs?.image)) {
      removedIds.add(String(id))
    }
  }
  if (!removedIds.size) return workflow

  for (const id of removedIds) delete workflow[id]

  for (const node of Object.values(workflow) as any[]) {
    if (!node?.inputs || typeof node.inputs !== 'object') continue
    for (const [inputName, inputValue] of Object.entries(node.inputs)) {
      if (isNodeLink(inputValue, removedIds)) {
        delete node.inputs[inputName]
      }
    }
  }
  return workflow
}

function headers(config: AIConfig) {
  return {
    'Content-Type': 'application/json',
    ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
  }
}

function fileUrl(config: AIConfig, file: any) {
  const url = new URL(joinProviderUrl(config.baseUrl, '', '/view'))
  url.searchParams.set('filename', file.filename)
  if (file.subfolder) url.searchParams.set('subfolder', file.subfolder)
  url.searchParams.set('type', file.type || 'output')
  return url.toString()
}

function isOutputFile(value: any) {
  return value && typeof value === 'object' && typeof value.filename === 'string'
}

function findOutputFile(result: any, serviceType: 'image' | 'video', config?: AIConfig) {
  const historyEntry = Object.values(result || {}).find((entry: any) => entry?.outputs) as any
  const outputs = result?.outputs || historyEntry?.outputs || {}
  const preferred = serviceType === 'image'
    ? ['images']
    : ['videos', 'gifs', 'images']
  for (const output of Object.values(outputs) as any[]) {
    for (const key of preferred) {
      const files = output?.[key]
      if (Array.isArray(files)) {
        const file = files.find(isOutputFile)
        if (file) return config ? fileUrl(config, file) : file
      }
    }
  }
  return null
}

class ComfyUIBase {
  readonly provider = 'comfyui'
  protected currentConfig: AIConfig | null = null

  protected buildPromptRequest(config: AIConfig, values: Record<string, any>): ProviderRequest {
    this.currentConfig = config
    const settings = config.settings || {}
    const workflow = pruneUnavailableLoadImageNodes(renderWorkflow(parseWorkflow(settings), values))
    return {
      url: joinProviderUrl(config.baseUrl, '', config.endpoint || settings.endpoint || '/prompt'),
      method: 'POST',
      headers: headers(config),
      body: {
        prompt: workflow,
        client_id: settings.clientId || `huobao-${Date.now()}`,
      },
    }
  }

  protected parsePromptResponse(result: any): { isAsync: boolean; taskId?: string } {
    const taskId = result.prompt_id || result.promptId || result.id
    if (!taskId) throw new Error('No ComfyUI prompt_id in response')
    return { isAsync: true, taskId }
  }

  protected buildHistoryRequest(config: AIConfig, taskId: string): ProviderRequest {
    this.currentConfig = config
    return {
      url: joinProviderUrl(config.baseUrl, '', (config.queryEndpoint || config.settings?.queryEndpoint || '/history/{taskId}').replace(/\{taskId\}/g, encodeURIComponent(taskId))),
      method: 'GET',
      headers: config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {},
      body: undefined,
    }
  }
}

export class ComfyUIImageAdapter extends ComfyUIBase implements ImageProviderAdapter {
  async buildGenerateRequest(config: AIConfig, record: ImageGenerationRecord): Promise<ProviderRequest> {
    const { width, height } = parseSize(record.size)
    const referenceImages = (await Promise.all(
      parseReferenceImages(record.referenceImages).slice(0, 3).map((item) => uploadComfyUIImageIfNeeded(config, item)),
    )).filter((item): item is string => !!item)
    const settings = config.settings || {}
    const linkIds = settings.referenceImageLinks || settings.imageLinks || {}
    const refLink = (name: string, index: number) => referenceImages[index]
      ? (linkIds[name] ?? linkIds[String(index + 1)] ?? null)
      : null
    return this.buildPromptRequest(config, {
      prompt: record.prompt || '',
      negative_prompt: '',
      model: record.model || config.model,
      width,
      height,
      seed: Math.floor(Math.random() * 2147483647),
      input_image: referenceImages[0] || '',
      input_images: referenceImages,
      image1: referenceImages[0] || '',
      image2: referenceImages[1] || '',
      image3: referenceImages[2] || '',
      image1_link: refLink('image1', 0),
      image2_link: refLink('image2', 1),
      image3_link: refLink('image3', 2),
      reference_count: referenceImages.length,
      has_image1: !!referenceImages[0],
      has_image2: !!referenceImages[1],
      has_image3: !!referenceImages[2],
    })
  }

  parseGenerateResponse(result: any): ImageGenResponse {
    return this.parsePromptResponse(result)
  }

  buildPollRequest(config: AIConfig, taskId: string): ProviderRequest {
    return this.buildHistoryRequest(config, taskId)
  }

  parsePollResponse(result: any): ImagePollResponse {
    const url = findOutputFile(result, 'image', this.currentConfig || undefined) as string | null
    if (url) return { status: 'completed', imageUrl: url }
    return { status: 'processing' }
  }

  extractImageUrl(result: any): string | null {
    return findOutputFile(result, 'image', this.currentConfig || undefined) as string | null
  }

  extractImageBase64(): { data: string; mimeType: string } | null {
    return null
  }
}

function parseReferenceImages(raw?: string | null): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.map((item) => String(item || '').trim()).filter(Boolean)
  } catch {
    return []
  }
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
  const filename = `veryai-${Date.now()}-${Math.random().toString(16).slice(2)}.${ext}`
  const form = new FormData()
  form.append('image', blob, filename)
  form.append('overwrite', 'true')
  form.append('type', 'input')

  const resp = await fetch(joinProviderUrl(config.baseUrl, '', '/upload/image'), {
    method: 'POST',
    headers: config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : undefined,
    body: form,
    signal: AbortSignal.timeout(120_000),
  })

  if (!resp.ok) throw new Error(`ComfyUI image upload failed ${resp.status}: ${await resp.text()}`)
  const result = await resp.json() as any
  return result.name || result.filename || filename
}

export class ComfyUIVideoAdapter extends ComfyUIBase implements VideoProviderAdapter {
  buildGenerateRequest(config: AIConfig, record: VideoGenerationRecord): ProviderRequest {
    const settings = config.settings || {}
    const duration = Number(record.duration || 5)
    const fps = Number(settings.fps || 24)
    const fallbackSize = record.aspectRatio === '9:16' ? '720x1280' : '1280x720'
    const parsedSize = parseSize(fallbackSize)
    const width = Number(record.width || parsedSize.width)
    const height = Number(record.height || parsedSize.height)
    const frameCount = Math.max(1, Math.round(duration * fps) + 1)
    return this.buildPromptRequest(config, {
      prompt: record.prompt || '',
      model: record.model || config.model,
      first_frame: record.firstFrameUrl || record.imageUrl || '',
      last_frame: record.lastFrameUrl || '',
      input_image: record.imageUrl || record.firstFrameUrl || '',
      duration,
      fps,
      frame_count: frameCount,
      FrameCount: frameCount,
      frames: frameCount,
      Frames: frameCount,
      width,
      Width: width,
      height,
      Height: height,
      video_width: width,
      VideoWidth: width,
      video_height: height,
      VideoHeight: height,
      aspect_ratio: record.aspectRatio || '16:9',
      AspectRatio: record.aspectRatio || '16:9',
      seed: Math.floor(Math.random() * 2147483647),
    })
  }

  parseGenerateResponse(result: any): VideoGenResponse {
    return this.parsePromptResponse(result)
  }

  buildPollRequest(config: AIConfig, taskId: string): ProviderRequest {
    return this.buildHistoryRequest(config, taskId)
  }

  parsePollResponse(result: any): VideoPollResponse {
    const url = findOutputFile(result, 'video', this.currentConfig || undefined) as string | null
    if (url) return { status: 'completed', videoUrl: url }
    return { status: 'processing' }
  }

  extractVideoUrl(result: any): string | null {
    return findOutputFile(result, 'video', this.currentConfig || undefined) as string | null
  }
}
