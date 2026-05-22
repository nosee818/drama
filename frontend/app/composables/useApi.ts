const BASE = '/api/v1'

async function parseJsonResponse(resp: Response) {
  const text = await resp.text()
  if (!text.trim()) {
    throw new Error(resp.ok ? '服务返回为空，请检查后端服务状态' : `服务无响应或返回为空：${resp.status}`)
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`服务返回不是有效 JSON：${resp.status}`)
  }
}

async function req<T = any>(method: string, path: string, body?: any): Promise<T> {
  const opts: RequestInit = { method, headers: { 'Content-Type': 'application/json' } }
  if (body) opts.body = JSON.stringify(body)

  const start = performance.now()
  console.log(`%c[API] %c${method} %c${path}`, 'color:#888', 'color:#4fc3f7;font-weight:bold', 'color:#ccc', body || '')

  try {
    const resp = await fetch(`${BASE}${path}`, opts)
    const json = await parseJsonResponse(resp)
    const ms = Math.round(performance.now() - start)

    if (!resp.ok || (json.code && json.code >= 400)) {
      console.log(`%c[API] %c${method} ${path} %c${resp.status} %c${ms}ms`, 'color:#888', 'color:#ef5350', 'color:#ef5350;font-weight:bold', 'color:#888', json.message || '')
      throw new Error(json.message || `${resp.status}`)
    }

    console.log(`%c[API] %c${method} ${path} %c${resp.status} %c${ms}ms`, 'color:#888', 'color:#66bb6a', 'color:#66bb6a;font-weight:bold', 'color:#888')
    return json.data ?? json
  } catch (err: any) {
    if (!err.message?.match(/^\d{3}$/)) {
      const ms = Math.round(performance.now() - start)
      console.log(`%c[API] %c${method} ${path} %cERROR %c${ms}ms`, 'color:#888', 'color:#ef5350', 'color:#ef5350;font-weight:bold', 'color:#888', err.message)
    }
    throw err
  }
}

async function uploadReq<T = any>(method: string, path: string, body: FormData): Promise<T> {
  const start = performance.now()
  console.log(`%c[API] %c${method} %c${path}`, 'color:#888', 'color:#4fc3f7;font-weight:bold', 'color:#ccc', body)

  try {
    const resp = await fetch(`${BASE}${path}`, { method, body })
    const json = await parseJsonResponse(resp)
    const ms = Math.round(performance.now() - start)

    if (!resp.ok || (json.code && json.code >= 400)) {
      console.log(`%c[API] %c${method} ${path} %c${resp.status} %c${ms}ms`, 'color:#888', 'color:#ef5350', 'color:#ef5350;font-weight:bold', 'color:#888', json.message || '')
      throw new Error(json.message || `${resp.status}`)
    }

    console.log(`%c[API] %c${method} ${path} %c${resp.status} %c${ms}ms`, 'color:#888', 'color:#66bb6a', 'color:#66bb6a;font-weight:bold', 'color:#888')
    return json.data ?? json
  } catch (err: any) {
    if (!err.message?.match(/^\d{3}$/)) {
      const ms = Math.round(performance.now() - start)
      console.log(`%c[API] %c${method} ${path} %cERROR %c${ms}ms`, 'color:#888', 'color:#ef5350', 'color:#ef5350;font-weight:bold', 'color:#888', err.message)
    }
    throw err
  }
}

export const api = {
  get: <T = any>(p: string) => req<T>('GET', p),
  post: <T = any>(p: string, b?: any) => req<T>('POST', p, b),
  put: <T = any>(p: string, b?: any) => req<T>('PUT', p, b),
  del: <T = any>(p: string) => req<T>('DELETE', p),
}

export const dramaAPI = {
  list: () => api.get<{ items: any[] }>('/dramas'),
  get: (id: number) => api.get(`/dramas/${id}`),
  create: (data: any) => api.post('/dramas', data),
  createWithFile: (data: FormData) => uploadReq('POST', '/dramas', data),
  update: (id: number, data: any) => api.put(`/dramas/${id}`, data),
  autoGenerate: (id: number, data: any) => api.post(`/dramas/${id}/auto-generate`, data),
  autoGeneratePreview: (id: number, data: any) => api.post(`/dramas/${id}/auto-generate-preview`, data),
  autoGenerateCurrent: (id: number) => api.get(`/dramas/${id}/auto-generate-current`),
  autoGenerateJobs: (id: number) => api.get(`/dramas/${id}/auto-generate-jobs`),
  autoGenerateStatus: (id: number, jobId: string) => api.get(`/dramas/${id}/auto-generate/${jobId}`),
  autoGenerateControl: (id: number, jobId: string, action: 'pause' | 'resume' | 'cancel') => api.post(`/dramas/${id}/auto-generate/${jobId}/control`, { action }),
  clearGenerated: (id: number) => api.post(`/dramas/${id}/clear-generated`, { confirm: 'CLEAR' }),
  del: (id: number) => api.del(`/dramas/${id}`),
}

export const episodeAPI = {
  create: (data: any) => api.post('/episodes', data),
  update: (id: number, data: any) => api.put(`/episodes/${id}`, data),
  characters: (id: number) => api.get(`/episodes/${id}/characters`),
  scenes: (id: number) => api.get(`/episodes/${id}/scenes`),
  storyboards: (id: number) => api.get(`/episodes/${id}/storyboards`),
  pipelineStatus: (id: number) => api.get(`/episodes/${id}/pipeline-status`),
}

export const storyboardAPI = {
  create: (data: any) => api.post('/storyboards', data),
  update: (id: number, data: any) => api.put(`/storyboards/${id}`, data),
  generateTTS: (id: number, configId?: number | null) => api.post(`/storyboards/${id}/generate-tts`, { ...(configId ? { config_id: configId } : {}) }),
  listDubbings: (episodeId: number) => api.get(`/storyboards/episodes/${episodeId}/dubbings`),
  createDubbing: (data: any) => api.post('/storyboards/dubbings', data),
  updateDubbing: (id: number, data: any) => api.put(`/storyboards/dubbings/${id}`, data),
  deleteDubbing: (id: number) => api.del(`/storyboards/dubbings/${id}`),
  generateDubbingTTS: (id: number, configId?: number | null) => api.post(`/storyboards/dubbings/${id}/generate-tts`, { ...(configId ? { config_id: configId } : {}) }),
  uploadFrame: (id: number, frameType: 'first_frame' | 'last_frame', file: File) => {
    const body = new FormData()
    body.append('file', file)
    body.append('frame_type', frameType)
    return uploadReq('POST', `/storyboards/${id}/upload-frame`, body)
  },
  uploadVideo: (id: number, file: File) => {
    const body = new FormData()
    body.append('file', file)
    return uploadReq('POST', `/storyboards/${id}/upload-video`, body)
  },
  del: (id: number) => api.del(`/storyboards/${id}`),
}

export const characterAPI = {
  create: (data: any) => api.post('/characters', data),
  update: (id: number, data: any) => api.put(`/characters/${id}`, data),
  del: (id: number) => api.del(`/characters/${id}`),
  voiceSample: (id: number, episodeId: number, configId?: number | null) => api.post(`/characters/${id}/generate-voice-sample`, { episode_id: episodeId, ...(configId ? { config_id: configId } : {}) }),
  generateImage: (id: number, episodeId?: number | null, configId?: number | null) => api.post(`/characters/${id}/generate-image`, { ...(episodeId ? { episode_id: episodeId } : {}), ...(configId ? { config_id: configId } : {}) }),
  batchImages: (ids: number[], episodeId: number, configId?: number | null) => api.post('/characters/batch-generate-images', { character_ids: ids, episode_id: episodeId, ...(configId ? { config_id: configId } : {}) }),
  images: (id: number) => api.get(`/characters/${id}/images`),
  useImage: (id: number, imageUrl: string) => api.post(`/characters/${id}/use-image`, { image_url: imageUrl }),
  uploadImage: (id: number, file: File) => {
    const body = new FormData()
    body.append('file', file)
    return uploadReq('POST', `/characters/${id}/upload-image`, body)
  },
  uploadVoiceSample: (id: number, file: File) => {
    const body = new FormData()
    body.append('file', file)
    return uploadReq('POST', `/characters/${id}/upload-voice-sample`, body)
  },
}

export const sceneAPI = {
  update: (id: number, data: any) => api.put(`/scenes/${id}`, data),
  generateImage: (id: number, episodeId: number, configId?: number | null) => api.post(`/scenes/${id}/generate-image`, { episode_id: episodeId, ...(configId ? { config_id: configId } : {}) }),
  uploadImage: (id: number, file: File) => {
    const body = new FormData()
    body.append('file', file)
    return uploadReq('POST', `/scenes/${id}/upload-image`, body)
  },
}

export const imageAPI = {
  generate: (d: any) => api.post('/images', d),
  get: (id: number) => api.get(`/images/${id}`),
  list: (params?: { drama_id?: number; storyboard_id?: number }) => {
    const query = new URLSearchParams()
    if (params?.drama_id) query.set('drama_id', String(params.drama_id))
    if (params?.storyboard_id) query.set('storyboard_id', String(params.storyboard_id))
    return api.get(`/images${query.size ? `?${query.toString()}` : ''}`)
  },
}
export const gridAPI = {
  prompt: (d: any) => api.post('/grid/prompt', d),
  generate: (d: any) => api.post('/grid/generate', d),
  status: (id: number) => api.get(`/grid/status/${id}`),
  split: (d: any) => api.post('/grid/split', d),
}
export const videoAPI = {
  generate: (d: any) => api.post('/videos', d),
  get: (id: number) => api.get(`/videos/${id}`),
  list: (params?: { drama_id?: number; storyboard_id?: number }) => {
    const query = new URLSearchParams()
    if (params?.drama_id) query.set('drama_id', String(params.drama_id))
    if (params?.storyboard_id) query.set('storyboard_id', String(params.storyboard_id))
    return api.get(`/videos${query.size ? `?${query.toString()}` : ''}`)
  },
}
export const composeAPI = {
  shot: (id: number, options?: { keep_original_audio?: boolean; keepOriginalAudio?: boolean }) => api.post(`/compose/storyboards/${id}/compose`, options || {}),
  all: (epId: number, options?: { keep_original_audio?: boolean; keepOriginalAudio?: boolean }) => api.post(`/compose/episodes/${epId}/compose-all`, options || {}),
  status: (epId: number) => api.get(`/compose/episodes/${epId}/compose-status`),
}
export const mergeAPI = {
  merge: (epId: number) => api.post(`/merge/episodes/${epId}/merge`),
  status: (epId: number) => api.get(`/merge/episodes/${epId}/merge`),
}
export const aiConfigAPI = {
  list: (t?: string) => api.get(`/ai-configs${t ? `?service_type=${t}` : ''}`),
  create: (d: any) => api.post('/ai-configs', d),
  update: (id: number, d: any) => api.put(`/ai-configs/${id}`, d),
  del: (id: number) => api.del(`/ai-configs/${id}`),
  test: (d: any) => api.post('/ai-configs/test', d),
  huobaoPreset: (apiKey: string) => api.post('/ai-configs/huobao-preset', { api_key: apiKey }),
}

export const agentConfigAPI = {
  list: () => api.get('/agent-configs'),
  stylePrompts: () => api.get('/agent-configs/style-prompts'),
  saveStylePrompts: (items: any[]) => api.put('/agent-configs/style-prompts', { items }),
  get: (id: number) => api.get(`/agent-configs/${id}`),
  create: (d: any) => api.post('/agent-configs', d),
  update: (id: number, d: any) => api.put(`/agent-configs/${id}`, d),
  del: (id: number) => api.del(`/agent-configs/${id}`),
}

export const skillsAPI = {
  list: () => api.get('/skills'),
  active: () => api.get('/skills/active'),
  setActive: (agentType: string, skillId: string) => api.put(`/skills/active/${agentType}`, { skill_id: skillId }),
  get: (id: string) => api.get(`/skills/${id}`),
  create: (data: { id: string; name: string; description?: string }) => api.post('/skills', data),
  update: (id: string, content: string) => api.put(`/skills/${id}`, { content }),
  del: (id: string) => api.del(`/skills/${id}`),
}

export const voicesAPI = {
  list: (provider?: string) => api.get(`/ai-voices${provider ? `?provider=${provider}` : ''}`),
  sync: () => api.post('/ai-voices/sync', {}),
}
