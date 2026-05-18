/**
 * 分镜拆解 Agent 工具
 * 工厂函数模式 — 注入 episodeId + dramaId
 */
import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { db, schema } from '../../db/index.js'
import { eq } from 'drizzle-orm'
import { now } from '../../utils/response.js'
import { logTaskProgress, logTaskSuccess } from '../../utils/task-logger.js'

function syncStoryboardCharacters(storyboardId: number, characterIds: number[]) {
  db.delete(schema.storyboardCharacters)
    .where(eq(schema.storyboardCharacters.storyboardId, storyboardId))
    .run()

  const uniqueIds = [...new Set(characterIds.filter(Boolean))]
  if (!uniqueIds.length) return

  for (const characterId of uniqueIds) {
    db.insert(schema.storyboardCharacters).values({
      storyboardId,
      characterId,
    }).run()
  }
}

function getEpisodeSceneIds(episodeId: number) {
  return new Set(
    db.select().from(schema.episodeScenes)
      .where(eq(schema.episodeScenes.episodeId, episodeId)).all()
      .map(link => link.sceneId),
  )
}

function getEpisodeCharacterIds(episodeId: number) {
  return new Set(
    db.select().from(schema.episodeCharacters)
      .where(eq(schema.episodeCharacters.episodeId, episodeId)).all()
      .map(link => link.characterId),
  )
}

function extractDialogueSpeakers(dialogue?: string | null) {
  if (!dialogue) return []
  const speakers: string[] = []
  for (const line of dialogue.split(/\n+/)) {
    const match = line.trim().match(/^([^：:]{1,24})[：:]/)
    if (!match) continue
    const speaker = match[1]
      .replace(/[（(].*?[）)]/g, '')
      .replace(/[《》「」“”"'\s]/g, '')
      .trim()
    if (isValidDialogueSpeaker(speaker)) speakers.push(normalizeDialogueSpeakerName(speaker))
  }
  return [...new Set(speakers)]
}

function normalizeDialogueSpeakerName(name: string) {
  const cleaned = name
    .replace(/[（(].*?[）)]/g, '')
    .replace(/[《》「」“”"'\s]/g, '')
    .trim()
  if (/系统|叮[！!]?|认同值|任务|绑定|抹杀/.test(cleaned)) return '系统音'
  return cleaned
}

function isValidDialogueSpeaker(name: string) {
  const cleaned = normalizeDialogueSpeakerName(name)
  if (!cleaned) return false
  if (cleaned === '系统音') return true
  if (cleaned.length > 12) return false
  if (/[，。！？!?；;]/.test(cleaned)) return false
  return true
}

function shouldCreateVoiceOnlyCharacter(name: string) {
  const normalized = name.trim().toLowerCase()
  if (!normalized) return false
  if (/^[\d\s]+$/.test(normalized)) return false
  return true
}

function voiceOnlyStyleFor(name: string) {
  if (/系统音|系统提示|电子提示/.test(name)) {
    return '系统音，中性电子提示音，音调中等偏高，语速中等，吐字清晰，情绪克制，带有轻微科技感，适合系统绑定、任务提示和状态播报。'
  }
  if (/旁白|画外音|narrator|voiceover/i.test(name)) {
    return `${name}，清晰自然的叙述声音，语速中等，情绪克制但有故事感，吐字清楚，适合短剧旁白、画外解说和剧情信息传达。`
  }
  if (/记者|新闻|播报|广播|主持/.test(name)) {
    return `${name}，清晰稳重的播报声，吐字标准，语速中等偏稳，音色端正有职业感，适合新闻播报、现场报道或画外信息传达。`
  }
  if (/路人|群众|店员|服务员|保安|司机|护士|医生/.test(name)) {
    return `${name}，自然生活化的配角声音，语速中等，吐字清楚，情绪贴合剧情但不过度夸张，适合短剧临场对白。`
  }
  return `${name}，符合角色身份和剧情用途的中文配音声音，吐字清楚，情绪自然，语速中等，适合短剧对白或画外音。`
}

function ensureVoiceOnlyCharacter(episodeId: number, dramaId: number, name: string, ts: string) {
  if (!shouldCreateVoiceOnlyCharacter(name)) return null
  const existing = db.select().from(schema.characters)
    .where(eq(schema.characters.dramaId, dramaId)).all()
    .find(c => !c.deletedAt && c.name === name)

  const voiceRole = /系统音|系统提示|电子提示/.test(name)
    ? '系统声音角色'
    : (/旁白|画外音|narrator|voiceover/i.test(name)
      ? '旁白声音角色'
      : (/记者|新闻|播报|广播|主持/.test(name) ? '播报声音角色' : '声音角色'))
  let characterId = existing?.id
  if (existing) {
    const updates: Record<string, any> = { updatedAt: ts }
    if (!existing.voiceStyle) updates.voiceStyle = voiceOnlyStyleFor(name)
    if (!existing.role) updates.role = voiceRole
    if (!existing.appearance) updates.appearance = '仅声音角色，无需人物形象。'
    if (Object.keys(updates).length > 1) {
      db.update(schema.characters).set(updates).where(eq(schema.characters.id, existing.id)).run()
    }
  } else {
    characterId = Number(db.insert(schema.characters).values({
      dramaId,
      name,
      role: voiceRole,
      description: `${name}，仅用于配音的声音角色。`,
      appearance: '仅声音角色，无需人物形象。',
      personality: '',
      voiceStyle: voiceOnlyStyleFor(name),
      voiceProvider: 'custom-design',
      createdAt: ts,
      updatedAt: ts,
    }).run().lastInsertRowid)
  }
  if (!characterId) return null

  const linked = db.select().from(schema.episodeCharacters)
    .where(eq(schema.episodeCharacters.episodeId, episodeId)).all()
    .some(link => link.characterId === characterId)
  if (!linked) {
    db.insert(schema.episodeCharacters).values({
      episodeId,
      characterId,
      createdAt: ts,
    }).run()
  }
  return characterId
}

function isSystemDialogue(raw: string, fields: Record<string, any>) {
  const text = `${raw} ${fields.description || ''} ${fields.sound_effect || ''} ${fields.title || ''}`
  return /叮[！!]?|系统提示|系统音|认同值|任务完成|任务：|绑定|抹杀/.test(text)
}

function stripSpeakerDecorations(value: string) {
  return value.replace(/[（(].*?[）)]/g, '').trim()
}

function inferSpeakerFromDescription(description: string | undefined, characterNames: Set<string>) {
  const text = description?.trim() || ''
  if (!text) return ''
  const match = text.match(/^([^：:\n]{1,16})(?:[（(][^）)]{1,12}[）)])?[：:]/)
  if (!match) return ''
  const candidate = normalizeDialogueSpeakerName(stripSpeakerDecorations(match[1]))
  if (characterNames.has(candidate) || /旁白|画外音|记者|播报|广播|系统音/.test(candidate)) return candidate
  return ''
}

function normalizeStoryboardDialogue(sb: Record<string, any>, characterById: Map<number, any>, characterNames: Set<string>) {
  const raw = String(sb.dialogue || '').trim()
  if (!raw) return ''

  if (isSystemDialogue(raw, sb)) {
    return raw.startsWith('系统音：') || raw.startsWith('系统音:')
      ? raw
      : `系统音：${raw.replace(/^系统音[：:]\s*/, '').trim()}`
  }

  const explicit = raw.match(/^([^：:\n]{1,24})[：:]\s*(.+)$/s)
  if (explicit) {
    const speaker = normalizeDialogueSpeakerName(stripSpeakerDecorations(explicit[1]))
    if (isValidDialogueSpeaker(speaker)) return `${speaker}：${explicit[2].trim()}`
  }

  const byDescription = inferSpeakerFromDescription(sb.description, characterNames)
  if (byDescription) return `${byDescription}：${raw.replace(/^（.+?）\s*/, '').trim()}`

  const boundCharacters = (sb.character_ids || [])
    .map((id: number) => characterById.get(Number(id)))
    .filter(Boolean)
    .filter((char: any) => !/旁白|画外音|声音角色|系统音/.test(`${char.name || ''} ${char.role || ''}`))
  if (boundCharacters.length === 1) {
    return `${boundCharacters[0].name}：${raw.replace(/^（.+?）\s*/, '').trim()}`
  }

  return raw
}

function validateStoryboardBindings(episodeId: number, sceneId: number | null | undefined, characterIds: number[] | undefined) {
  const episodeSceneIds = getEpisodeSceneIds(episodeId)
  const episodeCharacterIds = getEpisodeCharacterIds(episodeId)

  if (sceneId != null && !episodeSceneIds.has(sceneId)) {
    throw new Error(`scene_id ${sceneId} 不属于当前集`)
  }

  const invalidCharacterIds = (characterIds || []).filter(id => !episodeCharacterIds.has(id))
  if (invalidCharacterIds.length) {
    throw new Error(`character_ids 不属于当前集: ${invalidCharacterIds.join(', ')}`)
  }
}

export function createStoryboardTools(episodeId: number, dramaId: number) {
  const readStoryboardContext = createTool({
    id: 'read_storyboard_context',
    description: 'Read the screenplay, characters, and scenes for storyboard breakdown.',
    inputSchema: z.object({}),
    execute: async () => {
      const [ep] = db.select().from(schema.episodes)
        .where(eq(schema.episodes.id, episodeId)).all()
      if (!ep) return { error: 'Episode not found' }
      const script = ep.scriptContent || ep.content
      if (!script) return { error: 'Episode has no script' }

      const charLinks = db.select().from(schema.episodeCharacters)
        .where(eq(schema.episodeCharacters.episodeId, episodeId)).all()
      const sceneLinks = db.select().from(schema.episodeScenes)
        .where(eq(schema.episodeScenes.episodeId, episodeId)).all()

      const linkedCharacterIds = new Set(charLinks.map(link => link.characterId))
      const linkedSceneIds = new Set(sceneLinks.map(link => link.sceneId))

      const chars = db.select().from(schema.characters)
        .where(eq(schema.characters.dramaId, dramaId)).all()
      const scns = db.select().from(schema.scenes)
        .where(eq(schema.scenes.dramaId, dramaId)).all()
      const existingStoryboards = db.select().from(schema.storyboards)
        .where(eq(schema.storyboards.episodeId, episodeId)).all()

      const characters = chars
        .filter(c => !c.deletedAt)
        .filter(c => !linkedCharacterIds.size || linkedCharacterIds.has(c.id))
        .map(c => ({
          id: c.id,
          name: c.name,
          role: c.role || '',
          description: c.description || '',
          appearance: c.appearance || '',
          personality: c.personality || '',
          voice_style: c.voiceStyle || '',
          image_url: c.imageUrl || '',
          reference_images: c.referenceImages || '',
        }))

      const scenes = scns
        .filter(s => !s.deletedAt)
        .filter(s => !linkedSceneIds.size || linkedSceneIds.has(s.id))
        .map(s => ({
          id: s.id,
          location: s.location,
          time: s.time,
          prompt: s.prompt || '',
          image_url: s.imageUrl || '',
          storyboard_count: s.storyboardCount || 0,
        }))

      const payload = {
        episode: {
          id: ep.id,
          title: ep.title,
          episode_number: ep.episodeNumber,
          description: ep.description || '',
        },
        script,
        characters,
        scenes,
        existing_storyboards: existingStoryboards
          .filter(sb => !sb.deletedAt)
          .map(sb => ({
            id: sb.id,
            shot_number: sb.storyboardNumber,
            title: sb.title || '',
            scene_id: sb.sceneId,
            character_ids: db.select().from(schema.storyboardCharacters)
              .where(eq(schema.storyboardCharacters.storyboardId, sb.id)).all()
              .map(link => link.characterId),
            shot_type: sb.shotType || '',
            duration: sb.duration || 0,
          })),
      }
      logTaskSuccess('StoryboardTool', 'read-context', {
        episodeId,
        dramaId,
        characters: characters.length,
        scenes: scenes.length,
        existingStoryboards: payload.existing_storyboards.length,
        scriptLength: script.length,
      })
      return payload
    },
  })

  const saveStoryboards = createTool({
    id: 'save_storyboards',
    description: 'Save generated storyboards. Replaces all existing storyboards for this episode.',
    inputSchema: z.object({
      storyboards: z.array(z.object({
        shot_number: z.number(),
        title: z.string().optional(),
        shot_type: z.string().optional(),
        angle: z.string().optional(),
        movement: z.string().optional(),
        location: z.string().optional(),
        time: z.string().optional(),
        action: z.string().optional(),
        dialogue: z.string().optional(),
        description: z.string().optional(),
        result: z.string().optional(),
        atmosphere: z.string().optional(),
        image_prompt: z.string().optional(),
        video_prompt: z.string().optional(),
        bgm_prompt: z.string().optional(),
        sound_effect: z.string().optional(),
        duration: z.number().optional(),
        scene_id: z.number().nullable().optional(),
        character_ids: z.array(z.number()).optional(),
      })),
    }),
    execute: async ({ storyboards }) => {
      const storyboardRows = storyboards as Array<any>
      const ts = now()
      logTaskProgress('StoryboardTool', 'save-begin', {
        episodeId,
        dramaId,
        count: storyboardRows.length,
        shotNumbers: storyboardRows.map((sb: any) => sb.shot_number).join(','),
      })
      const existingStoryboardIds = db.select().from(schema.storyboards)
        .where(eq(schema.storyboards.episodeId, episodeId)).all()
        .map(sb => sb.id)
      for (const storyboardId of existingStoryboardIds) {
        db.delete(schema.storyboardCharacters)
          .where(eq(schema.storyboardCharacters.storyboardId, storyboardId))
          .run()
      }
      db.delete(schema.storyboards).where(eq(schema.storyboards.episodeId, episodeId)).run()

      const allCharacters = db.select().from(schema.characters)
        .where(eq(schema.characters.dramaId, dramaId)).all()
        .filter(c => !c.deletedAt)
      const characterById = new Map(allCharacters.map(c => [c.id, c]))
      const characterNames = new Set(allCharacters.map(c => c.name))
      const normalizedRows = storyboardRows.map((sb: any) => ({
        ...sb,
        dialogue: normalizeStoryboardDialogue(sb, characterById, characterNames) || undefined,
      }))

      const voiceOnlyNames = [...new Set(normalizedRows.flatMap((sb: any) => extractDialogueSpeakers(sb.dialogue)))] as string[]
      for (const name of voiceOnlyNames) {
        ensureVoiceOnlyCharacter(episodeId, dramaId, name, ts)
      }

      let totalDuration = 0
      for (const sb of normalizedRows) {
        validateStoryboardBindings(episodeId, sb.scene_id, sb.character_ids)
        const res = db.insert(schema.storyboards).values({
          episodeId,
          storyboardNumber: sb.shot_number,
          title: sb.title, shotType: sb.shot_type,
          angle: sb.angle, movement: sb.movement,
          location: sb.location, time: sb.time,
          action: sb.action, dialogue: sb.dialogue,
          description: sb.description, result: sb.result,
          atmosphere: sb.atmosphere, imagePrompt: sb.image_prompt,
          videoPrompt: sb.video_prompt, bgmPrompt: sb.bgm_prompt,
          soundEffect: sb.sound_effect,
          sceneId: sb.scene_id, duration: sb.duration || 10,
          createdAt: ts, updatedAt: ts,
        }).run()
        syncStoryboardCharacters(Number(res.lastInsertRowid), sb.character_ids || [])
        totalDuration += sb.duration || 10
      }

      db.update(schema.episodes)
        .set({ duration: Math.ceil(totalDuration / 60), updatedAt: ts })
        .where(eq(schema.episodes.id, episodeId)).run()

      logTaskSuccess('StoryboardTool', 'save-complete', {
        episodeId,
        count: storyboards.length,
        totalDuration,
      })
      return { message: `Saved ${storyboards.length} storyboards`, count: storyboards.length, total_duration: totalDuration }
    },
  })

  const updateStoryboard = createTool({
    id: 'update_storyboard',
    description: 'Update a specific storyboard shot.',
    inputSchema: z.object({
      storyboard_id: z.number(),
      title: z.string().optional(),
      shot_type: z.string().optional(),
      angle: z.string().optional(),
      movement: z.string().optional(),
      location: z.string().optional(),
      time: z.string().optional(),
      action: z.string().optional(),
      result: z.string().optional(),
      atmosphere: z.string().optional(),
      image_prompt: z.string().optional(),
      video_prompt: z.string().optional(),
      bgm_prompt: z.string().optional(),
      sound_effect: z.string().optional(),
      description: z.string().optional(),
      dialogue: z.string().optional(),
      scene_id: z.number().nullable().optional(),
      character_ids: z.array(z.number()).optional(),
      duration: z.number().optional(),
    }),
    execute: async ({ storyboard_id, ...fields }) => {
      const [storyboard] = db.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboard_id)).all()
      if (!storyboard) return { error: `Storyboard ${storyboard_id} not found` }
      logTaskProgress('StoryboardTool', 'update-begin', {
        episodeId,
        storyboardId: storyboard_id,
        fields: Object.keys(fields),
      })

      validateStoryboardBindings(
        episodeId,
        'scene_id' in fields ? fields.scene_id : storyboard.sceneId,
        'character_ids' in fields
          ? fields.character_ids
          : db.select().from(schema.storyboardCharacters)
              .where(eq(schema.storyboardCharacters.storyboardId, storyboard_id)).all()
              .map(link => link.characterId),
      )

      const updates: Record<string, any> = { updatedAt: now() }
      if ('title' in fields) updates.title = fields.title
      if ('shot_type' in fields) updates.shotType = fields.shot_type
      if ('angle' in fields) updates.angle = fields.angle
      if ('movement' in fields) updates.movement = fields.movement
      if ('location' in fields) updates.location = fields.location
      if ('time' in fields) updates.time = fields.time
      if ('action' in fields) updates.action = fields.action
      if ('result' in fields) updates.result = fields.result
      if ('atmosphere' in fields) updates.atmosphere = fields.atmosphere
      if ('image_prompt' in fields) updates.imagePrompt = fields.image_prompt
      if ('video_prompt' in fields) updates.videoPrompt = fields.video_prompt
      if ('bgm_prompt' in fields) updates.bgmPrompt = fields.bgm_prompt
      if ('sound_effect' in fields) updates.soundEffect = fields.sound_effect
      if ('description' in fields) updates.description = fields.description
      if ('dialogue' in fields) updates.dialogue = fields.dialogue
      if ('scene_id' in fields) updates.sceneId = fields.scene_id
      if ('duration' in fields) updates.duration = fields.duration
      db.update(schema.storyboards).set(updates).where(eq(schema.storyboards.id, storyboard_id)).run()
      if ('character_ids' in fields) syncStoryboardCharacters(storyboard_id, fields.character_ids || [])
      logTaskSuccess('StoryboardTool', 'update-complete', {
        episodeId,
        storyboardId: storyboard_id,
        updatedFields: Object.keys(updates),
        characterIds: 'character_ids' in fields ? (fields.character_ids || []).join(',') : undefined,
      })
      return { message: `Storyboard ${storyboard_id} updated` }
    },
  })

  // 为宫格图生成整体提示词（分析选中镜头的描述，生成一个连贯的画格布局描述）
  const generateGridPrompt = createTool({
    id: 'generate_grid_prompt',
    description: '为宫格图生成整体画面描述。根据选中的镜头列表及其描述，生成一个连贯的宫格图提示词，用于一次性生成完整的宫格拼图。',
    inputSchema: z.object({
      shots: z.array(z.object({
        shot_number: z.number(),
        description: z.string(),
        shot_type: z.string().optional(),
        dialogue: z.string().optional(),
      })),
      rows: z.number(),
      cols: z.number(),
      mode: z.string(), // 'first_frame' | 'first_last' | 'multi_ref'
    }),
    execute: async ({ shots, rows, cols, mode }) => {
      if (!shots.length) return { error: 'No shots provided' }
      logTaskProgress('StoryboardTool', 'grid-prompt-begin', {
        episodeId,
        shots: shots.length,
        rows,
        cols,
        mode,
      })

      if (mode === 'multi_ref') {
        const sb = shots[0]
        const payload = {
          grid_prompt: `电影级高质量参考图，${sb.description}，专业摄影，电影质感，4K分辨率，${rows}x${cols} 宫格统一风格参考图`,
          cell_prompts: shots.map(s => ({
            shot_number: s.shot_number,
            frame_type: 'reference',
            prompt: `电影级高质量参考图，${s.description}，专业摄影，电影质感，4K分辨率，统一风格`,
          })),
        }
        logTaskSuccess('StoryboardTool', 'grid-prompt-complete', { episodeId, cells: payload.cell_prompts.length, mode })
        return payload
      }

      if (mode === 'first_last') {
        const cellPrompts = []
        for (const s of shots) {
          cellPrompts.push({
            shot_number: s.shot_number,
            frame_type: 'first_frame',
            prompt: `电影级高质量首帧，${s.description}，${s.shot_type || ''}，专业摄影，${rows}x${cols} 宫格风格统一`,
          })
          cellPrompts.push({
            shot_number: s.shot_number,
            frame_type: 'last_frame',
            prompt: `电影级高质量尾帧，${s.description}，${s.shot_type || ''}，专业摄影，${rows}x${cols} 宫格风格统一`,
          })
        }
        const payload = {
          grid_prompt: `${shots.length}个镜头首尾帧拼图，${shots.map(s => s.description).join(' | ')}，电影级画面，专业摄影，${rows}行${cols}列风格统一`,
          cell_prompts: cellPrompts,
        }
        logTaskSuccess('StoryboardTool', 'grid-prompt-complete', { episodeId, cells: payload.cell_prompts.length, mode })
        return payload
      }

      // first_frame mode
      const cellPrompts = shots.slice(0, rows * cols).map(s => ({
        shot_number: s.shot_number,
        frame_type: 'first_frame',
        prompt: `电影级高质量首帧，${s.description}，${s.shot_type || ''}，专业摄影，${rows}x${cols} 宫格风格统一`,
      }))
      const payload = {
        grid_prompt: `${shots.length}个镜头首帧拼图，${shots.map(s => s.description).join(' | ')}，电影级画面，专业摄影，${rows}行${cols}列风格统一`,
        cell_prompts: cellPrompts,
      }
      logTaskSuccess('StoryboardTool', 'grid-prompt-complete', { episodeId, cells: payload.cell_prompts.length, mode })
      return payload
    },
  })

  return { readStoryboardContext, saveStoryboards, updateStoryboard, generateGridPrompt }
}
