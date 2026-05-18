import type { AIConfig, ProviderRequest, TTSProviderAdapter } from './types.js'
import { joinProviderUrl } from './url.js'

function renderTemplateObject(template: any, values: Record<string, any>): any {
  if (Array.isArray(template)) return template.map((item) => renderTemplateObject(item, values))
  if (template && typeof template === 'object') {
    return Object.fromEntries(Object.entries(template).map(([key, value]) => [key, renderTemplateObject(value, values)]))
  }
  if (typeof template !== 'string') return template
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => values[key] == null ? '' : String(values[key]))
}

function pickString(...values: any[]) {
  return values.find((value) => typeof value === 'string' && value.trim()) || null
}

function pathFromTemplate(template: string, taskId: string) {
  return template.replace(/\{taskId\}/g, encodeURIComponent(taskId)).replace(/\{id\}/g, encodeURIComponent(taskId))
}

function pickAudio(result: any) {
  const audioHex = pickString(result.audio, result.data?.audio, result.output?.audio, result.audio_hex, result.audioHex)
  const audioBase64 = pickString(result.audio_base64, result.audioBase64, result.data?.audio_base64, result.data?.audioBase64, result.output?.audio_base64)
  const audioUrl = pickString(result.audio_url, result.audioUrl, result.url, result.data?.audio_url, result.data?.audioUrl, result.data?.url, result.output?.audio_url)
  return { audioHex, audioBase64, audioUrl }
}

function parseAudioResult(result: any) {
  const { audioHex, audioBase64, audioUrl } = pickAudio(result)
  if (!audioHex && !audioBase64 && !audioUrl) {
    throw new Error('No audio data/url in TTS response')
  }
  return {
    audioHex: audioHex || '',
    audioBase64,
    audioUrl,
    audioLength: Number(result.audio_length || result.audioLength || result.data?.audio_length || 0),
    sampleRate: Number(result.sample_rate || result.sampleRate || 32000),
    bitrate: Number(result.bitrate || 128000),
    format: String(result.format || result.audio_format || result.data?.format || 'mp3'),
    channel: Number(result.channel || 1),
  }
}

export class GenericTTSAdapter implements TTSProviderAdapter {
  provider = 'custom'

  buildGenerateRequest(config: AIConfig, params: any): ProviderRequest {
    const settings = config.settings || {}
    const path = config.endpoint || settings.endpoint || settings.generatePath || '/v1/audio/speech'
    const values = {
      model: params.model || config.model,
      text: params.text || '',
      input: params.text || '',
      voice: params.voice || '',
      voice_id: params.voice || '',
      instruct: params.instruct || params.voice || '',
      ref_text: params.refText || '',
      target_text: params.text || '',
      reference_audio: params.referenceAudioUrl || params.audio || '',
      audio: params.audio || params.referenceAudioUrl || '',
      speed: params.speed ?? 1,
      emotion: params.emotion || '',
    }

    if (settings.requestType === 'multipart') {
      const form = new FormData()
      const formFields = settings.formFields && typeof settings.formFields === 'object'
        ? settings.formFields
        : { text: '{{text}}', voice: '{{voice}}', model: '{{model}}' }
      const renderedFields = renderTemplateObject(formFields, values)
      for (const [key, value] of Object.entries(renderedFields)) {
        if (value == null || value === '') continue
        form.append(key, String(value))
      }
      return {
        url: joinProviderUrl(config.baseUrl, '', path),
        method: settings.method || 'POST',
        headers: {
          ...(config.apiKey ? { Authorization: `${settings.authScheme || 'Bearer'} ${config.apiKey}` } : {}),
          ...(settings.headers && typeof settings.headers === 'object' ? settings.headers : {}),
        },
        body: form,
        responseType: settings.responseType === 'json' ? 'json' : 'file',
        fileExtension: settings.fileExtension || 'mp3',
        timeoutMs: Number(settings.timeoutMs || settings.timeout_ms || 600_000),
      }
    }

    const template = settings.requestTemplate
    const body = template && typeof template === 'object'
      ? renderTemplateObject(template, values)
      : {
          model: values.model,
          input: values.input,
          voice: values.voice,
        }

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
      fileExtension: settings.fileExtension || 'mp3',
      timeoutMs: Number(settings.timeoutMs || settings.timeout_ms || 600_000),
    }
  }

  parseGenerateResponse(result: any) {
    const audio = pickAudio(result)
    if (audio.audioHex || audio.audioBase64 || audio.audioUrl) {
      return { isAsync: false, ...parseAudioResult(result) }
    }

    const taskId = pickString(result.task_id, result.taskId, result.id, result.data?.id, result.output?.task_id)
    if (taskId) return { isAsync: true, taskId }
    throw new Error('No task id or audio data/url in TTS response')
  }

  buildPollRequest(config: AIConfig, taskId: string): ProviderRequest {
    const settings = config.settings || {}
    const path = pathFromTemplate(config.queryEndpoint || settings.queryEndpoint || settings.pollPath || '/v1/audio/tasks/{taskId}', taskId)
    return {
      url: joinProviderUrl(config.baseUrl, '', path),
      method: settings.pollMethod || 'GET',
      headers: {
        ...(config.apiKey ? { Authorization: `${settings.authScheme || 'Bearer'} ${config.apiKey}` } : {}),
        ...(settings.headers && typeof settings.headers === 'object' ? settings.headers : {}),
      },
      body: undefined,
      timeoutMs: Number(settings.pollTimeoutMs || settings.poll_timeout_ms || 120_000),
    }
  }

  parsePollResponse(result: any) {
    const status = String(result.status || result.state || result.data?.status || '').toLowerCase()
    const audio = pickAudio(result)
    if (audio.audioHex || audio.audioBase64 || audio.audioUrl || ['succeeded', 'success', 'completed', 'done'].includes(status)) {
      return { status: 'completed' as const, ...parseAudioResult(result) }
    }
    if (['failed', 'error', 'cancelled', 'canceled'].includes(status)) {
      return { status: 'failed' as const, error: result.error?.message || result.message || 'TTS generation failed' }
    }
    return { status: 'processing' as const }
  }

  parseResponse(result: any) {
    return parseAudioResult(result)
  }
}
