import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { success, badRequest, now } from '../utils/response.js'
import { generateVoiceSample } from '../services/tts-generation.js'
import { generateImage } from '../services/image-generation.js'
import { logTaskError, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'

const app = new Hono()

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
  const stableDescription = cleanStableCharacterText(char.description)
  const stablePersonality = cleanStableCharacterText(char.personality)
  const base = [
    `角色姓名：${char.name}`,
    char.role ? `角色定位：${char.role}` : '',
    stableAppearance ? `稳定外貌设定：${stableAppearance}` : '',
    stableDescription ? `人物基础设定：${stableDescription}` : '',
    stablePersonality ? `气质性格：${stablePersonality}` : '',
  ].filter(Boolean).join('，')
  return [
    base || `${char.name}，人物角色参考图`,
    '生成可跨集复用的角色设定参考图',
    '单人，清晰正面或三分之二侧身，五官清楚，表情自然中性，站姿稳定',
    '完整展示发型、发色、年龄感、身高体态、服装、国籍/地域气质、标志性配饰',
    '干净背景或浅色摄影棚背景，不要剧情动作，不要昏迷、受伤、倒地、哭泣、面容模糊，不要多人，不要文字水印',
    '高质量，电影感人物设定照',
  ].join('，')
}

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
  if (!char.voiceStyle) return badRequest(c, '请先分配音色')
  if (!body.episode_id) return badRequest(c, 'episode_id is required')

  const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, Number(body.episode_id))).all()
  if (!ep) return badRequest(c, 'Episode not found')

  try {
    logTaskStart('VoiceSample', 'generate', { characterId: id, characterName: char.name, episodeId: ep.id, voice: char.voiceStyle })
    const audioPath = await generateVoiceSample(char.name, char.voiceStyle, ep.audioConfigId ?? undefined)
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
    const genId = await generateImage({ characterId: id, dramaId: char.dramaId, prompt, configId: ep.imageConfigId ?? undefined })
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
  for (const cid of ids) {
    const [char] = db.select().from(schema.characters).where(eq(schema.characters.id, cid)).all()
    if (!char) continue
    const prompt = buildCharacterReferencePrompt(char)
    try {
      const genId = await generateImage({ characterId: cid, dramaId: char.dramaId, prompt, configId: ep.imageConfigId ?? undefined })
      results.push(genId)
    } catch {}
  }
  logTaskSuccess('CharacterImage', 'batch-generate', { episodeId: ep.id, requested: ids.length, started: results.length })
  return success(c, { count: results.length, ids: results })
})

export default app
