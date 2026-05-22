import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { success, created, now, badRequest } from '../utils/response.js'
import { toSnakeCase } from '../utils/transform.js'
import { generateTTS, voiceSampleText } from '../services/tts-generation.js'
import { saveUploadedFile } from '../utils/storage.js'
import { logTaskError, logTaskPayload, logTaskProgress, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'

const app = new Hono()

const IGNORE_TTS_SPEAKERS = /^(环境音|环境声|音效|效果音|sfx|sound ?effect|bgm|背景音|背景音乐|ambient)$/i
const IGNORE_TTS_TEXT = /^(无|无对白|无台词|无旁白|无需配音|无需对白|none|null|n\/a|na|环境音|环境声|音效|效果音|纯音效|纯环境音|只有环境音|仅环境音|背景音|背景音乐|bgm|sfx|ambient)$/i

function parseDialogueForTTS(dialogue?: string | null) {
  const raw = dialogue?.trim() || ''
  if (!raw) return { speaker: '', pureText: '', ignorable: true }
  const monologue = raw.match(/^[（(]\s*([^（）()：:\n]{1,24})\s*(?:独白说|独白|内心独白|内心OS|OS|心声|画外音|旁白)\s*[）)]\s*[：:]+\s*(.+)$/s)
  const speakerMatch = monologue || raw.match(/^([^：:\n]{1,24})[：:]+\s*(.+)$/s)
  const speaker = speakerMatch ? speakerMatch[1].replace(/[（(].+?[)）]/g, '').trim() : ''
  const pureText = speakerMatch
    ? speakerMatch[2].replace(/^[：:\s]+/, '').replace(/[（(].+?[)）]/g, '').trim()
    : raw.replace(/^.+?[:：]+\s*/, '').replace(/^[：:\s]+/, '').replace(/[（(].+?[)）]/g, '').trim()
  const ignorable = (!!speaker && IGNORE_TTS_SPEAKERS.test(speaker)) || !pureText || IGNORE_TTS_TEXT.test(pureText)
  return { speaker, pureText, ignorable }
}

function isGenericNarratorSpeaker(name?: string | null) {
  return /^(旁白|画外音|narrator|voiceover)$/i.test(String(name || '').trim())
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function isVoiceOnlyCharacter(char: any) {
  return /旁白|画外音|声音角色|系统音/i.test(`${char?.name || ''} ${char?.role || ''}`)
}

function getStoryboardCharacters(storyboardId: number, chars: any[]) {
  const ids = new Set(getStoryboardCharacterIds(storyboardId))
  return chars.filter((char: any) => ids.has(char.id) && !char.deletedAt)
}

function inferNarratorOwner(sb: any, chars: any[]) {
  const boundCharacters = getStoryboardCharacters(sb.id, chars).filter((char: any) => !isVoiceOnlyCharacter(char))
  if (boundCharacters.length === 1) return boundCharacters[0]

  const text = [
    sb.dialogue,
    sb.description,
    sb.action,
    sb.title,
    sb.result,
  ].filter(Boolean).join('\n')

  return boundCharacters.find((char: any) => {
    const name = escapeRegExp(String(char.name || ''))
    if (!name) return false
    const nameFirst = new RegExp(`${name}[^。！？!?\n]{0,12}(独白|内心|心声|画外音|旁白)`)
    const cueFirst = new RegExp(`(独白|内心|心声|画外音|旁白)[^。！？!?\n]{0,12}${name}`)
    return nameFirst.test(text) || cueFirst.test(text)
  }) || null
}

function resolveSpeakerCharacter(sb: any, speaker: string, chars: any[]) {
  if (isGenericNarratorSpeaker(speaker)) {
    const narratorOwner = inferNarratorOwner(sb, chars)
    if (narratorOwner) return narratorOwner
  }
  return chars.find((char: any) => !char.deletedAt && char.name === speaker) || null
}

function syncStoryboardCharacters(storyboardId: number, characterIds: number[]) {
  db.delete(schema.storyboardCharacters)
    .where(eq(schema.storyboardCharacters.storyboardId, storyboardId))
    .run()

  const uniqueIds = [...new Set((characterIds || []).filter(Boolean))]
  if (!uniqueIds.length) return

  for (const characterId of uniqueIds) {
    db.insert(schema.storyboardCharacters).values({
      storyboardId,
      characterId,
    }).run()
  }
}

function getStoryboardCharacterIds(storyboardId: number) {
  return db.select().from(schema.storyboardCharacters)
    .where(eq(schema.storyboardCharacters.storyboardId, storyboardId)).all()
    .map(link => link.characterId)
}

function activeDubbingRowsForStoryboard(storyboardId: number) {
  return db.select().from(schema.storyboardDubbings)
    .where(eq(schema.storyboardDubbings.storyboardId, storyboardId))
    .all()
    .filter((row: any) => !row.deletedAt)
    .sort((a: any, b: any) => (Number(a.sortOrder || 0) - Number(b.sortOrder || 0)) || (Number(a.id) - Number(b.id)))
}

function getStoryboardById(storyboardId: number) {
  return db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.id, storyboardId)).all()[0] || null
}

function getCharacterById(characterId?: number | null) {
  if (!characterId) return null
  return db.select().from(schema.characters)
    .where(eq(schema.characters.id, Number(characterId))).all()[0] || null
}

function nextDubbingSortOrder(storyboardId: number) {
  const rows = activeDubbingRowsForStoryboard(storyboardId)
  return rows.length ? Math.max(...rows.map((row: any) => Number(row.sortOrder || 0))) + 1 : 1
}

function seedEpisodeDubbings(episodeId: number) {
  const storyboards = db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId))
    .all()
    .filter((sb: any) => !sb.deletedAt)
  const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all()
  const chars = ep ? db.select().from(schema.characters).where(eq(schema.characters.dramaId, ep.dramaId)).all() : []
  const ts = now()

  for (const sb of storyboards as any[]) {
    if (activeDubbingRowsForStoryboard(sb.id).length) continue
    const parsed = parseDialogueForTTS(sb.dialogue)
    if (parsed.ignorable) continue
    const speakerCharacter = resolveSpeakerCharacter(sb, parsed.speaker, chars)
    db.insert(schema.storyboardDubbings).values({
      episodeId,
      storyboardId: sb.id,
      characterId: speakerCharacter?.id || null,
      speakerName: speakerCharacter?.name || parsed.speaker || '旁白',
      voiceId: speakerCharacter?.voiceStyle || null,
      text: parsed.pureText,
      sortOrder: 1,
      audioUrl: sb.ttsAudioUrl || null,
      status: sb.ttsAudioUrl ? 'completed' : 'pending',
      createdAt: ts,
      updatedAt: ts,
    }).run()
  }
}

function serializeDubbing(row: any) {
  const sb = getStoryboardById(row.storyboardId)
  const character = getCharacterById(row.characterId)
  return toSnakeCase({
    ...row,
    storyboardNumber: sb?.storyboardNumber,
    storyboardTitle: sb?.title,
    storyboardDuration: sb?.duration,
    characterName: character?.name || row.speakerName || '',
  })
}

function episodeDubbingRows(episodeId: number) {
  seedEpisodeDubbings(episodeId)
  const storyboards = db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId))
    .all()
    .filter((sb: any) => !sb.deletedAt)
  const storyboardOrder = new Map(storyboards.map((sb: any) => [Number(sb.id), Number(sb.storyboardNumber || 0)]))
  return db.select().from(schema.storyboardDubbings)
    .where(eq(schema.storyboardDubbings.episodeId, episodeId))
    .all()
    .filter((row: any) => !row.deletedAt)
    .sort((a: any, b: any) => {
      const shotDiff = (storyboardOrder.get(Number(a.storyboardId)) || 0) - (storyboardOrder.get(Number(b.storyboardId)) || 0)
      return shotDiff || (Number(a.sortOrder || 0) - Number(b.sortOrder || 0)) || (Number(a.id) - Number(b.id))
    })
}

async function generateDubbingAudio(row: any, configId?: number | null) {
  const sb = getStoryboardById(row.storyboardId)
  if (!sb) throw new Error('镜头不存在')
  const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, sb.episodeId)).all()
  const character = getCharacterById(row.characterId)
  const text = String(row.text || '').trim()
  if (!text || IGNORE_TTS_TEXT.test(text)) throw new Error('该配音没有可生成的文本')

  const voiceId = row.voiceId || character?.voiceStyle || 'alloy'
  if (character?.voiceProvider === 'custom-design' && !character.voiceSampleUrl) {
    throw new Error(`角色「${character.name}」已有声音设计，但还没有声音样本。请先生成或上传角色声音样本。`)
  }
  const audioPath = await generateTTS({
    text,
    voice: voiceId,
    purpose: character?.voiceSampleUrl ? 'clone' : undefined,
    instruct: character?.voiceStyle || voiceId,
    refText: character ? voiceSampleText(character.name) : undefined,
    referenceAudioUrl: character?.voiceSampleUrl || null,
    configId: configId ? Number(configId) : (ep?.audioConfigId || null),
  })
  db.update(schema.storyboardDubbings)
    .set({ audioUrl: audioPath, voiceId, status: 'completed', updatedAt: now() })
    .where(eq(schema.storyboardDubbings.id, row.id))
    .run()

  const rows = activeDubbingRowsForStoryboard(row.storyboardId)
  if (rows.length === 1) {
    db.update(schema.storyboards)
      .set({ ttsAudioUrl: audioPath, updatedAt: now() })
      .where(eq(schema.storyboards.id, row.storyboardId))
      .run()
  }
  return audioPath
}

function validateStoryboardBindings(episodeId: number, sceneId: number | null | undefined, characterIds: number[] | undefined) {
  const episodeSceneIds = new Set(
    db.select().from(schema.episodeScenes)
      .where(eq(schema.episodeScenes.episodeId, episodeId)).all()
      .map(link => link.sceneId),
  )
  const episodeCharacterIds = new Set(
    db.select().from(schema.episodeCharacters)
      .where(eq(schema.episodeCharacters.episodeId, episodeId)).all()
      .map(link => link.characterId),
  )

  if (sceneId != null && !episodeSceneIds.has(sceneId)) {
    throw new Error('scene_id 必须来自当前集已关联场景')
  }

  const invalidCharacterIds = (characterIds || []).filter(id => !episodeCharacterIds.has(id))
  if (invalidCharacterIds.length) {
    throw new Error('character_ids 必须来自当前集已关联角色')
  }
}

function nextInsertedStoryboardNumber(afterStoryboard: any) {
  const baseNumber = Number(afterStoryboard?.storyboardNumber || 0)
  if (!Number.isFinite(baseNumber) || baseNumber <= 0) return null
  const root = Math.trunc(baseNumber)
  const rows = db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, afterStoryboard.episodeId))
    .orderBy(schema.storyboards.storyboardNumber)
    .all()
    .filter((row: any) => !row.deletedAt)
  const existingSubIndexes = rows
    .map((row: any) => Number(row.storyboardNumber))
    .filter((num: number) => Number.isFinite(num) && Math.trunc(num) === root && num > root && num < root + 1)
    .map((num: number) => Math.round((num - root) * 100))
    .filter((num: number) => Number.isFinite(num) && num > 0)
  const nextSubIndex = existingSubIndexes.length ? Math.max(...existingSubIndexes) + 1 : 1
  return root + (nextSubIndex / 100)
}

function formatStoryboardNumber(number: number) {
  const base = Math.trunc(number)
  const sub = Math.round((number - base) * 100)
  const baseLabel = String(base || 1).padStart(2, '0')
  return sub > 0 ? `${baseLabel}-${String(sub).padStart(2, '0')}` : baseLabel
}

// GET /storyboards/episodes/:id/dubbings — 当前集配音明细
app.get('/episodes/:id/dubbings', async (c) => {
  const episodeId = Number(c.req.param('id'))
  const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all()
  if (!ep) return badRequest(c, 'Episode not found')
  return success(c, episodeDubbingRows(episodeId).map(serializeDubbing))
})

// POST /storyboards/dubbings — 新增/插入配音明细
app.post('/dubbings', async (c) => {
  const body = await c.req.json()
  const storyboardId = Number(body.storyboard_id || body.storyboardId || 0)
  const [sb] = db.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboardId)).all()
  if (!sb) return badRequest(c, '镜头不存在')
  const episodeId = Number(body.episode_id || body.episodeId || sb.episodeId)
  if (episodeId !== Number(sb.episodeId)) return badRequest(c, '配音镜头不属于当前集')

  let sortOrder = nextDubbingSortOrder(storyboardId)
  if (body.insert_after_id || body.insertAfterId) {
    const afterId = Number(body.insert_after_id || body.insertAfterId)
    const [after] = db.select().from(schema.storyboardDubbings).where(eq(schema.storyboardDubbings.id, afterId)).all()
    if (after && Number(after.storyboardId) === storyboardId) {
      sortOrder = Number(after.sortOrder || 0) + 1
      for (const row of activeDubbingRowsForStoryboard(storyboardId).filter((item: any) => Number(item.sortOrder || 0) >= sortOrder)) {
        db.update(schema.storyboardDubbings)
          .set({ sortOrder: Number(row.sortOrder || 0) + 1, updatedAt: now() })
          .where(eq(schema.storyboardDubbings.id, row.id))
          .run()
      }
    }
  }

  const character = getCharacterById(body.character_id || body.characterId)
  const speakerName = String(body.speaker_name || body.speakerName || character?.name || '旁白').trim()
  const text = String(body.text || '').trim()
  if (!text) return badRequest(c, '配音文本不能为空')
  const ts = now()
  const res = db.insert(schema.storyboardDubbings).values({
    episodeId,
    storyboardId,
    characterId: character?.id || null,
    speakerName,
    voiceId: body.voice_id || body.voiceId || character?.voiceStyle || null,
    text,
    sortOrder,
    status: 'pending',
    createdAt: ts,
    updatedAt: ts,
  }).run()
  const [row] = db.select().from(schema.storyboardDubbings).where(eq(schema.storyboardDubbings.id, Number(res.lastInsertRowid))).all()
  return created(c, serializeDubbing(row))
})

// PUT /storyboards/dubbings/:id — 更新配音明细
app.put('/dubbings/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json()
  const [row] = db.select().from(schema.storyboardDubbings).where(eq(schema.storyboardDubbings.id, id)).all()
  if (!row || row.deletedAt) return badRequest(c, '配音不存在')

  const updates: Record<string, any> = { updatedAt: now() }
  if ('storyboard_id' in body || 'storyboardId' in body) {
    const storyboardId = Number(body.storyboard_id || body.storyboardId)
    const [sb] = db.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboardId)).all()
    if (!sb || Number(sb.episodeId) !== Number(row.episodeId)) return badRequest(c, '配音镜头不属于当前集')
    updates.storyboardId = storyboardId
    updates.sortOrder = nextDubbingSortOrder(storyboardId)
  }
  if ('character_id' in body || 'characterId' in body) {
    const character = getCharacterById(body.character_id || body.characterId)
    updates.characterId = character?.id || null
    updates.speakerName = character?.name || body.speaker_name || body.speakerName || row.speakerName
    updates.voiceId = body.voice_id || body.voiceId || character?.voiceStyle || null
    updates.audioUrl = null
    updates.status = 'pending'
  }
  if ('speaker_name' in body || 'speakerName' in body) updates.speakerName = String(body.speaker_name || body.speakerName || '').trim()
  if ('voice_id' in body || 'voiceId' in body) {
    updates.voiceId = body.voice_id || body.voiceId || null
    updates.audioUrl = null
    updates.status = 'pending'
  }
  if ('text' in body) {
    updates.text = String(body.text || '').trim()
    updates.audioUrl = null
    updates.status = 'pending'
  }
  if ('sort_order' in body || 'sortOrder' in body) updates.sortOrder = Number(body.sort_order || body.sortOrder || row.sortOrder || 1)
  db.update(schema.storyboardDubbings).set(updates).where(eq(schema.storyboardDubbings.id, id)).run()
  const [updated] = db.select().from(schema.storyboardDubbings).where(eq(schema.storyboardDubbings.id, id)).all()
  return success(c, serializeDubbing(updated))
})

// DELETE /storyboards/dubbings/:id
app.delete('/dubbings/:id', async (c) => {
  const id = Number(c.req.param('id'))
  db.update(schema.storyboardDubbings)
    .set({ deletedAt: now(), updatedAt: now() })
    .where(eq(schema.storyboardDubbings.id, id))
    .run()
  return success(c)
})

// POST /storyboards/dubbings/:id/generate-tts
app.post('/dubbings/:id/generate-tts', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json().catch(() => ({}))
  const [row] = db.select().from(schema.storyboardDubbings).where(eq(schema.storyboardDubbings.id, id)).all()
  if (!row || row.deletedAt) return badRequest(c, '配音不存在')
  try {
    db.update(schema.storyboardDubbings).set({ status: 'processing', updatedAt: now() }).where(eq(schema.storyboardDubbings.id, id)).run()
    const audioPath = await generateDubbingAudio(row, body.config_id || body.configId || null)
    const [updated] = db.select().from(schema.storyboardDubbings).where(eq(schema.storyboardDubbings.id, id)).all()
    return success(c, { ...serializeDubbing(updated), audio_url: audioPath })
  } catch (err: any) {
    db.update(schema.storyboardDubbings).set({ status: 'failed', updatedAt: now() }).where(eq(schema.storyboardDubbings.id, id)).run()
    return badRequest(c, err.message)
  }
})

// POST /storyboards
app.post('/', async (c) => {
  const body = await c.req.json()
  const ts = now()
  let storyboardNumber = Number(body.storyboard_number || 1)
  let insertAfter: any = null
  if (body.insert_after_id) {
    ;[insertAfter] = db.select().from(schema.storyboards)
      .where(eq(schema.storyboards.id, Number(body.insert_after_id)))
      .all()
    if (!insertAfter) return badRequest(c, '插入位置不存在')
    if (Number(insertAfter.episodeId) !== Number(body.episode_id)) return badRequest(c, '插入位置不属于当前集')
    storyboardNumber = nextInsertedStoryboardNumber(insertAfter) || storyboardNumber
  }
  logTaskStart('StoryboardAPI', 'create', {
    episodeId: body.episode_id,
    shotNumber: storyboardNumber,
    insertAfterId: body.insert_after_id,
    sceneId: body.scene_id,
    characterIds: body.character_ids,
  })
  logTaskPayload('StoryboardAPI', 'create body', body)
  validateStoryboardBindings(body.episode_id, body.scene_id, body.character_ids)
  const res = db.insert(schema.storyboards).values({
    episodeId: body.episode_id,
    storyboardNumber,
    title: body.title || `镜头${formatStoryboardNumber(storyboardNumber)}`,
    description: body.description,
    action: body.action,
    dialogue: body.dialogue,
    sceneId: body.scene_id,
    duration: body.duration || 10,
    createdAt: ts,
    updatedAt: ts,
  }).run()
  syncStoryboardCharacters(Number(res.lastInsertRowid), body.character_ids || [])
  const [result] = db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.id, Number(res.lastInsertRowid))).all()
  logTaskSuccess('StoryboardAPI', 'create', {
    storyboardId: result.id,
    episodeId: result.episodeId,
    shotNumber: result.storyboardNumber,
  })
  return created(c, {
    ...toSnakeCase(result),
    character_ids: getStoryboardCharacterIds(result.id),
  })
})

// PUT /storyboards/:id
app.put('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json()
  const [storyboard] = db.select().from(schema.storyboards).where(eq(schema.storyboards.id, id)).all()
  if (!storyboard) return badRequest(c, '镜头不存在')
  logTaskStart('StoryboardAPI', 'update', {
    storyboardId: id,
    episodeId: storyboard.episodeId,
    fields: Object.keys(body),
  })
  logTaskPayload('StoryboardAPI', 'update body', body)

  const fieldMap: Record<string, string> = {
    title: 'title', description: 'description', shot_type: 'shotType',
    angle: 'angle', movement: 'movement', action: 'action',
    dialogue: 'dialogue', duration: 'duration', video_prompt: 'videoPrompt',
    image_prompt: 'imagePrompt', scene_id: 'sceneId', location: 'location',
    time: 'time', atmosphere: 'atmosphere', result: 'result',
    bgm_prompt: 'bgmPrompt', sound_effect: 'soundEffect',
  }

  const updates: Record<string, any> = { updatedAt: now() }
  for (const [snakeKey, camelKey] of Object.entries(fieldMap)) {
    if (snakeKey in body) updates[camelKey] = body[snakeKey]
  }

  if ('dialogue' in body) {
    updates.ttsAudioUrl = null
    updates.subtitleUrl = null
  }

  validateStoryboardBindings(
    storyboard.episodeId,
    'scene_id' in body ? body.scene_id : storyboard.sceneId,
    'character_ids' in body ? body.character_ids : getStoryboardCharacterIds(id),
  )

  db.update(schema.storyboards).set(updates).where(eq(schema.storyboards.id, id)).run()
  if ('character_ids' in body) syncStoryboardCharacters(id, body.character_ids || [])
  logTaskSuccess('StoryboardAPI', 'update', {
    storyboardId: id,
    updatedFields: Object.keys(updates),
    characterIds: body.character_ids,
  })
  return success(c)
})

// POST /storyboards/:id/generate-tts
app.post('/:id/generate-tts', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json().catch(() => ({}))
  const [sb] = db.select().from(schema.storyboards).where(eq(schema.storyboards.id, id)).all()
  if (!sb) return badRequest(c, '镜头不存在')
  const parsedDialogue = parseDialogueForTTS(sb.dialogue)
  if (parsedDialogue.ignorable) return badRequest(c, '该镜头没有可生成的对白或旁白')
  logTaskStart('StoryboardAPI', 'generate-tts', {
    storyboardId: id,
    episodeId: sb.episodeId,
    dialoguePreview: (sb.dialogue || '').slice(0, 40),
  })
  logTaskPayload('StoryboardAPI', 'generate-tts input', {
    storyboardId: id,
    episodeId: sb.episodeId,
    dialogue: sb.dialogue,
  })

  let voiceId = 'alloy'
  let speakerCharacter: any = null
  const speaker = parsedDialogue.speaker

  if (speaker) {
    const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, sb.episodeId)).all()
    if (ep) {
      const chars = db.select().from(schema.characters).where(eq(schema.characters.dramaId, ep.dramaId)).all()
      const found = resolveSpeakerCharacter(sb, speaker, chars)
      if (found) speakerCharacter = found
      if (found?.voiceStyle) voiceId = found.voiceStyle
    }
  }

  const pureDialogue = parsedDialogue.pureText
  if (!pureDialogue) return badRequest(c, '未提取到可合成的文本')

  const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, sb.episodeId)).all()
  try {
    if (speakerCharacter?.voiceProvider === 'custom-design' && !speakerCharacter.voiceSampleUrl) {
      return badRequest(c, `角色「${speakerCharacter.name}」已有声音设计，但还没有声音样本。请先生成或上传角色声音样本。`)
    }
    const audioPath = await generateTTS({
      text: pureDialogue,
      voice: voiceId,
      purpose: speakerCharacter?.voiceSampleUrl ? 'clone' : undefined,
      instruct: speakerCharacter?.voiceStyle || voiceId,
      refText: speakerCharacter ? voiceSampleText(speakerCharacter.name) : undefined,
      referenceAudioUrl: speakerCharacter?.voiceSampleUrl || null,
      configId: body.config_id ? Number(body.config_id) : (ep?.audioConfigId || null),
    })
  db.update(schema.storyboards)
    .set({ ttsAudioUrl: audioPath, updatedAt: now() })
    .where(eq(schema.storyboards.id, id))
    .run()

    logTaskSuccess('StoryboardAPI', 'generate-tts', {
      storyboardId: id,
      voiceId,
      path: audioPath,
      textLength: pureDialogue.length,
    })
    return success(c, { tts_audio_url: audioPath, voice_id: voiceId, text: pureDialogue })
  } catch (err: any) {
    logTaskError('StoryboardAPI', 'generate-tts', { storyboardId: id, voiceId, error: err.message })
    return badRequest(c, err.message)
  }
})

// POST /storyboards/:id/upload-frame — 上传首帧/尾帧并绑定到镜头
app.post('/:id/upload-frame', async (c) => {
  const id = Number(c.req.param('id'))
  const [sb] = db.select().from(schema.storyboards).where(eq(schema.storyboards.id, id)).all()
  if (!sb) return badRequest(c, '镜头不存在')

  const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, sb.episodeId)).all()
  if (!ep) return badRequest(c, 'Episode not found')

  const body = await c.req.parseBody()
  const file = body['file']
  const frameType = String(body['frame_type'] || body['frameType'] || 'first_frame')
  if (!file || !(file instanceof File)) return badRequest(c, 'file is required')
  if (!['first_frame', 'last_frame'].includes(frameType)) return badRequest(c, 'frame_type must be first_frame or last_frame')

  const buffer = await file.arrayBuffer()
  const localPath = await saveUploadedFile(buffer, 'images', file.name)
  const ts = now()
  db.insert(schema.imageGenerations).values({
    dramaId: ep.dramaId,
    storyboardId: id,
    imageType: 'storyboard',
    frameType,
    provider: 'manual',
    prompt: frameType === 'first_frame' ? '用户上传镜头首帧' : '用户上传镜头尾帧',
    imageUrl: localPath,
    localPath,
    status: 'completed',
    createdAt: ts,
    updatedAt: ts,
    completedAt: ts,
  }).run()
  const updates: Record<string, any> = { updatedAt: ts }
  if (frameType === 'first_frame') updates.firstFrameImage = localPath
  else updates.lastFrameImage = localPath
  db.update(schema.storyboards).set(updates).where(eq(schema.storyboards.id, id)).run()
  return success(c, frameType === 'first_frame' ? { first_frame_image: localPath } : { last_frame_image: localPath })
})

// POST /storyboards/:id/upload-video — 上传镜头视频并绑定到镜头
app.post('/:id/upload-video', async (c) => {
  const id = Number(c.req.param('id'))
  const [sb] = db.select().from(schema.storyboards).where(eq(schema.storyboards.id, id)).all()
  if (!sb) return badRequest(c, '镜头不存在')

  const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, sb.episodeId)).all()
  if (!ep) return badRequest(c, 'Episode not found')

  const body = await c.req.parseBody()
  const file = body['file']
  if (!file || !(file instanceof File)) return badRequest(c, 'file is required')

  const buffer = await file.arrayBuffer()
  const localPath = await saveUploadedFile(buffer, 'videos', file.name)
  const ts = now()
  db.insert(schema.videoGenerations).values({
    dramaId: ep.dramaId,
    storyboardId: id,
    provider: 'manual',
    prompt: '用户上传镜头视频',
    videoUrl: localPath,
    localPath,
    status: 'completed',
    duration: sb.duration || undefined,
    createdAt: ts,
    updatedAt: ts,
    completedAt: ts,
  }).run()
  db.update(schema.storyboards)
    .set({ videoUrl: localPath, updatedAt: ts })
    .where(eq(schema.storyboards.id, id))
    .run()
  return success(c, { video_url: localPath })
})

// DELETE /storyboards/:id
app.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  logTaskStart('StoryboardAPI', 'delete', { storyboardId: id })
  db.delete(schema.storyboardCharacters).where(eq(schema.storyboardCharacters.storyboardId, id)).run()
  db.update(schema.storyboardDubbings).set({ deletedAt: now(), updatedAt: now() }).where(eq(schema.storyboardDubbings.storyboardId, id)).run()
  db.delete(schema.storyboards).where(eq(schema.storyboards.id, id)).run()
  logTaskSuccess('StoryboardAPI', 'delete', { storyboardId: id })
  return success(c)
})

export default app
