import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { success, badRequest, now } from '../utils/response.js'
import { generateVoiceSample } from '../services/tts-generation.js'
import { generateImage } from '../services/image-generation.js'
import { saveUploadedFile } from '../utils/storage.js'
import { logTaskError, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'
import { dramaOrientation, orientationImageSize } from '../utils/aspect.js'

const app = new Hono()

function safeJson(value?: string | null) {
  try { return JSON.parse(value || '{}') || {} } catch { return {} }
}

function characterImageConfigId(drama: any, fallback?: number | null) {
  const defaults = safeJson(drama?.metadata).ai_defaults || {}
  return Number(defaults.character_image_config_id || defaults.image_config_id || fallback || 0) || undefined
}

const transientStatePatterns = [
  /昏迷[^，。；、]*/g,
  /面容模糊/g,
  /脸部模糊/g,
  /五官模糊/g,
  /倒地[^，。；、]*/g,
  /躺在[^，。；、]*/g,
  /受伤[^，。；、]*/g,
  /流血[^，。；、]*/g,
  /虚弱[^，。；、]*/g,
  /惊恐[^，。；、]*/g,
  /哭泣[^，。；、]*/g,
]

function cleanStableCharacterText(value?: string | null) {
  let text = String(value || '').trim()
  for (const pattern of transientStatePatterns) text = text.replace(pattern, '')
  return text
    .replace(/[，,、；;。]\s*[，,、；;。]+/g, '，')
    .replace(/^[，,、；;。\s]+|[，,、；;。\s]+$/g, '')
    .trim()
}

function buildCharacterReferencePrompt(char: any) {
  const stableAppearance = cleanStableCharacterText(char.appearance)
  const base = [
    `单人角色参考照：${char.name}`,
    stableAppearance ? `外貌设定：${stableAppearance}` : '',
  ].filter(Boolean).join('，')
  return [
    base || `${char.name}，人物角色参考图`,
    '单人全身角色立绘，完整人物从头顶到脚底全部进入画面，头发、脸、上半身、双手、腿、脚踝、鞋子都必须清楚可见',
    '人物直立站姿，居中构图，镜头距离足够远，身体上下留有少量空白，不裁切头部、手臂、腿部、脚部或衣摆',
    '清晰正面或三分之二侧身，五官清楚，表情自然中性，站姿稳定，双手自然',
    '完整展示发型、发色、年龄感、身高体态、服装、国籍/地域气质、标志性配饰',
    '干净浅色纯色背景，人物设定图，按照项目视觉风格渲染',
    '不要生成半身照、胸像、头像、近景、特写、坐姿、蹲姿、趴卧、被遮挡、多人',
    '不要生成设定卡，不要任何文字，不要标签，不要水印，不要海报排版',
    '不要剧情动作，不要昏迷、受伤、倒地、哭泣、面容模糊',
    '高质量头到脚全身人物设定图',
  ].join('，')
}

// POST /characters — 手动新增角色/声音角色
app.post('/', async (c) => {
  const body = await c.req.json()
  const dramaId = Number(body.drama_id || body.dramaId || 0)
  const name = String(body.name || '').trim()
  if (!dramaId) return badRequest(c, 'drama_id is required')
  if (!name) return badRequest(c, '角色名称不能为空')
  const ts = now()
  const res = db.insert(schema.characters).values({
    dramaId,
    name,
    role: body.role || '',
    description: body.description || '',
    appearance: body.appearance || '',
    personality: body.personality || '',
    voiceStyle: body.voice_style || body.voiceStyle || '',
    voiceProvider: body.voice_provider || body.voiceProvider || 'manual',
    sortOrder: Number(body.sort_order || body.sortOrder || 0) || null,
    createdAt: ts,
    updatedAt: ts,
  }).run()
  const id = Number(res.lastInsertRowid)
  if (body.episode_id || body.episodeId) {
    db.insert(schema.episodeCharacters).values({
      episodeId: Number(body.episode_id || body.episodeId),
      characterId: id,
      createdAt: ts,
    }).run()
  }
  const [char] = db.select().from(schema.characters).where(eq(schema.characters.id, id)).all()
  return success(c, char)
})

// PUT /characters/:id
app.put('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json()
  const updates: Record<string, any> = { updatedAt: now() }
  for (const key of ['name', 'role', 'description', 'appearance', 'personality', 'voiceStyle', 'voiceProvider', 'imageUrl', 'localPath']) {
    const snakeKey = key.replace(/[A-Z]/g, m => '_' + m.toLowerCase())
    if (snakeKey in body) updates[key] = body[snakeKey]
    else if (key in body) updates[key] = body[key]
  }
  if ('voice_style' in body || 'voiceStyle' in body) {
    updates.voiceSampleUrl = null
  }
  db.update(schema.characters).set(updates).where(eq(schema.characters.id, id)).run()
  return success(c)
})

// GET /characters/:id/images — 历史角色图
app.get('/:id/images', async (c) => {
  const id = Number(c.req.param('id'))
  const [char] = db.select().from(schema.characters).where(eq(schema.characters.id, id)).all()
  if (!char) return badRequest(c, 'Character not found')
  const rows = db.select().from(schema.imageGenerations).where(eq(schema.imageGenerations.characterId, id)).all()
  const currentUrl = char.imageUrl || char.localPath || ''
  const items = rows
    .filter(row => row.status === 'completed' && (row.localPath || row.imageUrl))
    .sort((a, b) => String(b.completedAt || b.updatedAt || b.createdAt).localeCompare(String(a.completedAt || a.updatedAt || a.createdAt)))
    .map(row => ({
      id: row.id,
      url: row.localPath || row.imageUrl,
      prompt: row.prompt,
      provider: row.provider,
      model: row.model,
      created_at: row.createdAt,
      completed_at: row.completedAt,
      is_current: (row.localPath || row.imageUrl) === currentUrl,
    }))
  if (currentUrl && !items.some(item => item.url === currentUrl)) {
    items.unshift({
      id: 0,
      url: currentUrl,
      prompt: '',
      provider: 'manual',
      model: '',
      created_at: char.updatedAt,
      completed_at: char.updatedAt,
      is_current: true,
    })
  }
  return success(c, items)
})

// POST /characters/:id/use-image — 从历史图设为当前角色图
app.post('/:id/use-image', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json().catch(() => ({}))
  const imageUrl = String(body.image_url || body.url || '').trim()
  if (!imageUrl) return badRequest(c, 'image_url is required')
  const updates: Record<string, any> = { imageUrl, updatedAt: now() }
  if (imageUrl.startsWith('static/')) updates.localPath = imageUrl
  db.update(schema.characters)
    .set(updates)
    .where(eq(schema.characters.id, id))
    .run()
  return success(c, { image_url: imageUrl })
})

// POST /characters/:id/upload-image — 上传并设为当前角色图
app.post('/:id/upload-image', async (c) => {
  const id = Number(c.req.param('id'))
  const [char] = db.select().from(schema.characters).where(eq(schema.characters.id, id)).all()
  if (!char) return badRequest(c, 'Character not found')
  const body = await c.req.parseBody()
  const file = body['file']
  if (!file || !(file instanceof File)) return badRequest(c, 'file is required')

  const buffer = await file.arrayBuffer()
  const localPath = await saveUploadedFile(buffer, 'images', file.name)
  const ts = now()
  db.insert(schema.imageGenerations).values({
    dramaId: char.dramaId,
    characterId: id,
    imageType: 'character',
    provider: 'manual',
    prompt: '用户上传角色参考图',
    localPath,
    status: 'completed',
    createdAt: ts,
    updatedAt: ts,
    completedAt: ts,
  }).run()
  db.update(schema.characters)
    .set({ imageUrl: localPath, localPath, updatedAt: ts })
    .where(eq(schema.characters.id, id))
    .run()
  return success(c, { image_url: localPath })
})

// DELETE /characters/:id
app.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  db.update(schema.characters).set({ deletedAt: now() }).where(eq(schema.characters.id, id)).run()
  return success(c)
})

// POST /characters/:id/generate-voice-sample — 生成角色音色试听
app.post('/:id/generate-voice-sample', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json().catch(() => ({}))
  const [char] = db.select().from(schema.characters).where(eq(schema.characters.id, id)).all()
  if (!char) return badRequest(c, 'Character not found')
  if (!char.voiceStyle) return badRequest(c, '请先完成角色声音设计')
  if (!body.episode_id) return badRequest(c, 'episode_id is required')

  const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, Number(body.episode_id))).all()
  if (!ep) return badRequest(c, 'Episode not found')

  try {
    logTaskStart('VoiceSample', 'generate', { characterId: id, characterName: char.name, episodeId: ep.id, voice: char.voiceStyle })
    const configId = body.config_id ? Number(body.config_id) : (ep.audioConfigId ?? undefined)
    const audioPath = await generateVoiceSample(char.name, char.voiceStyle, configId)
    db.update(schema.characters)
      .set({ voiceSampleUrl: audioPath, updatedAt: now() })
      .where(eq(schema.characters.id, id)).run()
    logTaskSuccess('VoiceSample', 'generate', { characterId: id, path: audioPath })
    return success(c, { voice_sample_url: audioPath })
  } catch (err: any) {
    logTaskError('VoiceSample', 'generate', { characterId: id, error: err.message })
    return badRequest(c, `TTS 生成失败: ${err.message}`)
  }
})

// POST /characters/:id/upload-voice-sample — 上传并设为当前角色声音样本
app.post('/:id/upload-voice-sample', async (c) => {
  const id = Number(c.req.param('id'))
  const [char] = db.select().from(schema.characters).where(eq(schema.characters.id, id)).all()
  if (!char) return badRequest(c, 'Character not found')
  const body = await c.req.parseBody()
  const file = body['file']
  if (!file || !(file instanceof File)) return badRequest(c, 'file is required')

  const buffer = await file.arrayBuffer()
  const localPath = await saveUploadedFile(buffer, 'audio', file.name)
  db.update(schema.characters)
    .set({
      voiceSampleUrl: localPath,
      voiceProvider: char.voiceProvider || 'uploaded',
      updatedAt: now(),
    })
    .where(eq(schema.characters.id, id))
    .run()
  return success(c, { voice_sample_url: localPath })
})

// POST /characters/:id/generate-image
app.post('/:id/generate-image', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json().catch(() => ({}))
  const [char] = db.select().from(schema.characters).where(eq(schema.characters.id, id)).all()
  if (!char) return badRequest(c, 'Character not found')

  let episodeId = Number(body.episode_id || 0)
  if (!episodeId) {
    const links = db.select().from(schema.episodeCharacters).all()
    const link = links.find((item) => item.characterId === id)
    if (link) episodeId = link.episodeId
  }
  let [ep]: any[] = episodeId
    ? db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all()
    : []
  if (!ep) {
    ;[ep] = db.select().from(schema.episodes).where(eq(schema.episodes.dramaId, char.dramaId)).all()
  }
  if (!ep) return badRequest(c, 'Episode not found')

  const prompt = buildCharacterReferencePrompt(char)
  try {
    logTaskStart('CharacterImage', 'generate', { characterId: id, episodeId: ep.id, dramaId: char.dramaId })
    const [drama] = db.select().from(schema.dramas).where(eq(schema.dramas.id, char.dramaId)).all()
    const genId = await generateImage({ characterId: id, dramaId: char.dramaId, prompt, size: orientationImageSize(dramaOrientation(drama)), configId: body.config_id || characterImageConfigId(drama, ep.imageConfigId) })
    logTaskSuccess('CharacterImage', 'generate', { characterId: id, generationId: genId })
    return success(c, { image_generation_id: genId })
  } catch (err: any) {
    logTaskError('CharacterImage', 'generate', { characterId: id, error: err.message })
    return badRequest(c, err.message)
  }
})

// POST /characters/batch-generate-images
app.post('/batch-generate-images', async (c) => {
  const body = await c.req.json()
  const ids: number[] = body.character_ids || []
  if (!body.episode_id) return badRequest(c, 'episode_id is required')
  const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, Number(body.episode_id))).all()
  if (!ep) return badRequest(c, 'Episode not found')
  const results: number[] = []
  const items: Array<{ character_id: number; image_generation_id: number }> = []
  for (const cid of ids) {
    const [char] = db.select().from(schema.characters).where(eq(schema.characters.id, cid)).all()
    if (!char) continue
    const prompt = buildCharacterReferencePrompt(char)
    try {
      const [drama] = db.select().from(schema.dramas).where(eq(schema.dramas.id, char.dramaId)).all()
      const genId = await generateImage({ characterId: cid, dramaId: char.dramaId, prompt, size: orientationImageSize(dramaOrientation(drama)), configId: body.config_id || characterImageConfigId(drama, ep.imageConfigId) })
      results.push(genId)
      items.push({ character_id: cid, image_generation_id: genId })
    } catch {}
  }
  logTaskSuccess('CharacterImage', 'batch-generate', { episodeId: ep.id, requested: ids.length, started: results.length })
  return success(c, { count: results.length, ids: results, items })
})

export default app
