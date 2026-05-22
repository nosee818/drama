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
  TTSProviderAdapter,
} from './types.js'
import { joinProviderUrl } from './url.js'

function parseWorkflow(settings: Record<string, any>) {
  const workflow = settings.workflow || settings.workflowApi || settings.prompt
  if (!workflow && Object.keys(settings).length > 0) return pruneWorkflowMetadata(settings)
  if (!workflow) throw new Error('ComfyUI workflow JSON is required. Paste the workflow directly, or wrap it as settings.workflow')
  return pruneWorkflowMetadata(typeof workflow === 'string' ? JSON.parse(workflow) : workflow)
}

function isComfyUINode(value: any) {
  return value
    && typeof value === 'object'
    && !Array.isArray(value)
    && typeof value.class_type === 'string'
    && value.inputs
    && typeof value.inputs === 'object'
    && !Array.isArray(value.inputs)
}

function pruneWorkflowMetadata(workflow: any) {
  if (!workflow || typeof workflow !== 'object' || Array.isArray(workflow)) return workflow

  const entries = Object.entries(workflow)
  const hasNodeEntries = entries.some(([, value]) => isComfyUINode(value))
  if (!hasNodeEntries) return workflow

  return Object.fromEntries(entries.filter(([, value]) => isComfyUINode(value)))
}

function parseSize(size?: string | null) {
  const match = String(size || '').match(/(\d+)\s*x\s*(\d+)/i)
  return { width: Number(match?.[1] || 1024), height: Number(match?.[2] || 1024) }
}

function firstFiniteNumber(...values: any[]) {
  for (const value of values) {
    const num = Number(value)
    if (Number.isFinite(num) && num > 0) return num
  }
  return null
}

function configuredVideoSize(settings: Record<string, any>, aspectRatio?: string | null) {
  const resolution = String(settings.videoResolution ?? settings.video_resolution ?? settings.resolution ?? '').toLowerCase()
  const preset = resolution === '720p' || resolution === '720'
    ? { width: 1280, height: 720 }
    : resolution === '1080p' || resolution === '1080'
      ? { width: 1920, height: 1080 }
      : null
  const width = firstFiniteNumber(preset?.width, settings.defaultWidth, settings.default_width, settings.videoWidth, settings.video_width, settings.width)
  const height = firstFiniteNumber(preset?.height, settings.defaultHeight, settings.default_height, settings.videoHeight, settings.video_height, settings.height)
  if (!width || !height) return null

  const wide = Math.max(width, height)
  const narrow = Math.min(width, height)
  return aspectRatio === '9:16'
    ? { width: narrow, height: wide }
    : { width: wide, height: narrow }
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

function setIfPresent(inputs: Record<string, any>, aliases: string[], value: any, preserveLinks = false) {
  for (const key of aliases) {
    if (!Object.prototype.hasOwnProperty.call(inputs, key)) continue
    if (preserveLinks && Array.isArray(inputs[key])) continue
    inputs[key] = value
  }
}

function applyVideoWorkflowParams(workflow: any, values: Record<string, any>) {
  if (!workflow || typeof workflow !== 'object' || Array.isArray(workflow)) return workflow

  for (const node of Object.values(workflow) as any[]) {
    const inputs = node?.inputs
    if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs)) continue

    setIfPresent(inputs, ['prompt', 'text', 'input', 'positive', 'positive_prompt', 'video_prompt'], values.prompt, true)
    setIfPresent(inputs, ['negative', 'negative_prompt'], values.negative_prompt, true)
    setIfPresent(inputs, ['width', 'Width', 'video_width', 'VideoWidth'], values.width, true)
    setIfPresent(inputs, ['height', 'Height', 'video_height', 'VideoHeight'], values.height, true)
    setIfPresent(inputs, ['fps', 'frame_rate', 'frameRate'], values.fps, true)
    setIfPresent(inputs, ['frame_count', 'num_frames', 'video_frames', 'frames', 'FrameCount', 'Frames'], values.frame_count, true)
    setIfPresent(inputs, ['duration', 'video_duration', 'seconds'], values.duration, true)
    setIfPresent(inputs, ['image', 'input_image', 'reference_image', 'start_image', 'first_frame'], values.input_image, true)
    setIfPresent(inputs, ['last_image', 'end_image', 'last_frame'], values.last_frame, true)
  }

  return workflow
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

function applyOutputFilenamePrefix(workflow: any, prefix?: string | null) {
  if (!prefix || !workflow || typeof workflow !== 'object' || Array.isArray(workflow)) return workflow

  for (const node of Object.values(workflow) as any[]) {
    if (!node?.inputs || typeof node.inputs !== 'object') continue
    const classType = String(node.class_type || '').toLowerCase()
    if (classType.includes('save') && Object.prototype.hasOwnProperty.call(node.inputs, 'filename_prefix')) {
      node.inputs.filename_prefix = prefix
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

function findHistoryOutputs(result: any, taskId?: string) {
  if (!result || typeof result !== 'object') return {}
  if (result.outputs) return result.outputs
  if (taskId && result[taskId]?.outputs) return result[taskId].outputs
  if (taskId) return {}
  const historyEntry = Object.values(result).find((entry: any) => entry?.outputs) as any
  return historyEntry?.outputs || {}
}

function findHistoryError(result: any, taskId?: string) {
  if (!result || typeof result !== 'object') return null
  const entry = taskId ? result[taskId] : Object.values(result).find((item: any) => item?.status)
  const status = (entry as any)?.status
  if (!status || status.completed === true) return null
  if (status.status_str && status.status_str !== 'error') return null

  const messages = Array.isArray(status.messages) ? status.messages : []
  for (const message of messages) {
    if (!Array.isArray(message) || message[0] !== 'execution_error') continue
    const detail = message[1] || {}
    return detail.exception_message || detail.exception_type || 'ComfyUI execution error'
  }
  return status.status_str === 'error' ? 'ComfyUI execution error' : null
}

function findOutputFile(result: any, serviceType: 'image' | 'video' | 'audio', config?: AIConfig, taskId?: string) {
  const outputs = findHistoryOutputs(result, taskId)
  const preferred = serviceType === 'image'
    ? ['images']
    : serviceType === 'audio'
      ? ['audio', 'audios', 'files']
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
    const outputPrefix = values.filename_prefix || values.filenamePrefix || `veryai-${values.task_id || Date.now()}`
    const renderedWorkflow = renderWorkflow(parseWorkflow(settings), values)
    const workflowWithParams = values.__apply_video_params
      ? applyVideoWorkflowParams(renderedWorkflow, values)
      : renderedWorkflow
    const workflow = pruneUnavailableLoadImageNodes(applyOutputFilenamePrefix(workflowWithParams, outputPrefix))
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
    const prompt = record.prompt || ''
    const referenceImages = (await Promise.all(
      parseReferenceImages(record.referenceImages).slice(0, 3).map((item) => uploadComfyUIImageIfNeeded(config, item)),
    )).filter((item): item is string => !!item)
    const settings = config.settings || {}
    const linkIds = settings.referenceImageLinks || settings.imageLinks || {}
    const refLink = (name: string, index: number) => referenceImages[index]
      ? (linkIds[name] ?? linkIds[String(index + 1)] ?? null)
      : null
    return this.buildPromptRequest(config, {
      prompt,
      text: prompt,
      input: prompt,
      positive: prompt,
      positive_prompt: prompt,
      image_prompt: prompt,
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
      task_id: record.id,
      filename_prefix: `veryai-image-${record.id || Date.now()}`,
    })
  }

  parseGenerateResponse(result: any): ImageGenResponse {
    return this.parsePromptResponse(result)
  }

  buildPollRequest(config: AIConfig, taskId: string): ProviderRequest {
    return this.buildHistoryRequest(config, taskId)
  }

  parsePollResponse(result: any, config?: AIConfig, taskId?: string): ImagePollResponse {
    const url = findOutputFile(result, 'image', config || this.currentConfig || undefined, taskId) as string | null
    if (url) return { status: 'completed', imageUrl: url }
    return { status: 'processing' }
  }

  extractImageUrl(result: any, config?: AIConfig, taskId?: string): string | null {
    return findOutputFile(result, 'image', config || this.currentConfig || undefined, taskId) as string | null
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

async function uploadComfyUIAudioIfNeeded(config: AIConfig, value: string | null): Promise<string | null> {
  if (!value) return null
  if (!value.startsWith('data:audio/')) return value

  const match = value.match(/^data:(audio\/[a-zA-Z0-9.+-]+);base64,(.+)$/)
  if (!match) return value

  const mimeType = match[1]
  const ext = mimeType.includes('flac') ? 'flac'
    : mimeType.includes('wav') ? 'wav'
      : mimeType.includes('ogg') ? 'ogg'
        : mimeType.includes('mp4') ? 'm4a'
          : 'mp3'
  const bytes = Uint8Array.from(Buffer.from(match[2], 'base64'))
  const blob = new Blob([bytes], { type: mimeType })
  const filename = `veryai-voice-${Date.now()}-${Math.random().toString(16).slice(2)}.${ext}`
  const attempts = [
    { path: '/upload/audio', field: 'audio' },
    { path: '/upload/image', field: 'image' },
  ]

  let lastError = ''
  for (const attempt of attempts) {
    const form = new FormData()
    form.append(attempt.field, blob, filename)
    form.append('overwrite', 'true')
    form.append('type', 'input')

    const resp = await fetch(joinProviderUrl(config.baseUrl, '', attempt.path), {
      method: 'POST',
      headers: config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : undefined,
      body: form,
      signal: AbortSignal.timeout(120_000),
    })
    if (resp.ok) {
      const result = await resp.json().catch(() => null) as any
      return result?.name || result?.filename || filename
    }
    lastError = `${resp.status}: ${await resp.text().catch(() => '')}`
  }

  throw new Error(`ComfyUI audio upload failed ${lastError}`)
}

export class ComfyUIVideoAdapter extends ComfyUIBase implements VideoProviderAdapter {
  buildGenerateRequest(config: AIConfig, record: VideoGenerationRecord): ProviderRequest {
    const settings = config.settings || {}
    const duration = Number(record.duration || 5)
    const fps = firstFiniteNumber(record.fps, settings.fps, settings.defaultFps, settings.default_fps, settings.frameRate, settings.frame_rate) || 25
    const fallbackSize = record.aspectRatio === '9:16' ? '1080x1920' : '1920x1080'
    const parsedSize = parseSize(fallbackSize)
    const configSize = configuredVideoSize(settings, record.aspectRatio)
    const width = Number(record.width || configSize?.width || parsedSize.width)
    const height = Number(record.height || configSize?.height || parsedSize.height)
    const frameCount = Math.max(1, Math.round(duration * fps) + 1)
    const referenceImages = parseReferenceImages(record.referenceImageUrls)
    const inputImage = record.imageUrl || record.firstFrameUrl || referenceImages[0] || ''
    return this.buildPromptRequest(config, {
      prompt: record.prompt || '',
      text: record.prompt || '',
      input: record.prompt || '',
      positive: record.prompt || '',
      positive_prompt: record.prompt || '',
      video_prompt: record.prompt || '',
      negative_prompt: '',
      model: record.model || config.model,
      first_frame: record.firstFrameUrl || record.imageUrl || '',
      last_frame: record.lastFrameUrl || '',
      input_image: inputImage,
      image: inputImage,
      reference_image: inputImage,
      reference_images: referenceImages,
      input_images: referenceImages,
      image1: referenceImages[0] || inputImage,
      image2: referenceImages[1] || '',
      image3: referenceImages[2] || '',
      image4: referenceImages[3] || '',
      reference_count: referenceImages.length || (inputImage ? 1 : 0),
      has_image1: !!(referenceImages[0] || inputImage),
      has_image2: !!referenceImages[1],
      has_image3: !!referenceImages[2],
      has_image4: !!referenceImages[3],
      duration,
      video_duration: duration,
      seconds: duration,
      fps,
      frame_rate: fps,
      frame_count: frameCount,
      num_frames: frameCount,
      video_frames: frameCount,
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
      task_id: record.id,
      filename_prefix: `veryai-video-${record.id || Date.now()}`,
      __apply_video_params: settings.autoFillVideoParams !== false && settings.auto_fill_video_params !== false,
    })
  }

  parseGenerateResponse(result: any): VideoGenResponse {
    return this.parsePromptResponse(result)
  }

  buildPollRequest(config: AIConfig, taskId: string): ProviderRequest {
    return this.buildHistoryRequest(config, taskId)
  }

  parsePollResponse(result: any, config?: AIConfig, taskId?: string): VideoPollResponse {
    const error = findHistoryError(result, taskId)
    if (error) return { status: 'failed', error }
    const url = findOutputFile(result, 'video', config || this.currentConfig || undefined, taskId) as string | null
    if (url) return { status: 'completed', videoUrl: url }
    return { status: 'processing' }
  }

  extractVideoUrl(result: any, config?: AIConfig, taskId?: string): string | null {
    return findOutputFile(result, 'video', config || this.currentConfig || undefined, taskId) as string | null
  }
}

export class ComfyUITTSAdapter extends ComfyUIBase implements TTSProviderAdapter {
  async buildGenerateRequest(config: AIConfig, params: any): Promise<ProviderRequest> {
    const referenceAudio = await uploadComfyUIAudioIfNeeded(config, params.referenceAudioUrl || params.audio || params.voiceSampleUrl)
    return this.buildPromptRequest(config, {
      prompt: params.text || '',
      text: params.text || '',
      input: params.text || '',
      voice: params.voice || '',
      voice_id: params.voice || '',
      instruct: params.instruct || params.voice || '',
      ref_text: params.refText || params.referenceText || '',
      target_text: params.text || '',
      audio: referenceAudio || '',
      ref_audio: referenceAudio || '',
      reference_audio: referenceAudio || '',
      voice_sample: referenceAudio || '',
      model: params.model || config.model,
      speed: params.speed ?? 1,
      emotion: params.emotion || '',
      seed: Math.floor(Math.random() * 2147483647),
      task_id: params.id,
      filename_prefix: `veryai-audio-${params.id || Date.now()}`,
    })
  }

  parseResponse(result: any) {
    return {
      audioHex: '',
      audioUrl: findOutputFile(result, 'audio', this.currentConfig || undefined) as string | null || undefined,
      audioLength: 0,
      sampleRate: 32000,
      bitrate: 128000,
      format: 'mp3',
      channel: 1,
    }
  }

  parseGenerateResponse(result: any) {
    return this.parsePromptResponse(result)
  }

  buildPollRequest(config: AIConfig, taskId: string): ProviderRequest {
    return this.buildHistoryRequest(config, taskId)
  }
}
