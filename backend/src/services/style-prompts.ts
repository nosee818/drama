import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { now } from '../utils/response.js'

export type StylePromptItem = {
  key: string
  label: string
  prompt: string
  builtIn?: boolean
}

const STYLE_AGENT_TYPE = 'style_prompts'

export const defaultStylePrompts: StylePromptItem[] = [
  {
    key: 'none',
    label: '无风格',
    prompt: '',
    builtIn: true,
  },
  {
    key: 'custom',
    label: '自定义风格',
    prompt: '',
    builtIn: true,
  },
  {
    key: 'realistic',
    label: '写实',
    prompt: '写实影视摄影风格，真实人物与真实环境，电影级布光，自然肤色，细节清晰，高质量商业剧照质感，不要文字、水印、海报排版',
    builtIn: true,
  },
  {
    key: 'anime',
    label: '动漫',
    prompt: '高质量动漫番剧风格，二次元画面风格，干净线稿，精致赛璐璐上色，柔和阴影，动漫电影分镜质感，保持画面和场景为动画绘制效果，不要真人摄影质感，不要文字、水印',
    builtIn: true,
  },
  {
    key: 'ghibli',
    label: '吉卜力',
    prompt: '温暖手绘动画电影风格，柔和自然光，细腻背景美术，水彩感色彩，画面温柔、有空气感、童话现实主义，不要真人摄影质感，不要文字、水印',
    builtIn: true,
  },
  {
    key: 'cinematic',
    label: '电影感',
    prompt: '电影级视觉风格，专业影视灯光，宽容度高，构图稳定，镜头语言明确，真实质感，浅景深，色彩分级，高质量剧照，不要文字、水印',
    builtIn: true,
  },
  {
    key: 'comic',
    label: '漫画',
    prompt: '高质量漫画插画风格，清晰线条，戏剧化构图，块面阴影，强烈视觉张力，画面像精修漫画分镜，不要真人摄影质感，不要文字、水印、对白气泡',
    builtIn: true,
  },
  {
    key: 'watercolor',
    label: '水彩',
    prompt: '精致水彩插画风格，透明叠色，纸张纹理，柔和边缘，清透光影，温柔色彩，画面自然留白，高质量绘本质感，不要真人摄影质感，不要文字、水印',
    builtIn: true,
  },
]

function safeJson(value?: string | null) {
  try {
    return JSON.parse(value || '{}') || {}
  } catch {
    return {}
  }
}

export function normalizeStyleKey(value?: string | null) {
  const key = String(value || '').trim().toLowerCase()
  if (!key) return 'realistic'
  if (['none', 'no_style', 'nostyle', '无风格'].includes(key)) return 'none'
  if (['landscape', 'portrait'].includes(key)) return 'realistic'
  return key
}

export function getStylePromptConfig(): StylePromptItem[] {
  const [row] = db.select().from(schema.agentConfigs)
    .where(eq(schema.agentConfigs.agentType, STYLE_AGENT_TYPE))
    .all()
  const saved = safeJson(row?.systemPrompt)
  const savedItems = Array.isArray(saved?.items) ? saved.items : Array.isArray(saved) ? saved : []
  const savedByKey = new Map<string, any>(
    savedItems
      .map((item: any) => [normalizeStyleKey(item?.key), item])
      .filter(([key]) => !!key) as any,
  )

  const merged = defaultStylePrompts.map((item) => ({
    ...item,
    label: String(savedByKey.get(item.key)?.label || item.label),
    prompt: String(savedByKey.get(item.key)?.prompt ?? item.prompt),
  }))

  for (const [key, item] of savedByKey.entries()) {
    if (merged.some(existing => existing.key === key)) continue
    merged.push({
      key,
      label: String(item.label || key),
      prompt: String(item.prompt || ''),
      builtIn: false,
    })
  }

  return merged
}

export function saveStylePromptConfig(items: StylePromptItem[]) {
  const ts = now()
  const normalized = items
    .map(item => ({
      key: normalizeStyleKey(item.key),
      label: String(item.label || item.key || '').trim(),
      prompt: String(item.prompt || '').trim(),
      builtIn: !!item.builtIn,
    }))
    .filter(item => item.key && item.label)

  const payload = JSON.stringify({ items: normalized }, null, 2)
  const [existing] = db.select().from(schema.agentConfigs)
    .where(eq(schema.agentConfigs.agentType, STYLE_AGENT_TYPE))
    .all()

  if (existing) {
    db.update(schema.agentConfigs).set({
      name: '风格提示词',
      description: '项目视觉风格到图片提示词的映射',
      systemPrompt: payload,
      isActive: true,
      deletedAt: null,
      updatedAt: ts,
    }).where(eq(schema.agentConfigs.id, existing.id)).run()
    return getStylePromptConfig()
  }

  db.insert(schema.agentConfigs).values({
    agentType: STYLE_AGENT_TYPE,
    name: '风格提示词',
    description: '项目视觉风格到图片提示词的映射',
    systemPrompt: payload,
    temperature: 0,
    maxTokens: 0,
    maxIterations: 0,
    isActive: true,
    createdAt: ts,
    updatedAt: ts,
  }).run()
  return getStylePromptConfig()
}

export function getStylePromptForDrama(drama: any) {
  const styleKey = normalizeStyleKey(drama?.style)
  const item = getStylePromptConfig().find(entry => entry.key === styleKey)
  return String(item?.prompt || '').trim()
}

export function applyDramaStylePrompt(dramaId: number | null | undefined, prompt: string) {
  const base = String(prompt || '').trim()
  if (!dramaId) return base
  const [drama] = db.select().from(schema.dramas).where(eq(schema.dramas.id, Number(dramaId))).all()
  const stylePrompt = getStylePromptForDrama(drama)
  if (!stylePrompt) return base
  if (!base) return stylePrompt
  return `${stylePrompt}。${base}`
}
