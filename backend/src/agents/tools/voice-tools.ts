/**
 * 角色声音设计 Agent 工具
 */
import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { db, schema } from '../../db/index.js'
import { eq } from 'drizzle-orm'
import { now } from '../../utils/response.js'
import { logTaskProgress, logTaskSuccess } from '../../utils/task-logger.js'

const VOICE_PROVIDER_DESIGN = 'custom-design'

export function createVoiceTools(episodeId: number, dramaId: number) {
  function getEpisodeCharacterIds() {
    return new Set(
      db.select().from(schema.episodeCharacters)
        .where(eq(schema.episodeCharacters.episodeId, episodeId))
        .all()
        .map(link => link.characterId),
    )
  }

  const getCharacters = createTool({
    id: 'get_characters',
    description: 'Get characters for voice design. Includes stable character profile and existing voice design prompt.',
    inputSchema: z.object({
      scope: z.enum(['episode', 'drama']).optional().describe('episode: only current episode characters; drama: all drama characters'),
    }),
    execute: async ({ scope = 'episode' }) => {
      const episodeCharacterIds = getEpisodeCharacterIds()
      const chars = db.select().from(schema.characters)
        .where(eq(schema.characters.dramaId, dramaId)).all()
        .filter(c => scope === 'drama' || episodeCharacterIds.has(c.id))

      const payload = {
        scope,
        characters: chars.map(c => ({
          id: c.id,
          name: c.name,
          role: c.role,
          appearance: c.appearance,
          personality: c.personality,
          description: c.description,
          current_voice_prompt: c.voiceStyle || '',
          current_voice_provider: c.voiceProvider || '',
          current_voice_sample_url: c.voiceSampleUrl || '',
        })),
      }
      logTaskSuccess('VoiceTool', 'get-characters', { episodeId, dramaId, scope, count: payload.characters.length })
      return payload
    },
  })

  const getVoiceDesignGuide = createTool({
    id: 'get_voice_design_guide',
    description: 'Get voice design dimensions and examples for generating character voice prompts.',
    inputSchema: z.object({}),
    execute: async () => ({
      dimensions: [
        { name: '性别', examples: ['男性', '女性', '中性'] },
        { name: '年龄', examples: ['儿童 5-12岁', '青少年 13-18岁', '青年 19-35岁', '中年 36-55岁', '老年 55岁以上'] },
        { name: '音调', examples: ['高音', '中音', '低音', '偏高', '偏低'] },
        { name: '语速', examples: ['快速', '中速', '缓慢', '偏快', '偏慢'] },
        { name: '情感', examples: ['开朗', '沉稳', '温柔', '严肃', '活泼', '冷静', '治愈'] },
        { name: '特点', examples: ['有磁性', '清脆', '沙哑', '圆润', '甜美', '浑厚', '有力'] },
        { name: '用途', examples: ['短剧对白', '旁白', '动画角色', '纪录片解说', '有声书朗读'] },
      ],
      good_examples: [
        '年轻活泼的女性声音，语速较快，带有明显的上扬语调，适合介绍时尚产品。',
        '沉稳的中年男性，语速缓慢，音色低沉有磁性，适合朗读新闻或纪录片解说。',
        '可爱的儿童声音，大约8岁女孩，说话略带稚气，适合动画角色配音。',
        '温柔知性的女性，30岁左右，语调平和，适合有声书朗读。',
      ],
      bad_examples: [
        '好听的声音',
        '像某明星的声音',
        '非常非常非常好听的女声',
        '123456',
      ],
    }),
  })

  const saveVoiceDesign = createTool({
    id: 'save_voice_design',
    description: 'Save a custom voice design prompt for one character. This does not generate audio yet.',
    inputSchema: z.object({
      character_id: z.number().describe('Character ID'),
      voice_prompt: z.string().min(8).describe('Concrete Chinese voice design prompt for TTS design workflow'),
      reason: z.string().optional().describe('Why this voice design fits the character'),
    }),
    execute: async ({ character_id, voice_prompt, reason }) => {
      const trimmedPrompt = voice_prompt.trim()
      logTaskProgress('VoiceTool', 'design-save-begin', { episodeId, dramaId, characterId: character_id, promptPreview: trimmedPrompt.slice(0, 60), reason })
      db.update(schema.characters)
        .set({
          voiceStyle: trimmedPrompt,
          voiceProvider: VOICE_PROVIDER_DESIGN,
          voiceSampleUrl: null,
          updatedAt: now(),
        })
        .where(eq(schema.characters.id, character_id))
        .run()
      logTaskSuccess('VoiceTool', 'design-save-complete', { episodeId, characterId: character_id })
      return { message: `Saved voice design for character ${character_id}`, voice_prompt: trimmedPrompt, reason }
    },
  })

  // 兼容旧 prompt 里的 assign_voice；现在它保存的是声音设计提示词，不再保存在线 voice_id。
  const assignVoice = createTool({
    id: 'assign_voice',
    description: 'Compatibility alias. Save a custom voice design prompt for one character.',
    inputSchema: z.object({
      character_id: z.number().describe('Character ID'),
      voice_id: z.string().describe('Voice design prompt. Legacy name kept for compatibility.'),
      reason: z.string().optional().describe('Why this voice design fits'),
    }),
    execute: async ({ character_id, voice_id, reason }) => {
      const trimmedPrompt = voice_id.trim()
      db.update(schema.characters)
        .set({
          voiceStyle: trimmedPrompt,
          voiceProvider: VOICE_PROVIDER_DESIGN,
          voiceSampleUrl: null,
          updatedAt: now(),
        })
        .where(eq(schema.characters.id, character_id))
        .run()
      logTaskSuccess('VoiceTool', 'assign-compat-complete', { episodeId, characterId: character_id })
      return { message: `Saved voice design for character ${character_id}`, voice_prompt: trimmedPrompt, reason }
    },
  })

  return { getCharacters, getVoiceDesignGuide, saveVoiceDesign, assignVoice }
}
