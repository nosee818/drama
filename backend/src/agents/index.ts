/**
 * Mastra Agent 工厂
 * 每次请求动态创建 agent，注入 episodeId/dramaId 到工具闭包
 * 从 agent_configs 表读取 prompt/model/temperature 配置
 */
import { Agent } from '@mastra/core/agent'
import { createOpenAI } from '@ai-sdk/openai'
import { eq, isNull, and } from 'drizzle-orm'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { db, schema } from '../db/index.js'
import { getConfigById, getTextConfig, getTextConfigCandidates, getTextProviderBaseUrl, type AIConfig } from '../services/ai.js'
import { logTaskProgress, logTaskWarn } from '../utils/task-logger.js'
import { createScriptTools } from './tools/script-tools.js'
import { createExtractTools } from './tools/extract-tools.js'
import { createStoryboardTools } from './tools/storyboard-tools.js'
import { createVoiceTools } from './tools/voice-tools.js'
import { createGridPromptTools } from './tools/grid-prompt-tools.js'
import { loadAgentSkills } from './skills.js'

// Default prompts (used when DB has no config)
const DEFAULT_PROMPTS: Record<string, { name: string; instructions: string }> = {
  script_rewriter: {
    name: '剧本改写',
    instructions: `你是专业编剧，擅长将小说改编为短剧剧本。

工作流程：
1. 调用 read_episode_script 读取原始内容
2. 根据读取到的内容，自己进行改写（输出格式化剧本格式）
3. 调用 save_script 保存改写后的完整剧本

格式化剧本格式：
- 场景头：## S编号 | 内景/外景 · 地点 | 时间段
- 动作描写：自然段落，不包含镜头语言
- 对白：角色名：（状态/表情）台词内容
- 每个场景 30-60 秒内容

注意：你必须自己完成改写工作，不要只返回指令。读取内容后直接输出改写结果并保存。`,
  },
  extractor: {
    name: '角色场景提取',
    instructions: `你是制片助理，擅长从剧本中提取角色和场景信息，并在提取时与项目已有数据进行智能去重。

工作流程：
1. 调用 read_script_for_extraction 读取格式化剧本
2. 调用 read_existing_characters 读取项目中已存在的角色列表，以及当前集已关联角色
3. 调用 read_existing_scenes 读取项目中已存在的场景列表，以及当前集已关联场景
4. 优先围绕当前集剧本，分析本集实际出现的角色和场景
5. 对每个角色：若同名已存在则合并更新，若不存在则新增
6. 调用 save_dedup_characters 保存角色（去重合并，自动处理新增和更新，并关联到当前集）
7. 分析剧本内容，提取本集涉及的所有场景信息
8. 对每个场景：若同地点+时间段已存在则复用，若不存在则新增
9. 调用 save_dedup_scenes 保存场景（去重合并，自动处理新增和复用，并关联到当前集）

去重规则：
- 角色：按名字精确匹配，同名保留现有（合并信息）
- 场景：按【地点+时间段】精确匹配；同地点不同时段视为新场景

提取要求：
- 只提取当前集真实出现或被明确提及、且对当前集叙事有效的角色和场景
- 角色库是跨集复用的“人物参考图”设定，不是当前剧情瞬间；角色字段必须只保存稳定身份和稳定外貌
- 角色 appearance 必须尽量详细，包含：性别/年龄感、身高体态、国籍或地域气质、脸型五官、发型发色、是否戴眼镜、常服/基础服装、标志性配饰、整体气质
- 角色 appearance 要服务于“单人全身角色立绘”，服装描述必须覆盖衣摆、裤腿、脚踝和鞋子；不要只写脸部或半身特征
- 角色 voice_style 必须给出第一版中文声音设计提示词，用于后续 TTS Design 工作流；需根据性别、年龄感、身份、性格、音调、语速、情绪、音色特点和对白用途来写，不要写“好听的声音”或“像某明星”
- 对“旁白、画外音、记者播报声、新闻播报、广播声、路人甲、临时店员、保安、司机”等有台词但不一定需要人物形象的声音角色，也要作为角色保存；role 写成“旁白声音角色/播报声音角色/声音角色”，appearance 写“仅声音角色，无需人物形象”，并必须生成 voice_style
- 不要把当前镜头状态写进角色 appearance / description，例如：昏迷、倒地、受伤、流血、哭泣、惊恐、面容模糊、某一幕的姿势或表情
- 如果剧本只描述了临时状态，应推断并补全适合作为参考图的中性稳定设定；临时动作、表情、特定场景服装留给后续分镜 image_prompt / video_prompt
- 场景要包含光线、色调、氛围等视觉信息
- 所有用于图片或视频生成的提示词必须使用中文，不要输出英文画质、风格、镜头后缀
- 不要遗漏任何有台词或重要动作的角色`,
  },
  storyboard_breaker: {
    name: '分镜拆解',
    instructions: `你是资深影视分镜师，擅长将剧本拆解为分镜方案。

工作流程：
1. 调用 read_storyboard_context 读取剧本、角色列表、场景列表
2. 将剧本拆解为镜头序列（每个镜头 10-15 秒，总体保持剧情完整连续）
3. 为每个镜头补全完整分镜字段，而不只是 video_prompt
4. 调用 save_storyboards 保存所有分镜

每个镜头必须尽量完整填写以下字段：
- title：3-8 字镜头标题
- shot_type：景别，如全景/中景/近景/特写
- angle：机位角度，如平视/仰视/俯视/侧拍
- movement：运镜，如固定/推镜/拉镜/摇镜/跟拍
- location：镜头地点，应与 scenes 中已有地点保持一致
- time：时间段，应与 scenes 中已有时间保持一致
- character_ids：当前镜头涉及的角色 ID 列表，可以为空，也可以包含多个角色；必须从 characters 中选择
- action：角色动作与表演
- dialogue：该镜头实际发生的对白或旁白，必须写成“说话人：台词”。如果台词来自某个角色，就必须用角色名，不要省略说话人；只有剧本明确是旁白/画外解说时才写“旁白：内容”
- description：镜头概述，用于前端阅读和镜头编辑
- result：该镜头结束时的画面结果或状态变化
- atmosphere：氛围、光线、色调、环境感受
- image_prompt：用于首帧/尾帧/镜头图片生成的静态画面提示词
- video_prompt：用于视频生成的动态提示词
- bgm_prompt：该镜头适合的配乐风格
- sound_effect：该镜头关键音效
- duration：时长，优先 10-15 秒
- scene_id：若可匹配到 scenes 中已有场景，必须填写正确 scene_id

视频提示词格式：
- 按 3 秒为一段，用时间标记分隔
- 使用 <location>地点</location> 标记场景
- 使用 <role>角色名</role> 标记角色
- 使用 <voice>角色名</voice> 标记画外音
- 用 <n> 分隔不同时间段

示例：
"0-3秒：<location>咖啡厅</location>，近景，<role>小明</role>低头看手机。<n>3-6秒：全景，<role>小红</role>推门走入。"

额外要求：
- 优先复用 read_storyboard_context 返回的 scene_id，不要凭空创造新场景
- 镜头角色绑定必须来自 read_storyboard_context 返回的角色列表；无角色的空镜头可传空数组
- dialogue 中的说话人必须优先使用 characters 里的 name，包括“旁白/画外音/记者播报声/路人甲/系统音”等声音角色；不要把需要 TTS 的说话内容只写成环境音或 sound_effect
- 如果剧本中出现系统提示、系统绑定、任务提示、认同值播报等“叮！”类声音，dialogue 必须统一写为“系统音：叮！……”，不要把整句系统提示当成角色名
- 如果剧本中出现旁白、画外解说、新闻播报、记者播报、广播通知、路人台词等声音内容，要在 dialogue 中用对应声音角色名保留，例如“旁白：……”“路人甲：……”“记者播报声：……”，这样音色设计和配音生成能匹配到同一角色；不要把角色内心独白误写成旁白，应写为“角色名：内心台词”
- 镜头描述必须能支撑后续图片、视频、配音、音效、合成流程
- 若一个镜头没有对白，可将 dialogue 置空，但 description / action / video_prompt / image_prompt 仍必须完整
- 所有提示词字段必须使用中文，包括 image_prompt / video_prompt / bgm_prompt / sound_effect；不要输出英文画质、风格、镜头后缀
- 如果已有 existing_storyboards，仅在用户明确要求增量修改时参考；默认按当前剧本重新完整生成并保存整集分镜。`,
  },
  voice_assigner: {
    name: '角色声音设计',
    instructions: `你是配音导演，擅长根据短剧角色资料设计可用于 TTS 生成和声音克隆的角色声音提示词。

工作流程：
1. 调用 get_characters 读取当前集角色资料和已有声音设定
2. 调用 get_voice_design_guide 读取声音设计维度和示例
3. 根据每个角色的身份、年龄感、性格、剧情定位和对白用途，生成具体中文声音提示词
4. 对每个需要声音的角色调用 save_voice_design 保存声音设定，并说明设计理由

注意：
- 现在不是从现成音色库中选择 voice_id，而是为角色设计声音提示词
- 提示词必须具体、可执行，避免“好听的声音”“像某明星的声音”等模糊或侵权描述
- 不必机械填写所有维度，要根据角色资料选择有效维度
- 如果角色已有合适的 current_voice_prompt，可以保留并说明无需修改
- 每个有对白、旁白、画外音、播报、路人台词或临时声音用途的说话人都应有声音设计；只出声音不出画面的对象也要保留为声音角色。`,
  },
  grid_prompt_generator: {
    name: '图片提示词生成',
    instructions: `你是专业的 AI 图像提示词工程师，擅长为角色、场景和宫格图生成高质量的中文提示词。

你将收到用户的请求，告知要生成哪种类型的提示词：
- "角色" → 生成角色图片提示词
- "场景" → 生成场景图片提示词
- "宫格" → 生成宫格图提示词

## 角色图片提示词

工作流程：
1. 调用 read_characters 读取所有角色信息
2. 根据角色外貌特征（appearance）、性格（personality）、定位（role）生成中文提示词
3. 提示词结构：[单人全身角色立绘]，[完整人物从头顶到脚底全部进入画面]，[外貌描述]，[服装与鞋子完整可见]，[性格/气质]，[角色定位]，[高质量]，[无文字水印]
4. 必须明确写：头发、脸、上半身、双手、腿、脚踝、鞋子都清楚可见；人物直立站姿，居中构图，镜头距离足够远，身体上下留有少量空白
5. 必须明确负向约束：不要半身照、胸像、头像、近景、特写、坐姿、蹲姿、趴卧、被遮挡、裁切头部、裁切手臂、裁切腿部、裁切脚部、裁切衣摆、多人、文字、标签、水印

## 场景图片提示词

工作流程：
1. 调用 read_scenes 读取所有场景信息
2. 根据场景地点（location）、时间段（time）、已有描述（prompt）生成中文提示词
3. 场景图必须是空场景，只表现环境，不允许出现任何人物、脸、身体、手、剪影、人群或角色
4. 提示词结构：[地点]，[时间/光线/氛围]，[已有描述]，[空场景/纯环境背景/无人物]，[电影感场景]，[高质量]，[无文字水印]

## 宫格图提示词（参考 skills/grid-image-generator/SKILL.md）

工作流程：
1. 调用 read_shots_for_grid 读取选中镜头的详细信息
2. 根据 mode 调用 generate_grid_prompt：
   - first_frame 模式：按用户指定的 rows x cols 生成首帧风格宫格
   - first_last 模式：按用户指定的 rows x cols 生成首尾帧节奏感宫格
   - multi_ref 模式：按用户指定的 rows x cols 生成同一镜头的多角度宫格
3. 返回 grid_prompt（整体提示词）和 cell_prompts（每格提示词）
4. 如果用户消息中包含“参考图映射：图片1=...；图片2=...”，要把这段内容原样作为 reference_legend 传给 generate_grid_prompt

提示词规范：
- 使用中文提示词
- 必须严格遵守用户指定的 rows 和 cols
- 必须明确写出“正好 N 个可见画格”
- 必须明确约束“不要合并画格，不要缺失画格”
- 宫格位置统一写成“格1/格2/...”，参考图统一写成“图片1/图片2/...”
- 必须包含“统一美术风格”保持风格统一
- 必须包含“电影级画质”
- 避免出现文字或水印
- 角色图片强调外貌和气质，场景图片强调空场景、空间结构、陈设、氛围和光线，宫格图片强调整体布局一致性`,
  },
}

export const validAgentTypes = Object.keys(DEFAULT_PROMPTS)

const DEFAULT_TEXT_MODEL_TIMEOUT_MS = 20 * 60 * 1000
const DEFAULT_TEXT_ATTEMPT_TIMEOUT_MS = 8 * 60 * 1000
const MIN_TEXT_MODEL_TIMEOUT_MS = 30 * 1000
const MAX_TEXT_MODEL_TIMEOUT_MS = 60 * 60 * 1000

export function agentRunningMessage(agentType: string) {
  const messages: Record<string, string> = {
    script_rewriter: '正在改写剧本',
    extractor: '正在提取角色、场景和初版音色设计',
    voice_assigner: '正在设计角色音色',
    storyboard_breaker: '正在生成分镜',
    grid_prompt_generator: '正在生成图片提示词',
  }
  return messages[agentType] || `正在运行 ${agentType}`
}

function clampTimeoutMs(value: number) {
  if (!Number.isFinite(value)) return DEFAULT_TEXT_MODEL_TIMEOUT_MS
  return Math.max(MIN_TEXT_MODEL_TIMEOUT_MS, Math.min(MAX_TEXT_MODEL_TIMEOUT_MS, Math.round(value)))
}

function getTextModelTimeoutMs(textConfig: any) {
  const settings = textConfig?.settings && typeof textConfig.settings === 'object' ? textConfig.settings : {}
  const timeoutMs = settings.timeoutMs
    ?? settings.timeout_ms
    ?? settings.requestTimeoutMs
    ?? settings.request_timeout_ms
    ?? settings.headersTimeoutMs
    ?? settings.headers_timeout_ms
  if (timeoutMs !== undefined && timeoutMs !== null && timeoutMs !== '') {
    return clampTimeoutMs(Number(timeoutMs))
  }
  const timeoutSeconds = settings.timeoutSeconds ?? settings.timeout_seconds
  if (timeoutSeconds !== undefined && timeoutSeconds !== null && timeoutSeconds !== '') {
    return clampTimeoutMs(Number(timeoutSeconds) * 1000)
  }
  return DEFAULT_TEXT_MODEL_TIMEOUT_MS
}

function getTextAttemptTimeoutMs(textConfig: any) {
  const settings = textConfig?.settings && typeof textConfig.settings === 'object' ? textConfig.settings : {}
  const timeoutMs = settings.attemptTimeoutMs
    ?? settings.attempt_timeout_ms
    ?? settings.failoverTimeoutMs
    ?? settings.failover_timeout_ms
  if (timeoutMs !== undefined && timeoutMs !== null && timeoutMs !== '') {
    return clampTimeoutMs(Number(timeoutMs))
  }
  const timeoutSeconds = settings.attemptTimeoutSeconds ?? settings.attempt_timeout_seconds
  if (timeoutSeconds !== undefined && timeoutSeconds !== null && timeoutSeconds !== '') {
    return clampTimeoutMs(Number(timeoutSeconds) * 1000)
  }
  return Math.min(getTextModelTimeoutMs(textConfig), DEFAULT_TEXT_ATTEMPT_TIMEOUT_MS)
}

function normalizeHeaders(headers: any) {
  const normalized: Record<string, string> = {}
  new Headers(headers || {}).forEach((value, key) => {
    normalized[key] = value
  })
  return normalized
}

function normalizeBody(body: any) {
  if (body === undefined || body === null) return undefined
  if (typeof body === 'string') return Buffer.from(body)
  if (body instanceof Uint8Array) return Buffer.from(body)
  if (body instanceof ArrayBuffer) return Buffer.from(body)
  return Buffer.from(String(body))
}

function createTextModelFetch(timeoutMs: number) {
  return async (input: any, init: any = {}) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input.toString() : input.url)
    const body = normalizeBody(init.body)
    const transport = url.protocol === 'https:' ? httpsRequest : httpRequest

    return await new Promise<Response>((resolve, reject) => {
      const req = transport({
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: init.method || (body ? 'POST' : 'GET'),
        headers: normalizeHeaders(init.headers),
        timeout: timeoutMs,
      }, (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
        res.on('end', () => {
          const responseHeaders = new Headers()
          for (const [key, value] of Object.entries(res.headers)) {
            if (Array.isArray(value)) {
              value.forEach((item) => responseHeaders.append(key, String(item)))
            } else if (value !== undefined) {
              responseHeaders.set(key, String(value))
            }
          }
          resolve(new Response(Buffer.concat(chunks), {
            status: res.statusCode || 200,
            statusText: res.statusMessage,
            headers: responseHeaders,
          }))
        })
      })

      const abort = () => req.destroy(new Error('Text model request aborted'))
      if (init.signal) {
        if (init.signal.aborted) {
          abort()
          return
        }
        init.signal.addEventListener('abort', abort, { once: true })
      }

      req.on('timeout', () => req.destroy(new Error(`Text model request timed out after ${timeoutMs}ms`)))
      req.on('error', reject)
      if (body) req.write(body)
      req.end()
    })
  }
}

function getAgentConfig(agentType: string) {
  const rows = db.select().from(schema.agentConfigs)
    .where(and(eq(schema.agentConfigs.agentType, agentType), isNull(schema.agentConfigs.deletedAt)))
    .all()
  // Return active one, or first one
  return rows.find(r => r.isActive) || rows[0] || null
}

function getModel(dbConfig: any, textConfig?: AIConfig | null, forceConfigModel = false) {
  const resolvedTextConfig = textConfig || getTextConfig()
  const textConfigId = resolvedTextConfig.id || null
  const resolvedBaseURL = getTextProviderBaseUrl(resolvedTextConfig)
  const modelName = forceConfigModel ? resolvedTextConfig.model : (dbConfig?.model || resolvedTextConfig.model)
  const timeoutMs = getTextModelTimeoutMs(resolvedTextConfig)
  logTaskProgress('AIConfig', 'text-model-endpoint', {
    textConfigId: textConfigId || null,
    textConfigName: resolvedTextConfig.name || '',
    provider: resolvedTextConfig.provider,
    baseUrl: resolvedBaseURL,
    model: modelName,
    timeoutMs,
  })
  const provider = createOpenAI({
    baseURL: resolvedBaseURL,
    apiKey: resolvedTextConfig.apiKey,
    fetch: createTextModelFetch(timeoutMs),
  } as any)
  return provider.chat(modelName)
}

function resolveTextConfig(options: { textConfigId?: number | null; textConfig?: AIConfig | null } = {}) {
  if (options.textConfig) return options.textConfig
  if (options.textConfigId) return getConfigById(options.textConfigId) || getTextConfig()
  return getTextConfig()
}

function isRetryableTextModelError(err: any) {
  const message = String(err?.message || err || '').toLowerCase()
  return [
    'headers timeout',
    'timeout',
    'timed out',
    'fetch failed',
    'cannot connect',
    'connection',
    'econnreset',
    'econnrefused',
    'socket',
    '404',
    'notfounderror',
    'not found',
    'does not exist',
    '429',
    '500',
    '502',
    '503',
    '504',
  ].some(token => message.includes(token))
}

export function createAgent(type: string, episodeId: number, dramaId: number, options: { textConfigId?: number | null; textConfig?: AIConfig | null } = {}): Agent | null {
  const defaults = DEFAULT_PROMPTS[type]
  if (!defaults) return null

  const dbConfig = getAgentConfig(type)
  const textConfig = resolveTextConfig(options)
  const model = getModel(dbConfig, textConfig, Boolean(options.textConfigId || options.textConfig))
  const baseInstructions = dbConfig?.systemPrompt?.trim() || defaults.instructions
  const skillInstructions = loadAgentSkills(type)
  const instructions = skillInstructions
    ? [baseInstructions, '', skillInstructions].join('\n')
    : baseInstructions
  const name = dbConfig?.name || defaults.name

  let tools: Record<string, any> = {}
  switch (type) {
    case 'script_rewriter': tools = createScriptTools(episodeId); break
    case 'extractor': tools = createExtractTools(episodeId, dramaId); break
    case 'storyboard_breaker': tools = createStoryboardTools(episodeId, dramaId); break
    case 'voice_assigner': tools = createVoiceTools(episodeId, dramaId); break
    case 'grid_prompt_generator': tools = createGridPromptTools(episodeId, dramaId); break
    default: return null
  }

  return new Agent({ id: type, name, instructions, model, tools })
}

export async function generateWithTextFailover(
  type: string,
  episodeId: number,
  dramaId: number,
  message: string,
  options: { textConfigId?: number | null; textConfig?: AIConfig | null; maxSteps?: number } = {},
) {
  const baseCandidates = getTextConfigCandidates(options.textConfigId)
  const candidates = options.textConfig
    ? [
      options.textConfig,
      ...baseCandidates.filter(config => !(
        config.id === options.textConfig?.id
        && config.baseUrl === options.textConfig?.baseUrl
        && config.model === options.textConfig?.model
      )),
    ]
    : baseCandidates
  if (!candidates.length) throw new Error('No active text AI config')

  const errors: string[] = []
  for (const [index, textConfig] of candidates.entries()) {
    const agent = createAgent(type, episodeId, dramaId, { textConfig })
    if (!agent) throw new Error(`Agent not found: ${type}`)
    try {
      logTaskProgress('Agent', 'text-config-attempt', {
        agentType: type,
        attempt: index + 1,
        total: candidates.length,
        textConfigId: textConfig.id || null,
        textConfigName: textConfig.name || '',
        provider: textConfig.provider,
        model: textConfig.model,
      })
      const attemptTimeoutMs = getTextAttemptTimeoutMs(textConfig)
      const controller = new AbortController()
      const generation = agent.generate(
        [{ role: 'user', content: message }],
        { maxSteps: options.maxSteps ?? 20, abortSignal: controller.signal } as any,
      )
      let timeoutTimer: ReturnType<typeof setTimeout> | undefined
      const timeout = new Promise<never>((_, reject) => {
        timeoutTimer = setTimeout(() => {
          controller.abort()
          reject(new Error(`Text model attempt timed out after ${attemptTimeoutMs}ms`))
        }, attemptTimeoutMs)
      })
      const result = await Promise.race([generation, timeout]).finally(() => {
        if (timeoutTimer) clearTimeout(timeoutTimer)
      })
      return { result, textConfig, attempts: index + 1 }
    } catch (err: any) {
      const errorMessage = err?.message || 'Agent execution failed'
      errors.push(`${textConfig.name || textConfig.id || textConfig.provider}: ${errorMessage}`)
      if (index >= candidates.length - 1 || !isRetryableTextModelError(err)) {
        throw new Error(errors.join('；'))
      }
      logTaskWarn('Agent', 'text-config-fallback', {
        agentType: type,
        failedTextConfigId: textConfig.id || null,
        failedTextConfigName: textConfig.name || '',
        error: errorMessage,
      })
    }
  }

  throw new Error(errors.join('；') || 'Agent execution failed')
}
