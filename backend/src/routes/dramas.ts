import { Hono } from 'hono'
import { eq, isNull, like, desc } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { success, badRequest, notFound, created, now } from '../utils/response.js'
import { toSnakeCase, toSnakeCaseArray } from '../utils/transform.js'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawnSync } from 'child_process'
import { createAgent } from '../agents/index.js'
import { generateImage } from '../services/image-generation.js'
import { generateVideo } from '../services/video-generation.js'
import { composeStoryboard } from '../services/ffmpeg-compose.js'
import { mergeEpisodeVideos } from '../services/ffmpeg-merge.js'

const app = new Hono()

const EPISODE_HEADING_RE = /(?:^|\n)\s*(?:#{1,6}\s*)?(?:第\s*[0-9一二三四五六七八九十百千]+\s*[集章节回]|episode\s*\d+|ep\s*\d+|第\s*\d+\s*集)[^\n\r]*/gi
const AUTO_TARGET_ORDER = ['storyboard', 'shot_images', 'videos', 'compose'] as const
type AutoTarget = typeof AUTO_TARGET_ORDER[number]
type AutoJob = {
  id: string
  dramaId: number
  target: AutoTarget
  regenerateMode?: 'missing' | 'overwrite'
  endEpisode?: number | null
  episodeNumbers?: number[]
  status: 'running' | 'paused' | 'completed' | 'failed' | 'cancelled'
  message: string
  detail?: string
  currentStage?: AutoTarget | 'script' | 'extract'
  currentEpisode?: number
  currentEpisodeTitle?: string
  completedEpisodes: number
  totalEpisodes: number
  episodeStatus?: Record<string, { status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'; message: string; stage?: string }>
  logs: { at: string; message: string; episode?: number; stage?: string }[]
  startedAt: string
  updatedAt: string
  error?: string
}
const autoJobs = new Map<string, AutoJob>()

function normalizeStyle(style?: string | null) {
  return String(style || 'realistic').trim() || 'realistic'
}

async function readCreateBody(c: any) {
  const contentType = c.req.header('content-type') || ''
  if (!contentType.includes('multipart/form-data')) {
    return { body: await c.req.json(), importedText: '', sourceFileName: '' }
  }

  const form = await c.req.parseBody()
  const file = form.file
  const body = {
    title: String(form.title || '').trim(),
    description: String(form.description || '').trim(),
    genre: String(form.genre || '').trim(),
    style: normalizeStyle(String(form.style || '')),
    total_episodes: Number(form.total_episodes || 1),
    tags: [],
  }

  let importedText = ''
  let sourceFileName = ''
  if (file instanceof File) {
    sourceFileName = file.name
    importedText = await extractTextFromFile(file)
  }

  return { body, importedText, sourceFileName }
}

async function extractTextFromFile(file: File) {
  const name = file.name.toLowerCase()
  const buffer = Buffer.from(await file.arrayBuffer())

  if (name.endsWith('.txt') || name.endsWith('.md') || file.type.startsWith('text/')) {
    return buffer.toString('utf-8').replace(/^\uFEFF/, '').trim()
  }

  if (name.endsWith('.docx')) {
    return extractDocxText(buffer).trim()
  }

  if (name.endsWith('.doc')) {
    return extractLegacyDocText(buffer).trim()
  }

  if (name.endsWith('.pdf')) {
    return extractPdfText(buffer).trim()
  }

  throw new Error('仅支持导入 PDF、Word(doc/docx)、TXT 和 MD 文件')
}

function extractDocxText(buffer: Buffer) {
  const tmp = writeTempFile(buffer, '.docx')
  try {
    const result = spawnSync('unzip', ['-p', tmp, 'word/document.xml'], { encoding: 'utf-8', maxBuffer: 100 * 1024 * 1024 })
    if (result.status !== 0 || !result.stdout) throw new Error(result.stderr || 'Word 文档解析失败')
    return result.stdout
      .replace(/<w:tab\/>/g, '\t')
      .replace(/<\/w:p>/g, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
  } finally {
    fs.rmSync(tmp, { force: true })
  }
}

function extractLegacyDocText(buffer: Buffer) {
  const text = buffer.toString('utf16le') + '\n' + buffer.toString('latin1')
  return text
    .replace(/[^\u4e00-\u9fa5a-zA-Z0-9，。！？；：、（）《》“”‘’\s.,!?;:()[\]{}"'<>/@#%&*+=_-]/g, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
}

function extractPdfText(buffer: Buffer) {
  const tmp = writeTempFile(buffer, '.pdf')
  try {
    const result = spawnSync('pdftotext', ['-layout', tmp, '-'], { encoding: 'utf-8', maxBuffer: 100 * 1024 * 1024 })
    if (result.error && (result.error as any).code === 'ENOENT') {
      throw new Error('服务器缺少 pdftotext，无法解析 PDF。请安装 poppler-utils，或先导入 Word/TXT/MD。')
    }
    if (result.status !== 0) throw new Error(result.stderr || 'PDF 解析失败')
    return result.stdout || ''
  } finally {
    fs.rmSync(tmp, { force: true })
  }
}

function writeTempFile(buffer: Buffer, ext: string) {
  const filePath = path.join(os.tmpdir(), `huobao-import-${Date.now()}-${Math.random().toString(16).slice(2)}${ext}`)
  fs.writeFileSync(filePath, buffer)
  return filePath
}

function splitImportedText(text: string, totalEpisodes: number) {
  const clean = text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  if (!clean) return []

  const markerMatches = Array.from(clean.matchAll(EPISODE_HEADING_RE)).filter(match => match.index != null)
  if (markerMatches.length >= 2) {
    return markerMatches.map((match, index) => {
      const start = match.index || 0
      const end = markerMatches[index + 1]?.index ?? clean.length
      return clean.slice(start, end).trim()
    }).filter(Boolean).slice(0, totalEpisodes)
  }

  const paragraphs = clean.split(/\n\s*\n/).map(item => item.trim()).filter(Boolean)
  if (paragraphs.length >= totalEpisodes) {
    const chunks = Array.from({ length: totalEpisodes }, () => [] as string[])
    const totalChars = paragraphs.reduce((sum, paragraph) => sum + paragraph.length, 0)
    const targetChars = Math.max(1, Math.ceil(totalChars / totalEpisodes))
    let index = 0
    let currentChars = 0

    for (const paragraph of paragraphs) {
      if (index < totalEpisodes - 1 && currentChars >= targetChars) {
        index++
        currentChars = 0
      }
      chunks[index].push(paragraph)
      currentChars += paragraph.length
    }
    return chunks.map(chunk => chunk.join('\n\n').trim()).filter(Boolean)
  }

  const chunkSize = Math.ceil(clean.length / totalEpisodes)
  return Array.from({ length: totalEpisodes }, (_, index) => clean.slice(index * chunkSize, (index + 1) * chunkSize).trim()).filter(Boolean)
}

function safeJson(value: string) {
  try {
    return JSON.parse(value)
  } catch {
    return {}
  }
}

function enrichCharactersForLibrary(chars: any[], episodes: any[]) {
  const links = db.select().from(schema.episodeCharacters).all()
  return toSnakeCaseArray(chars).map((char: any) => {
    const episodeIds = links
      .filter(link => link.characterId === char.id)
      .map(link => link.episodeId)
    const episodeNumbers = episodes
      .filter(ep => episodeIds.includes(ep.id))
      .map(ep => ep.episodeNumber)
      .sort((a, b) => a - b)
    return {
      ...char,
      episode_ids: episodeIds,
      episode_numbers: episodeNumbers,
      episode_count: episodeNumbers.length,
      is_produced: !!(char.image_url || char.imageUrl || char.voice_sample_url || char.voiceSampleUrl),
    }
  })
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function targetReached(target: AutoTarget, stage: AutoTarget) {
  return AUTO_TARGET_ORDER.indexOf(stage) <= AUTO_TARGET_ORDER.indexOf(target)
}

function updateJob(job: AutoJob, patch: Partial<AutoJob>) {
  Object.assign(job, patch, { updatedAt: new Date().toISOString() })
}

function addJobLog(job: AutoJob, message: string, episode?: number, stage?: string) {
  job.logs = [...(job.logs || []), { at: new Date().toISOString(), message, episode, stage }].slice(-120)
  updateJob(job, { logs: job.logs })
}

async function waitIfPaused(job: AutoJob) {
  while (job.status === 'paused') {
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
  if (job.status === 'cancelled') throw new Error('任务已取消')
}

function markEpisodeJob(job: AutoJob, episodeNumber: number, status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled', message: string, stage?: string) {
  const next = { ...(job.episodeStatus || {}) }
  next[String(episodeNumber)] = { status, message, stage }
  updateJob(job, { episodeStatus: next })
}

function describeTarget(target: AutoTarget) {
  return ({ storyboard: '分镜', shot_images: '镜头图片', videos: '视频生成', compose: '最终合成' } as Record<AutoTarget, string>)[target] || target
}

function resolveAutoEpisodes(dramaId: number, endEpisode?: number | null, episodeNumbers: number[] = []) {
  return db.select().from(schema.episodes)
    .where(eq(schema.episodes.dramaId, dramaId))
    .orderBy(schema.episodes.episodeNumber)
    .all()
    .filter(ep => {
      const number = Number(ep.episodeNumber)
      if (episodeNumbers.length) return episodeNumbers.includes(number)
      return !endEpisode || number <= Number(endEpisode)
    })
}

function inspectExistingAutoAssets(episodes: any[], target: AutoTarget) {
  const episodeIds = new Set(episodes.map(ep => ep.id))
  const storyboards = db.select().from(schema.storyboards).all()
    .filter(sb => episodeIds.has(sb.episodeId) && !sb.deletedAt)
  const counts = {
    storyboards: storyboards.length,
    shotImages: storyboards.filter(sb => sb.firstFrameImage || sb.lastFrameImage || sb.composedImage).length,
    videos: storyboards.filter(sb => sb.videoUrl).length,
    composedVideos: storyboards.filter(sb => sb.composedVideoUrl).length,
  }
  const warnings = []
  if (targetReached(target, 'storyboard') && counts.storyboards) warnings.push(`已有 ${counts.storyboards} 个分镜`)
  if (targetReached(target, 'shot_images') && counts.shotImages) warnings.push(`已有 ${counts.shotImages} 个镜头图片`)
  if (targetReached(target, 'videos') && counts.videos) warnings.push(`已有 ${counts.videos} 个镜头视频`)
  if (targetReached(target, 'compose') && counts.composedVideos) warnings.push(`已有 ${counts.composedVideos} 个合成视频`)
  return {
    hasExisting: warnings.length > 0,
    counts,
    warnings,
    episodes: episodes.map(ep => ({ id: ep.id, episode_number: ep.episodeNumber, title: ep.title })),
  }
}

function resetAutoAssets(episodes: any[], target: AutoTarget) {
  const ts = now()
  for (const ep of episodes) {
    const storyboards = getEpisodeStoryboards(ep.id).filter((sb: any) => !sb.deletedAt)
    if (targetReached(target, 'storyboard')) {
      for (const sb of storyboards) {
        db.update(schema.storyboards).set({ deletedAt: ts, updatedAt: ts }).where(eq(schema.storyboards.id, sb.id)).run()
      }
      db.update(schema.episodes).set({ scriptContent: null, updatedAt: ts }).where(eq(schema.episodes.id, ep.id)).run()
      if (targetReached(target, 'compose')) {
        db.update(schema.episodes).set({ videoUrl: null, updatedAt: ts }).where(eq(schema.episodes.id, ep.id)).run()
        db.select().from(schema.videoMerges).where(eq(schema.videoMerges.episodeId, ep.id)).all()
          .forEach((merge: any) => db.update(schema.videoMerges).set({ deletedAt: ts }).where(eq(schema.videoMerges.id, merge.id)).run())
      }
      continue
    }
    for (const sb of storyboards) {
      if (targetReached(target, 'shot_images')) {
        db.update(schema.storyboards).set({ firstFrameImage: null, lastFrameImage: null, composedImage: null, updatedAt: ts }).where(eq(schema.storyboards.id, sb.id)).run()
      }
      if (targetReached(target, 'videos')) {
        db.update(schema.storyboards).set({ videoUrl: null, updatedAt: ts }).where(eq(schema.storyboards.id, sb.id)).run()
      }
      if (targetReached(target, 'compose')) {
        db.update(schema.storyboards).set({ composedVideoUrl: null, updatedAt: ts }).where(eq(schema.storyboards.id, sb.id)).run()
      }
    }
    if (targetReached(target, 'compose')) {
      db.update(schema.episodes).set({ videoUrl: null, updatedAt: ts }).where(eq(schema.episodes.id, ep.id)).run()
      db.select().from(schema.videoMerges).where(eq(schema.videoMerges.episodeId, ep.id)).all()
        .forEach((merge: any) => db.update(schema.videoMerges).set({ deletedAt: ts }).where(eq(schema.videoMerges.id, merge.id)).run())
    }
  }
}

function getEpisodeStoryboards(episodeId: number) {
  return db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId))
    .orderBy(schema.storyboards.storyboardNumber)
    .all()
    .filter((sb: any) => !sb.deletedAt)
}

function getProjectTextConfigId(drama: any) {
  const metadata = drama.metadata ? safeJson(drama.metadata) : {}
  return Number(metadata?.ai_defaults?.text_config_id || 0) || null
}

async function runEpisodeAgent(agentType: string, message: string, dramaId: number, episodeId: number, textConfigId?: number | null) {
  const agent = createAgent(agentType, episodeId, dramaId, { textConfigId })
  if (!agent) throw new Error(`Agent not found: ${agentType}`)
  await agent.generate([{ role: 'user', content: message }], { maxSteps: 20 })
}

async function waitFor<T>(read: () => T, done: (value: T) => boolean, label: string, attempts = 180, delay = 3000) {
  for (let i = 0; i < attempts; i++) {
    const value = read()
    if (done(value)) return value
    await sleep(delay)
  }
  throw new Error(`${label} 等待超时`)
}

function getStoryboardImagePrompt(sb: any) {
  return [
    sb.title ? `镜头标题：${sb.title}` : '',
    (sb.imagePrompt || sb.description) ? `画面描述：${sb.imagePrompt || sb.description}` : '',
    sb.shotType ? `景别：${sb.shotType}` : '',
    sb.angle ? `机位：${sb.angle}` : '',
    sb.location ? `地点：${sb.location}` : '',
    sb.time ? `时间：${sb.time}` : '',
    sb.action ? `动作：${sb.action}` : '',
    sb.atmosphere ? `氛围：${sb.atmosphere}` : '',
    '生成这个镜头的起始关键帧，突出建立关系和动作开始瞬间',
  ].filter(Boolean).join('；')
}

async function ensureScriptAndContext(ep: any, drama: any, textConfigId?: number | null) {
  if (!ep.scriptContent && ep.content) {
    await runEpisodeAgent('script_rewriter', '请读取剧本并改写为格式化剧本，然后保存', drama.id, ep.id, textConfigId)
    await waitFor(
      () => db.select().from(schema.episodes).where(eq(schema.episodes.id, ep.id)).all()[0],
      row => !!row?.scriptContent,
      `第${ep.episodeNumber}集 AI 改写`,
      80,
      3000,
    )
  }

  const charLinks = db.select().from(schema.episodeCharacters).where(eq(schema.episodeCharacters.episodeId, ep.id)).all()
  const sceneLinks = db.select().from(schema.episodeScenes).where(eq(schema.episodeScenes.episodeId, ep.id)).all()
  if (!charLinks.length || !sceneLinks.length) {
    await runEpisodeAgent('extractor', '请从剧本中提取所有角色和场景信息，提取时自动与项目已有数据进行去重合并', drama.id, ep.id, textConfigId)
    await waitFor(
      () => ({
        chars: db.select().from(schema.episodeCharacters).where(eq(schema.episodeCharacters.episodeId, ep.id)).all().length,
        scenes: db.select().from(schema.episodeScenes).where(eq(schema.episodeScenes.episodeId, ep.id)).all().length,
      }),
      state => state.chars > 0 && state.scenes > 0,
      `第${ep.episodeNumber}集 角色场景提取`,
      80,
      3000,
    )
  }
}

async function ensureStoryboards(ep: any, drama: any, textConfigId?: number | null) {
  if (getEpisodeStoryboards(ep.id).length) return
  await ensureScriptAndContext(ep, drama, textConfigId)
  await runEpisodeAgent(
    'storyboard_breaker',
    '请拆解分镜并生成中文视频提示词。请保持镜头连续、时长合理，并为后续图片和视频生成补全中文提示词。',
    drama.id,
    ep.id,
    textConfigId,
  )
  await waitFor(
    () => getEpisodeStoryboards(ep.id),
    rows => rows.length > 0,
    `第${ep.episodeNumber}集 分镜拆解`,
    120,
    3000,
  )
}

async function ensureShotImages(ep: any, drama: any) {
  const storyboards = getEpisodeStoryboards(ep.id)
  for (const sb of storyboards) {
    if (sb.firstFrameImage || sb.composedImage) continue
    const genId = await generateImage({
      storyboardId: sb.id,
      dramaId: drama.id,
      prompt: getStoryboardImagePrompt(sb),
      frameType: 'first_frame',
      configId: ep.imageConfigId ?? undefined,
    })
    await waitFor(
      () => db.select().from(schema.imageGenerations).where(eq(schema.imageGenerations.id, genId)).all()[0],
      row => row?.status === 'completed' || row?.status === 'failed',
      `第${ep.episodeNumber}集 镜头${sb.storyboardNumber}图片`,
      180,
      3000,
    )
    const [record] = db.select().from(schema.imageGenerations).where(eq(schema.imageGenerations.id, genId)).all()
    if (record?.status === 'failed') throw new Error(record.errorMsg || `镜头${sb.storyboardNumber}图片生成失败`)
  }
}

async function ensureVideos(ep: any, drama: any) {
  const storyboards = getEpisodeStoryboards(ep.id)
  for (const sb of storyboards) {
    if (sb.videoUrl) continue
    const first = sb.firstFrameImage || sb.composedImage || ''
    const genId = await generateVideo({
      storyboardId: sb.id,
      dramaId: drama.id,
      prompt: sb.videoPrompt || sb.description || sb.title || '',
      duration: Number(sb.duration || 5),
      referenceMode: first ? 'single' : 'none',
      imageUrl: first || undefined,
      configId: ep.videoConfigId ?? undefined,
    })
    await waitFor(
      () => db.select().from(schema.videoGenerations).where(eq(schema.videoGenerations.id, genId)).all()[0],
      row => row?.status === 'completed' || row?.status === 'failed',
      `第${ep.episodeNumber}集 镜头${sb.storyboardNumber}视频`,
      240,
      4000,
    )
    const [record] = db.select().from(schema.videoGenerations).where(eq(schema.videoGenerations.id, genId)).all()
    if (record?.status === 'failed') throw new Error(record.errorMsg || `镜头${sb.storyboardNumber}视频生成失败`)
  }
}

async function ensureComposed(ep: any, drama: any) {
  const storyboards = getEpisodeStoryboards(ep.id)
  for (const sb of storyboards) {
    if (sb.composedVideoUrl) continue
    if (!sb.videoUrl) throw new Error(`第${ep.episodeNumber}集 镜头${sb.storyboardNumber}没有视频，无法合成`)
    await composeStoryboard(sb.id)
  }

  const merges = db.select().from(schema.videoMerges).where(eq(schema.videoMerges.episodeId, ep.id)).all()
  const latestMerge = merges[merges.length - 1]
  if (latestMerge?.status === 'completed') return
  const mergeId = await mergeEpisodeVideos(ep.id, drama.id)
  await waitFor(
    () => db.select().from(schema.videoMerges).where(eq(schema.videoMerges.id, mergeId)).all()[0],
    row => row?.status === 'completed' || row?.status === 'failed',
    `第${ep.episodeNumber}集 最终拼接`,
    120,
    4000,
  )
  const [record] = db.select().from(schema.videoMerges).where(eq(schema.videoMerges.id, mergeId)).all()
  if (record?.status === 'failed') throw new Error(record.errorMsg || `第${ep.episodeNumber}集拼接失败`)
}

async function runAutoJob(job: AutoJob) {
  const [drama] = db.select().from(schema.dramas).where(eq(schema.dramas.id, job.dramaId)).all()
  if (!drama) throw new Error('剧集不存在')
  const textConfigId = getProjectTextConfigId(drama)
  const episodes = resolveAutoEpisodes(job.dramaId, job.endEpisode, job.episodeNumbers || [])
  job.totalEpisodes = episodes.length
  if (!episodes.length) {
    updateJob(job, { status: 'completed', message: '没有需要处理的剧集', detail: '没有匹配到本次任务范围内的剧集' })
    return
  }
  if (job.regenerateMode === 'overwrite') {
    updateJob(job, { detail: '正在按确认选项重置本次范围内资产' })
    addJobLog(job, '已选择重新生成，正在重置本次范围内资产')
    resetAutoAssets(episodes, job.target)
  }
  addJobLog(job, `任务开始：${episodes.map(ep => `第${ep.episodeNumber}集`).join('、')}，目标到${describeTarget(job.target)}`)

  for (const ep of episodes) {
    await waitIfPaused(job)
    updateJob(job, {
      currentEpisode: ep.episodeNumber,
      currentEpisodeTitle: ep.title,
      currentStage: 'storyboard',
      message: `正在处理第 ${ep.episodeNumber} 集：${ep.title}`,
      detail: `目标到${describeTarget(job.target)}，正在补齐前置流程`,
    })
    markEpisodeJob(job, ep.episodeNumber, 'running', `正在生成到${describeTarget(job.target)}`, job.target)
    addJobLog(job, `开始处理第 ${ep.episodeNumber} 集`, ep.episodeNumber)

    if (targetReached(job.target, 'storyboard')) {
      await waitIfPaused(job)
      updateJob(job, { currentStage: 'storyboard', detail: `第 ${ep.episodeNumber} 集：正在生成分镜` })
      addJobLog(job, '正在生成分镜', ep.episodeNumber, 'storyboard')
      await ensureStoryboards(ep, drama, textConfigId)
    }
    if (targetReached(job.target, 'shot_images')) {
      await waitIfPaused(job)
      updateJob(job, { currentStage: 'shot_images', detail: `第 ${ep.episodeNumber} 集：正在生成镜头图片` })
      addJobLog(job, '正在生成镜头图片', ep.episodeNumber, 'shot_images')
      await ensureShotImages(ep, drama)
    }
    if (targetReached(job.target, 'videos')) {
      await waitIfPaused(job)
      updateJob(job, { currentStage: 'videos', detail: `第 ${ep.episodeNumber} 集：正在生成镜头视频` })
      addJobLog(job, '正在生成镜头视频', ep.episodeNumber, 'videos')
      await ensureVideos(ep, drama)
    }
    if (targetReached(job.target, 'compose')) {
      await waitIfPaused(job)
      updateJob(job, { currentStage: 'compose', detail: `第 ${ep.episodeNumber} 集：正在合成视频` })
      addJobLog(job, '正在合成视频', ep.episodeNumber, 'compose')
      await ensureComposed(ep, drama)
    }
    markEpisodeJob(job, ep.episodeNumber, 'completed', `已生成到${describeTarget(job.target)}`, job.target)
    addJobLog(job, `第 ${ep.episodeNumber} 集完成`, ep.episodeNumber)
    updateJob(job, { completedEpisodes: job.completedEpisodes + 1 })
  }

  updateJob(job, { status: 'completed', message: '自动生成完成', detail: `已完成 ${job.completedEpisodes}/${job.totalEpisodes} 集` })
  addJobLog(job, '任务完成')
}

// GET /dramas - List dramas
app.get('/', async (c) => {
  const page = Number(c.req.query('page') || 1)
  const pageSize = Number(c.req.query('page_size') || 20)
  const status = c.req.query('status')
  const keyword = c.req.query('keyword')

  let query = db.select().from(schema.dramas).where(isNull(schema.dramas.deletedAt))

  const allRows = await query.orderBy(desc(schema.dramas.updatedAt))
  let filtered = allRows

  if (status) filtered = filtered.filter(d => d.status === status)
  if (keyword) filtered = filtered.filter(d => d.title.includes(keyword))

  const total = filtered.length
  const items = filtered.slice((page - 1) * pageSize, page * pageSize)

  // Attach episode/character/scene counts
  const enriched = await Promise.all(items.map(async (drama) => {
    const eps = await db.select().from(schema.episodes)
      .where(eq(schema.episodes.dramaId, drama.id))
    const chars = await db.select().from(schema.characters)
      .where(eq(schema.characters.dramaId, drama.id))
    const scns = await db.select().from(schema.scenes)
      .where(eq(schema.scenes.dramaId, drama.id))
	    return {
	      ...toSnakeCase(drama),
	      tags: drama.tags ? JSON.parse(drama.tags) : [],
	      total_episodes: eps.length,
	      episodes: toSnakeCaseArray(eps),
	      characters: enrichCharactersForLibrary(chars, eps),
	      scenes: toSnakeCaseArray(scns),
	    }
	  }))

  return success(c, {
    items: enriched,
    pagination: { page, page_size: pageSize, total, total_pages: Math.ceil(total / pageSize) },
  })
})

// POST /dramas - Create drama
app.post('/', async (c) => {
  let parsed
  try {
    parsed = await readCreateBody(c)
  } catch (err: any) {
    return badRequest(c, err.message || '文件解析失败')
  }

  const { body, importedText, sourceFileName } = parsed
  if (!body.title?.trim()) return badRequest(c, '项目名称不能为空')

  const ts = now()
  const totalEpisodes = Math.max(1, Math.min(100, Number(body.total_episodes || 1)))
  const episodeContents = splitImportedText(importedText, totalEpisodes)
  const res = db.insert(schema.dramas).values({
    title: body.title,
    description: body.description,
    genre: body.genre,
    style: normalizeStyle(body.style),
    totalEpisodes,
    tags: body.tags ? JSON.stringify(body.tags) : null,
    metadata: JSON.stringify({
      ...(body.metadata ? typeof body.metadata === 'string' ? safeJson(body.metadata) : body.metadata : {}),
      source_file: sourceFileName || undefined,
      import_text_length: importedText.length || undefined,
      import_episode_count: episodeContents.length || undefined,
    }),
    status: 'draft',
    createdAt: ts,
    updatedAt: ts,
  }).run()

  const [result] = db.select().from(schema.dramas)
    .where(eq(schema.dramas.id, Number(res.lastInsertRowid))).all()

  // Create default episodes
  for (let i = 1; i <= totalEpisodes; i++) {
    const content = episodeContents[i - 1] || ''
    db.insert(schema.episodes).values({
      dramaId: result.id,
      episodeNumber: i,
      title: `第${i}集`,
      content,
      scriptContent: content,
      status: 'draft',
      createdAt: ts,
      updatedAt: ts,
    }).run()
  }

  return created(c, toSnakeCase(result))
})


// GET /dramas/stats — must be before /:id
app.get('/stats', async (c) => {
  const all = db.select().from(schema.dramas).where(isNull(schema.dramas.deletedAt)).all()
  const byStatus = Object.entries(
    all.reduce((acc, d) => {
      acc[d.status || 'draft'] = (acc[d.status || 'draft'] || 0) + 1
      return acc
    }, {} as Record<string, number>)
  ).map(([status, count]) => ({ status, count }))
  return success(c, { total: all.length, by_status: byStatus })
})

// POST /dramas/:id/auto-generate — 按目标阶段批量自动生成
app.post('/:id/auto-generate', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json().catch(() => ({}))
  const target = String(body.target || 'storyboard') as AutoTarget
  const regenerateMode = body.regenerate_mode === 'overwrite' ? 'overwrite' : 'missing'
  const episodeNumbers: number[] = Array.isArray(body.episode_numbers)
    ? Array.from(new Set<number>(
      body.episode_numbers
        .map((n: any) => Number(n))
        .filter((n: number) => Number.isFinite(n) && n > 0),
    )).sort((a, b) => a - b)
    : []
  const endEpisode = body.end_episode === undefined || body.end_episode === null || body.end_episode === ''
    ? null
    : Math.max(1, Number(body.end_episode))
  if (!AUTO_TARGET_ORDER.includes(target)) {
    return badRequest(c, 'target must be storyboard, shot_images, videos or compose')
  }
  if (endEpisode !== null && !Number.isFinite(endEpisode)) {
    return badRequest(c, 'end_episode must be a positive number')
  }

  const [drama] = db.select().from(schema.dramas).where(eq(schema.dramas.id, id)).all()
  if (!drama) return notFound(c, '剧本不存在')

  const matchedEpisodes = resolveAutoEpisodes(id, endEpisode, episodeNumbers)
  const totalEpisodes = matchedEpisodes.length
  if (!totalEpisodes) return badRequest(c, '没有匹配到需要自动生成的剧集')
  const ts = new Date().toISOString()
  const job: AutoJob = {
    id: `${id}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    dramaId: id,
    target,
    regenerateMode,
    endEpisode,
    episodeNumbers,
    status: 'running',
    message: episodeNumbers.length
      ? `自动生成已开始，将处理指定的 ${episodeNumbers.length} 集`
      : endEpisode ? `自动生成已开始，将处理到第 ${endEpisode} 集` : '自动生成已开始',
    detail: `目标到${describeTarget(target)}，等待开始处理`,
    completedEpisodes: 0,
    totalEpisodes,
    episodeStatus: {},
    logs: [{ at: ts, message: '任务创建', stage: target }],
    startedAt: ts,
    updatedAt: ts,
  }
  autoJobs.set(job.id, job)

  runAutoJob(job).catch((err: any) => {
    const wasCancelled = job.status === 'cancelled' || String(err.message || err).includes('任务已取消')
    if (job.currentEpisode) {
      markEpisodeJob(job, job.currentEpisode, wasCancelled ? 'cancelled' : 'failed', wasCancelled ? '任务已取消' : '任务失败', job.currentStage)
    }
    addJobLog(job, wasCancelled ? '任务已取消' : `任务失败：${err.message || String(err)}`)
    updateJob(job, {
      status: wasCancelled ? 'cancelled' : 'failed',
      message: wasCancelled ? '自动生成已取消' : '自动生成失败',
      error: err.message || String(err),
    })
  })

  return success(c, job)
})

// POST /dramas/:id/auto-generate-preview — 开始前检查本次范围已有资产
app.post('/:id/auto-generate-preview', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json().catch(() => ({}))
  const target = String(body.target || 'storyboard') as AutoTarget
  const episodeNumbers: number[] = Array.isArray(body.episode_numbers)
    ? Array.from(new Set<number>(
      body.episode_numbers
        .map((n: any) => Number(n))
        .filter((n: number) => Number.isFinite(n) && n > 0),
    )).sort((a, b) => a - b)
    : []
  const endEpisode = body.end_episode === undefined || body.end_episode === null || body.end_episode === ''
    ? null
    : Math.max(1, Number(body.end_episode))
  if (!AUTO_TARGET_ORDER.includes(target)) return badRequest(c, 'target must be storyboard, shot_images, videos or compose')
  const episodes = resolveAutoEpisodes(id, endEpisode, episodeNumbers)
  if (!episodes.length) return badRequest(c, '没有匹配到需要自动生成的剧集')
  return success(c, {
    target,
    target_label: describeTarget(target),
    total_episodes: episodes.length,
    ...inspectExistingAutoAssets(episodes, target),
  })
})

// GET /dramas/:id/auto-generate/:jobId — 查询自动生成进度
app.get('/:id/auto-generate/:jobId', async (c) => {
  const job = autoJobs.get(c.req.param('jobId'))
  if (!job || job.dramaId !== Number(c.req.param('id'))) return notFound(c, '任务不存在')
  return success(c, job)
})

// GET /dramas/:id/auto-generate-current — 查询当前剧集正在运行的自动生成任务
app.get('/:id/auto-generate-current', async (c) => {
  const dramaId = Number(c.req.param('id'))
  const running = [...autoJobs.values()]
    .filter(job => job.dramaId === dramaId && job.status === 'running')
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]
  if (running) return success(c, running)
  const latest = [...autoJobs.values()]
    .filter(job => job.dramaId === dramaId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]
  return success(c, latest || null)
})

// GET /dramas/:id/auto-generate-jobs — 查询任务列表与日志
app.get('/:id/auto-generate-jobs', async (c) => {
  const dramaId = Number(c.req.param('id'))
  const jobs = [...autoJobs.values()]
    .filter(job => job.dramaId === dramaId)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .slice(0, 20)
  return success(c, jobs)
})

// POST /dramas/:id/auto-generate/:jobId/control — 暂停、继续、取消任务
app.post('/:id/auto-generate/:jobId/control', async (c) => {
  const dramaId = Number(c.req.param('id'))
  const job = autoJobs.get(c.req.param('jobId'))
  if (!job || job.dramaId !== dramaId) return notFound(c, '任务不存在')
  const body = await c.req.json().catch(() => ({}))
  const action = String(body.action || '')
  if (action === 'pause') {
    if (job.status === 'running') {
      addJobLog(job, '任务已暂停')
      updateJob(job, { status: 'paused', message: '自动生成已暂停', detail: '点击继续后会从当前步骤往后执行' })
    }
    return success(c, job)
  }
  if (action === 'resume') {
    if (job.status === 'paused') {
      addJobLog(job, '任务已继续')
      updateJob(job, { status: 'running', message: '自动生成继续执行' })
    }
    return success(c, job)
  }
  if (action === 'cancel') {
    addJobLog(job, '用户取消任务')
    updateJob(job, { status: 'cancelled', message: '自动生成已取消', detail: '任务会在当前步骤结束或下一次检查时停止' })
    return success(c, job)
  }
  return badRequest(c, 'action must be pause, resume or cancel')
})

// GET /dramas/:id - Get drama detail
app.get('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const [drama] = await db.select().from(schema.dramas).where(eq(schema.dramas.id, id))
  if (!drama) return notFound(c, '剧本不存在')

  const eps = await db.select().from(schema.episodes)
    .where(eq(schema.episodes.dramaId, id))
  const chars = await db.select().from(schema.characters)
    .where(eq(schema.characters.dramaId, id))
  const scns = await db.select().from(schema.scenes)
    .where(eq(schema.scenes.dramaId, id))
  const prps = await db.select().from(schema.props)
    .where(eq(schema.props.dramaId, id))

	  return success(c, {
	    ...toSnakeCase(drama),
	    tags: drama.tags ? JSON.parse(drama.tags) : [],
	    episodes: toSnakeCaseArray(eps),
	    characters: enrichCharactersForLibrary(chars, eps),
	    scenes: toSnakeCaseArray(scns),
	    props: toSnakeCaseArray(prps),
	  })
})

// PUT /dramas/:id - Update drama
app.put('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json()
  const updates: Record<string, any> = { updatedAt: now() }
  if (body.title !== undefined) updates.title = body.title
  if (body.description !== undefined) updates.description = body.description
  if (body.genre !== undefined) updates.genre = body.genre
  if (body.style !== undefined) updates.style = body.style
  if (body.status !== undefined) updates.status = body.status
  if (body.tags !== undefined) updates.tags = JSON.stringify(body.tags)
  if (body.metadata !== undefined) updates.metadata = body.metadata
  db.update(schema.dramas).set(updates).where(eq(schema.dramas.id, id)).run()
  return success(c)
})

// DELETE /dramas/:id - Soft delete
app.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  await db.update(schema.dramas).set({ deletedAt: now() }).where(eq(schema.dramas.id, id))
  return success(c)
})

// PUT /dramas/:id/characters - Save characters
app.put('/:id/characters', async (c) => {
  const dramaId = Number(c.req.param('id'))
  const body = await c.req.json()
  const chars = body.characters || []
  const ts = now()

  for (const char of chars) {
    if (char.id) {
      await db.update(schema.characters).set({ ...char, updatedAt: ts }).where(eq(schema.characters.id, char.id))
    } else {
      await db.insert(schema.characters).values({ ...char, dramaId, createdAt: ts, updatedAt: ts })
    }
  }
  return success(c)
})

// PUT /dramas/:id/episodes - Save episodes
app.put('/:id/episodes', async (c) => {
  const dramaId = Number(c.req.param('id'))
  const body = await c.req.json()
  const episodes = body.episodes || []
  const ts = now()

  for (const ep of episodes) {
    if (ep.id) {
      await db.update(schema.episodes).set({ ...ep, updatedAt: ts }).where(eq(schema.episodes.id, ep.id))
    } else {
      await db.insert(schema.episodes).values({
        ...ep,
        dramaId,
        episodeNumber: ep.episode_number || ep.episodeNumber || 1,
        title: ep.title || '未命名',
        createdAt: ts,
        updatedAt: ts,
      })
    }
  }
  return success(c)
})

export default app
