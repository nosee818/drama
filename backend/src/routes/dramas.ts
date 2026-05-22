import { Hono } from 'hono'
import { eq, isNull, like, desc } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { success, badRequest, notFound, created, now } from '../utils/response.js'
import { toSnakeCase, toSnakeCaseArray } from '../utils/transform.js'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawnSync } from 'child_process'
import { generateWithTextFailover } from '../agents/index.js'
import { generateImage } from '../services/image-generation.js'
import { generateVideo } from '../services/video-generation.js'
import { generateTTS, generateVoiceSample, voiceSampleText } from '../services/tts-generation.js'
import { composeStoryboard } from '../services/ffmpeg-compose.js'
import { mergeEpisodeVideos } from '../services/ffmpeg-merge.js'
import { getTextConfigCandidates, type AIConfig } from '../services/ai.js'
import { dramaOrientation, normalizeOrientation, orientationAspectRatio, orientationImageSize, orientationVideoSize, parseSize } from '../utils/aspect.js'

const app = new Hono()

const EPISODE_HEADING_RE = /(?:^|\n)\s*(?:#{1,6}\s*)?(?:第\s*[0-9一二三四五六七八九十百千]+\s*[集章节回]|episode\s*\d+|ep\s*\d+|第\s*\d+\s*集)[^\n\r]*/gi
const AUTO_TARGET_ORDER = ['storyboard', 'shot_images', 'videos', 'compose'] as const
const AUTO_IMAGE_WAIT_ATTEMPTS = 720
const AUTO_IMAGE_WAIT_DELAY_MS = 5000
const AUTO_VIDEO_WAIT_ATTEMPTS = 720
const AUTO_VIDEO_WAIT_DELAY_MS = 5000
const AUTO_MERGE_WAIT_ATTEMPTS = 360
const AUTO_MERGE_WAIT_DELAY_MS = 5000
const STORAGE_ROOT = process.env.STORAGE_PATH || path.resolve(process.cwd(), '../data/static')
const BLACK_FRAME_PNG = 'static/images/black-frame.png'
const IGNORE_TTS_SPEAKERS = /^(环境音|环境声|音效|效果音|sfx|sound ?effect|bgm|背景音|背景音乐|ambient)$/i
const IGNORE_TTS_TEXT = /^(无|无对白|无台词|无旁白|无需配音|无需对白|none|null|n\/a|na|环境音|环境声|音效|效果音|纯音效|纯环境音|只有环境音|仅环境音|背景音|背景音乐|bgm|sfx|ambient)$/i
type AutoTarget = typeof AUTO_TARGET_ORDER[number]
type AutoJob = {
  id: string
  dramaId: number
  target: AutoTarget
  regenerateMode?: 'missing' | 'overwrite'
  endEpisode?: number | null
  episodeNumbers?: number[]
  concurrency?: number
  status: 'running' | 'paused' | 'completed' | 'failed' | 'cancelled'
  message: string
  detail?: string
  currentStage?: AutoTarget | 'script' | 'extract' | 'voice_design' | 'voice_samples' | 'dubbing' | 'character_images' | 'scene_images'
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

function emptyScenePrompt(prompt: string) {
  return String(prompt || '').trim()
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
    orientation: normalizeOrientation(String(form.orientation || form.aspect_ratio || '')),
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

function assertAutoJobActive(job?: AutoJob | null) {
  if (job?.status === 'cancelled') throw new Error('任务已取消')
}

function describeTarget(target: AutoTarget) {
  return ({ storyboard: '分镜', shot_images: '镜头图片', videos: '视频生成', compose: '最终拼接' } as Record<AutoTarget, string>)[target] || target
}

function splitConfiguredBaseUrls(value?: string | null) {
  return String(value || '')
    .split(/[\s,]+/)
    .map(item => item.trim())
    .filter(Boolean)
}

function resolveAutoConcurrency(drama: any, requested?: number | null) {
  const requestedValue = Number(requested || 0)
  if (Number.isFinite(requestedValue) && requestedValue > 0) return Math.max(1, Math.min(12, Math.floor(requestedValue)))
  const textConfigId = getProjectTextConfigId(drama)
  const rows = db.select().from(schema.aiServiceConfigs)
    .where(eq(schema.aiServiceConfigs.serviceType, 'text'))
    .all()
    .filter((row: any) => row.isActive)
  const row = textConfigId ? rows.find((item: any) => item.id === textConfigId) : rows.find((item: any) => item.isDefault) || rows[0]
  const count = splitConfiguredBaseUrls(row?.baseUrl).length || 1
  return Math.max(1, Math.min(12, count))
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
    rewrittenScripts: episodes.filter(ep => ep.scriptContent && normalizedScriptText(ep.scriptContent) !== normalizedScriptText(ep.content)).length,
    characterLinks: db.select().from(schema.episodeCharacters).all().filter((link: any) => episodeIds.has(link.episodeId)).length,
    sceneLinks: db.select().from(schema.episodeScenes).all().filter((link: any) => episodeIds.has(link.episodeId)).length,
  }
  const warnings = []
  if (targetReached(target, 'storyboard') && counts.rewrittenScripts) warnings.push(`已有 ${counts.rewrittenScripts} 集 AI 改写内容`)
  if (targetReached(target, 'storyboard') && counts.characterLinks) warnings.push(`已有 ${counts.characterLinks} 个角色绑定`)
  if (targetReached(target, 'storyboard') && counts.sceneLinks) warnings.push(`已有 ${counts.sceneLinks} 个场景绑定`)
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

function clearDramaGeneratedAssets(dramaId: number) {
  const ts = now()
  const episodes = db.select().from(schema.episodes).where(eq(schema.episodes.dramaId, dramaId)).all()
  const episodeIds = new Set(episodes.map((ep: any) => ep.id))
  const storyboards = db.select().from(schema.storyboards).all().filter((sb: any) => episodeIds.has(sb.episodeId))
  const scenes = db.select().from(schema.scenes).where(eq(schema.scenes.dramaId, dramaId)).all()
  const characters = db.select().from(schema.characters).where(eq(schema.characters.dramaId, dramaId)).all()
  const props = db.select().from(schema.props).where(eq(schema.props.dramaId, dramaId)).all()
  const videoMerges = db.select().from(schema.videoMerges).where(eq(schema.videoMerges.dramaId, dramaId)).all()
  const imageGenerations = db.select().from(schema.imageGenerations).where(eq(schema.imageGenerations.dramaId, dramaId)).all()
  const videoGenerations = db.select().from(schema.videoGenerations).where(eq(schema.videoGenerations.dramaId, dramaId)).all()
  const assets = db.select().from(schema.assets).where(eq(schema.assets.dramaId, dramaId)).all()
  let clearedAutoJobs = 0

  for (const job of autoJobs.values()) {
    if (job.dramaId !== dramaId) continue
    updateJob(job, {
      status: 'cancelled',
      message: '任务已取消',
      detail: '项目生成内容已清除',
      error: undefined,
    })
    addJobLog(job, '项目生成内容已清除，任务取消')
    const nextStatus = { ...(job.episodeStatus || {}) }
    for (const key of Object.keys(nextStatus)) {
      if (nextStatus[key]?.status === 'running' || nextStatus[key]?.status === 'pending') {
        nextStatus[key] = { ...nextStatus[key], status: 'cancelled', message: '已取消' }
      }
    }
    updateJob(job, { episodeStatus: nextStatus })
    autoJobs.delete(job.id)
    clearedAutoJobs += 1
  }

  for (const sb of storyboards) {
    db.delete(schema.storyboardCharacters).where(eq(schema.storyboardCharacters.storyboardId, sb.id)).run()
  }
  for (const ep of episodes) {
    db.delete(schema.episodeCharacters).where(eq(schema.episodeCharacters.episodeId, ep.id)).run()
    db.delete(schema.episodeScenes).where(eq(schema.episodeScenes.episodeId, ep.id)).run()
    db.delete(schema.storyboards).where(eq(schema.storyboards.episodeId, ep.id)).run()
    db.update(schema.episodes)
      .set({
        scriptContent: null,
        description: null,
        duration: 0,
        status: 'draft',
        videoUrl: null,
        thumbnail: null,
        updatedAt: ts,
      })
      .where(eq(schema.episodes.id, ep.id))
      .run()
  }

  db.delete(schema.characters).where(eq(schema.characters.dramaId, dramaId)).run()
  db.delete(schema.scenes).where(eq(schema.scenes.dramaId, dramaId)).run()
  db.delete(schema.props).where(eq(schema.props.dramaId, dramaId)).run()
  db.delete(schema.imageGenerations).where(eq(schema.imageGenerations.dramaId, dramaId)).run()
  db.delete(schema.videoGenerations).where(eq(schema.videoGenerations.dramaId, dramaId)).run()
  db.delete(schema.videoMerges).where(eq(schema.videoMerges.dramaId, dramaId)).run()
  db.delete(schema.assets).where(eq(schema.assets.dramaId, dramaId)).run()
  db.update(schema.dramas).set({ thumbnail: null, totalDuration: 0, updatedAt: ts }).where(eq(schema.dramas.id, dramaId)).run()

  return {
    episodes: episodes.length,
    storyboards: storyboards.length,
    characters: characters.length,
    scenes: scenes.length,
    props: props.length,
    image_generations: imageGenerations.length,
    video_generations: videoGenerations.length,
    video_merges: videoMerges.length,
    assets: assets.length,
    auto_jobs: clearedAutoJobs,
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

function getProjectImageConfigId(drama: any, kind: 'character' | 'scene' | 'shot', fallback?: number | null) {
  const metadata = drama.metadata ? safeJson(drama.metadata) : {}
  const defaults = metadata?.ai_defaults || {}
  const key = `${kind}_image_config_id`
  return Number(defaults[key] || defaults.image_config_id || fallback || 0) || undefined
}

function safeSettings(config: any) {
  const settings = config?.settings
  if (!settings) return {}
  if (typeof settings === 'object') return settings
  try { return JSON.parse(settings) || {} } catch { return {} }
}

function firstFiniteNumber(...values: any[]) {
  for (const value of values) {
    const num = Number(value)
    if (Number.isFinite(num) && num > 0) return num
  }
  return null
}

function getProjectVideoConfigId(drama: any, fallback?: number | null) {
  const metadata = drama.metadata ? safeJson(drama.metadata) : {}
  const defaults = metadata?.ai_defaults || {}
  return Number(defaults.video_config_id || fallback || 0) || undefined
}

function getVideoConfigById(configId?: number | null) {
  const id = Number(configId || 0)
  if (!id) return null
  return db.select().from(schema.aiServiceConfigs).where(eq(schema.aiServiceConfigs.id, id)).all()[0] || null
}

function configuredVideoSize(config: any, orientation: string) {
  const settings = safeSettings(config)
  const resolution = String(settings.videoResolution ?? settings.video_resolution ?? settings.resolution ?? '').toLowerCase()
  const preset = resolution === '720p' || resolution === '720'
    ? { width: 1280, height: 720 }
    : resolution === '1080p' || resolution === '1080'
      ? { width: 1920, height: 1080 }
      : null
  const width = firstFiniteNumber(preset?.width, settings.defaultWidth, settings.default_width, settings.videoWidth, settings.video_width, settings.width)
  const height = firstFiniteNumber(preset?.height, settings.defaultHeight, settings.default_height, settings.videoHeight, settings.video_height, settings.height)
  if (!width || !height) {
    if (String(config?.provider || '').toLowerCase().startsWith('comfyui')) {
      return orientation === 'landscape' ? '1920x1080' : '1080x1920'
    }
    return orientationVideoSize(orientation)
  }

  const wide = Math.max(width, height)
  const narrow = Math.min(width, height)
  return orientation === 'landscape' ? `${wide}x${narrow}` : `${narrow}x${wide}`
}

function configuredVideoFps(config: any) {
  const settings = safeSettings(config)
  return firstFiniteNumber(settings.fps, settings.defaultFps, settings.default_fps, settings.frameRate, settings.frame_rate)
}

function getProjectAudioDesignConfigId(drama: any, fallback?: number | null) {
  const metadata = drama.metadata ? safeJson(drama.metadata) : {}
  const defaults = metadata?.ai_defaults || {}
  return Number(defaults.audio_design_config_id || defaults.audio_config_id || fallback || 0) || undefined
}

function getProjectAudioCloneConfigId(drama: any, fallback?: number | null) {
  const metadata = drama.metadata ? safeJson(drama.metadata) : {}
  const defaults = metadata?.ai_defaults || {}
  return Number(defaults.audio_clone_config_id || defaults.audio_config_id || fallback || 0) || undefined
}

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

function getStoryboardDialogueCharacters(sb: any, chars: any[]) {
  const links = db.select().from(schema.storyboardCharacters)
    .where(eq(schema.storyboardCharacters.storyboardId, sb.id)).all()
  const ids = new Set(links.map((link: any) => link.characterId))
  return chars.filter((char: any) => ids.has(char.id) && !char.deletedAt)
}

function inferNarratorOwner(sb: any, chars: any[]) {
  const boundCharacters = getStoryboardDialogueCharacters(sb, chars).filter((char: any) => !isVoiceOnlyCharacter(char))
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

async function runEpisodeAgent(agentType: string, message: string, dramaId: number, episodeId: number, textConfigId?: number | null, textConfig?: AIConfig | null) {
  await generateWithTextFailover(agentType, episodeId, dramaId, message, { textConfigId, textConfig, maxSteps: 20 })
}

function assignEpisodeTextConfigs(episodes: any[], textConfigId?: number | null) {
  const candidates = getTextConfigCandidates(textConfigId)
  const assignments = new Map<number, AIConfig>()
  if (!candidates.length) return assignments
  episodes.forEach((ep, index) => {
    assignments.set(ep.id, candidates[index % candidates.length])
  })
  return assignments
}

function createDeferred<T = void>() {
  let resolve!: (value?: T | PromiseLike<T>) => void
  let reject!: (reason?: any) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res as (value?: T | PromiseLike<T>) => void
    reject = rej
  })
  promise.catch(() => {})
  return { promise, resolve, reject }
}

async function runLimited<T>(items: T[], concurrency: number, worker: (item: T, index: number) => Promise<void>) {
  let cursor = 0
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length || 1)) }, async () => {
    while (true) {
      const index = cursor++
      if (index >= items.length) return
      await worker(items[index], index)
    }
  })
  await Promise.all(workers)
}

async function waitFor<T>(read: () => T, done: (value: T) => boolean, label: string, attempts = 180, delay = 3000, job?: AutoJob) {
  for (let i = 0; i < attempts; i++) {
    assertAutoJobActive(job)
    const value = read()
    if (done(value)) return value
    await sleep(delay)
  }
  throw new Error(`${label} 等待超时`)
}

function getStoryboardReferenceAssets(sb: any) {
  const characterRefs: Array<{ type: string; label: string; path: string }> = []
  const sceneRefs: Array<{ type: string; label: string; path: string }> = []
  const pushRef = (target: Array<{ type: string; label: string; path: string }>, type: string, label: string, value?: string | null) => {
    if (!value || [...characterRefs, ...sceneRefs].some(ref => ref.path === value)) return
    target.push({ type, label, path: value })
  }
  const charLinks = db.select().from(schema.storyboardCharacters).where(eq(schema.storyboardCharacters.storyboardId, sb.id)).all()
  for (const link of charLinks as any[]) {
    const [char] = db.select().from(schema.characters).where(eq(schema.characters.id, link.characterId)).all()
    pushRef(characterRefs, 'character', char?.name || '角色', char?.imageUrl)
  }
  if (sb.sceneId) {
    const [scene] = db.select().from(schema.scenes).where(eq(schema.scenes.id, sb.sceneId)).all()
    pushRef(sceneRefs, 'scene', scene?.location || '场景', scene?.imageUrl)
  }
  return [...characterRefs, ...sceneRefs]
}

function getReadyStoryboardReferenceAssets(sb: any) {
  return getStoryboardReferenceAssets(sb).filter(asset => asset.path).slice(0, 8)
}

function labelWithImageIndex(label: string, assets: Array<{ type: string; label: string; path: string }>, type: string) {
  const index = assets.findIndex(asset => asset.type === type && asset.label === label && asset.path)
  return index >= 0 ? `${label}（图${index + 1}）` : label
}

function annotatePromptEntityNames(text: string, names: string[], assets: Array<{ type: string; label: string; path: string }>, type: string) {
  let result = String(text || '')
  for (const name of names.filter(Boolean).sort((a, b) => b.length - a.length)) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    result = result.replace(new RegExp(`${escaped}(?!（图\\d+）)`, 'g'), labelWithImageIndex(name, assets, type))
  }
  return result
}

function getStoryboardImagePrompt(sb: any) {
  const shotType = String(sb.shotType || sb.shot_type || '').trim()
  const imagePrompt = String(sb.imagePrompt || sb.image_prompt || '').trim()
  const assets = getReadyStoryboardReferenceAssets(sb)
  const characterNames = assets.filter(asset => asset.type === 'character').map(asset => asset.label)
  const sceneNames = assets.filter(asset => asset.type === 'scene').map(asset => asset.label)
  let prompt = [shotType, imagePrompt].filter(Boolean).join('，')
  prompt = annotatePromptEntityNames(prompt, characterNames, assets, 'character')
  prompt = annotatePromptEntityNames(prompt, sceneNames, assets, 'scene')
  const guide = assets.map((asset, index) => `${asset.label}=图${index + 1}`).join('，')
  if (guide) {
    prompt = `${prompt}。参考图对应关系：${guide}。画面中的角色外貌必须严格对应各自参考图，场景质感参考对应场景图，不要混淆人物身份。`
  }
  return prompt
}

function isBlackScreenStoryboard(sb: any) {
  const text = [
    sb.title,
    sb.shotType,
    sb.description,
    sb.action,
    sb.imagePrompt,
    sb.videoPrompt,
  ].filter(Boolean).join(' ')
  return /黑屏|画面全黑|全黑/.test(text)
}

function ensureBlackFrameImage() {
  const target = path.join(STORAGE_ROOT, 'images', 'black-frame.png')
  if (!fs.existsSync(target)) {
    fs.mkdirSync(path.dirname(target), { recursive: true })
    const onePixelBlackPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='
    fs.writeFileSync(target, Buffer.from(onePixelBlackPng, 'base64'))
  }
  return BLACK_FRAME_PNG
}

function findReusableFirstFrameImageGen(storyboardId: number) {
  return db.select().from(schema.imageGenerations)
    .where(eq(schema.imageGenerations.storyboardId, storyboardId))
    .all()
    .filter((row: any) => row.frameType === 'first_frame')
    .sort((a: any, b: any) => Number(b.id) - Number(a.id))
    .find((row: any) => row.status === 'processing' || (row.status === 'completed' && row.localPath))
}

function buildCharacterReferencePrompt(char: any) {
  return [
    `角色姓名：${char.name}`,
    char.role ? `角色定位：${char.role}` : '',
    char.appearance ? `稳定外貌设定：${char.appearance}` : '',
    char.description ? `人物基础设定：${char.description}` : '',
    char.personality ? `气质性格：${char.personality}` : '',
    '生成可跨集复用的角色设定参考图',
    '单人全身角色立绘，完整人物从头顶到脚底全部进入画面，头发、脸、上半身、双手、腿、脚踝、鞋子都必须清楚可见',
    '人物直立站姿，居中构图，镜头距离足够远，身体上下留有少量空白，不裁切头部、手臂、腿部、脚部或衣摆',
    '清晰正面或三分之二侧身，五官清楚，表情自然中性，完整展示发型、发色、年龄感、身高体态、服装和标志性配饰',
    '干净背景或浅色纯色背景，按照项目视觉风格渲染，不要半身照、胸像、头像、近景、特写、坐姿、蹲姿、趴卧、被遮挡，不要剧情动作，不要昏迷、受伤、倒地、哭泣、面容模糊，不要多人，不要文字水印',
  ].filter(Boolean).join('；')
}

function getEpisodeCharacters(ep: any) {
  const links = db.select().from(schema.episodeCharacters).where(eq(schema.episodeCharacters.episodeId, ep.id)).all()
  const ids = new Set(links.map((link: any) => link.characterId))
  return db.select().from(schema.characters).all()
    .filter((char: any) => ids.has(char.id) && !char.deletedAt && !/旁白| narrator/i.test(`${char.name || ''} ${char.role || ''}`))
}

function getEpisodeVoiceCharacters(ep: any) {
  const links = db.select().from(schema.episodeCharacters).where(eq(schema.episodeCharacters.episodeId, ep.id)).all()
  const ids = new Set(links.map((link: any) => link.characterId))
  return db.select().from(schema.characters).all()
    .filter((char: any) => ids.has(char.id) && !char.deletedAt && !!char.voiceStyle)
}

function getEpisodeScenes(ep: any) {
  const links = db.select().from(schema.episodeScenes).where(eq(schema.episodeScenes.episodeId, ep.id)).all()
  const ids = new Set(links.map((link: any) => link.sceneId))
  return db.select().from(schema.scenes).all()
    .filter((scene: any) => ids.has(scene.id) && !scene.deletedAt)
}

function getStoryboardReferenceImages(sb: any) {
  return getReadyStoryboardReferenceAssets(sb).map(asset => asset.path)
}

function normalizedScriptText(value?: string | null) {
  return String(value || '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .trim()
}

function needsScriptRewrite(ep: any) {
  const raw = normalizedScriptText(ep.content)
  const script = normalizedScriptText(ep.scriptContent)
  if (!raw) return false
  if (!script) return true
  return script === raw
}

async function ensureScriptRewrite(ep: any, drama: any, textConfigId?: number | null, job?: AutoJob, textConfig?: AIConfig | null) {
  if (needsScriptRewrite(ep)) {
    await runEpisodeAgent('script_rewriter', '请读取剧本并改写为格式化剧本，然后保存', drama.id, ep.id, textConfigId, textConfig)
    await waitFor(
      () => db.select().from(schema.episodes).where(eq(schema.episodes.id, ep.id)).all()[0],
      row => !!row?.scriptContent && normalizedScriptText(row.scriptContent) !== normalizedScriptText(row.content),
      `第${ep.episodeNumber}集 AI 改写`,
      80,
      3000,
      job,
    )
  }
}

async function ensureExtractedContext(ep: any, drama: any, textConfigId?: number | null, job?: AutoJob, textConfig?: AIConfig | null) {
  const charLinks = db.select().from(schema.episodeCharacters).where(eq(schema.episodeCharacters.episodeId, ep.id)).all()
  const sceneLinks = db.select().from(schema.episodeScenes).where(eq(schema.episodeScenes.episodeId, ep.id)).all()
  if (!charLinks.length || !sceneLinks.length) {
    await runEpisodeAgent('extractor', '请从剧本中提取所有角色和场景信息，提取时自动与项目已有数据进行去重合并', drama.id, ep.id, textConfigId, textConfig)
    await waitFor(
      () => ({
        chars: db.select().from(schema.episodeCharacters).where(eq(schema.episodeCharacters.episodeId, ep.id)).all().length,
        scenes: db.select().from(schema.episodeScenes).where(eq(schema.episodeScenes.episodeId, ep.id)).all().length,
      }),
      state => state.chars > 0 && state.scenes > 0,
      `第${ep.episodeNumber}集 角色场景提取`,
      80,
      3000,
      job,
    )
  }
}

async function ensureScriptAndContext(ep: any, drama: any, textConfigId?: number | null, job?: AutoJob, textConfig?: AIConfig | null) {
  await ensureScriptRewrite(ep, drama, textConfigId, job, textConfig)
  await ensureExtractedContext(ep, drama, textConfigId, job, textConfig)
}

async function ensureVoiceDesignAndSamples(ep: any, drama: any, textConfigId?: number | null, job?: AutoJob, textConfig?: AIConfig | null) {
  assertAutoJobActive(job)
  const linkedCharacters = db.select().from(schema.episodeCharacters).where(eq(schema.episodeCharacters.episodeId, ep.id)).all()
  const linkedIds = new Set(linkedCharacters.map((link: any) => link.characterId))
  const chars = db.select().from(schema.characters).all()
    .filter((char: any) => linkedIds.has(char.id) && !char.deletedAt)
  if (!chars.length) return

  if (chars.some((char: any) => !char.voiceStyle)) {
    if (job) {
      updateJob(job, { currentStage: 'voice_design', detail: `第 ${ep.episodeNumber} 集：正在进行音色设计` })
      addJobLog(job, '正在进行音色设计', ep.episodeNumber, 'voice_design')
    }
    await runEpisodeAgent('voice_assigner', '请根据当前角色资料，为所有需要配音的角色、旁白、系统音、画外音和临时声音角色生成中文声音设计提示词并保存。', drama.id, ep.id, textConfigId, textConfig)
    assertAutoJobActive(job)
    await waitFor(
      () => getEpisodeVoiceCharacters(ep),
      rows => rows.length > 0 && rows.every((char: any) => !!char.voiceStyle),
      `第 ${ep.episodeNumber} 集音色设计`,
      80,
      3000,
      job,
    )
  }

  const audioDesignConfigId = getProjectAudioDesignConfigId(drama, ep.audioConfigId)
  const voiceCharacters = getEpisodeVoiceCharacters(ep)
  const missingSamples = voiceCharacters.filter((char: any) => !char.voiceSampleUrl)
  if (!missingSamples.length) return
  if (job) {
    updateJob(job, { currentStage: 'voice_samples', detail: `第 ${ep.episodeNumber} 集：正在生成 ${missingSamples.length} 个试听音色` })
    addJobLog(job, `正在生成 ${missingSamples.length} 个试听音色`, ep.episodeNumber, 'voice_samples')
  }
  await Promise.all(missingSamples.map(async (char: any) => {
    assertAutoJobActive(job)
    try {
      const audioPath = await generateVoiceSample(char.name, String(char.voiceStyle || ''), audioDesignConfigId)
      db.update(schema.characters)
        .set({ voiceSampleUrl: audioPath, updatedAt: now() })
        .where(eq(schema.characters.id, char.id))
        .run()
      if (job) addJobLog(job, `已生成试听音色：${char.name}`, ep.episodeNumber, 'voice_samples')
    } catch (err: any) {
      if (job) addJobLog(job, `试听音色生成失败：${char.name}，${err.message || String(err)}`, ep.episodeNumber, 'voice_samples')
    }
  }))
}

async function ensureStoryboards(ep: any, drama: any, textConfigId?: number | null, job?: AutoJob, textConfig?: AIConfig | null) {
  if (getEpisodeStoryboards(ep.id).length) return
  await ensureScriptAndContext(ep, drama, textConfigId, job, textConfig)
  assertAutoJobActive(job)
  await runEpisodeAgent(
    'storyboard_breaker',
    '请拆解分镜并生成中文视频提示词。请保持镜头连续、时长合理，并为后续图片和视频生成补全中文提示词。',
    drama.id,
    ep.id,
    textConfigId,
    textConfig,
  )
  assertAutoJobActive(job)
  await waitFor(
    () => getEpisodeStoryboards(ep.id),
    rows => rows.length > 0,
    `第${ep.episodeNumber}集 分镜拆解`,
    120,
    3000,
    job,
  )
  await ensureVoiceDesignAndSamples(ep, drama, textConfigId, job, textConfig)
}

async function ensureCharacterImages(ep: any, drama: any) {
  const characters = getEpisodeCharacters(ep)
  const pendingCharacters = characters.filter((char: any) => !char.imageUrl)
  if (!pendingCharacters.length) return
  const tasks: Array<{ char: any; genId: number }> = []

  for (const char of pendingCharacters) {
    const genId = await generateImage({
      characterId: char.id,
      dramaId: drama.id,
      prompt: buildCharacterReferencePrompt(char),
      size: orientationImageSize(dramaOrientation(drama)),
      configId: getProjectImageConfigId(drama, 'character', ep.imageConfigId),
    })
    tasks.push({ char, genId })
  }

  await Promise.all(tasks.map(async ({ char, genId }) => {
    await waitFor(
      () => db.select().from(schema.imageGenerations).where(eq(schema.imageGenerations.id, genId)).all()[0],
      row => row?.status === 'completed' || row?.status === 'failed',
      `第${ep.episodeNumber}集 角色${char.name}形象`,
      AUTO_IMAGE_WAIT_ATTEMPTS,
      AUTO_IMAGE_WAIT_DELAY_MS,
    )
    const [record] = db.select().from(schema.imageGenerations).where(eq(schema.imageGenerations.id, genId)).all()
    if (record?.status === 'failed') throw new Error(record.errorMsg || `角色${char.name}形象生成失败`)
  }))
}

async function ensureSceneImages(ep: any, drama: any) {
  const scenes = getEpisodeScenes(ep)
  const pendingScenes = scenes.filter((scene: any) => !scene.imageUrl)
  if (!pendingScenes.length) return
  const tasks: Array<{ scene: any; genId: number }> = []

  for (const scene of pendingScenes) {
    db.update(schema.scenes).set({ status: 'processing', updatedAt: now() }).where(eq(schema.scenes.id, scene.id)).run()
    const genId = await generateImage({
      sceneId: scene.id,
      dramaId: drama.id,
      prompt: emptyScenePrompt(scene.prompt || [scene.location, scene.time].filter(Boolean).join('，')),
      size: orientationImageSize(dramaOrientation(drama)),
      configId: getProjectImageConfigId(drama, 'scene', ep.imageConfigId),
    })
    tasks.push({ scene, genId })
  }

  await Promise.all(tasks.map(async ({ scene, genId }) => {
    await waitFor(
      () => db.select().from(schema.imageGenerations).where(eq(schema.imageGenerations.id, genId)).all()[0],
      row => row?.status === 'completed' || row?.status === 'failed',
      `第${ep.episodeNumber}集 场景${scene.location}图片`,
      AUTO_IMAGE_WAIT_ATTEMPTS,
      AUTO_IMAGE_WAIT_DELAY_MS,
    )
    const [record] = db.select().from(schema.imageGenerations).where(eq(schema.imageGenerations.id, genId)).all()
    if (record?.status === 'failed') throw new Error(record.errorMsg || `场景${scene.location}图片生成失败`)
  }))
}

async function ensureShotImages(ep: any, drama: any) {
  const storyboards = getEpisodeStoryboards(ep.id)
  const pendingStoryboards = storyboards.filter((sb: any) => !(sb.firstFrameImage || sb.composedImage))
  if (!pendingStoryboards.length) return
  const tasks: Array<{ sb: any; genId: number }> = []

  for (const sb of pendingStoryboards) {
    const reusable = findReusableFirstFrameImageGen(sb.id)
    if (reusable?.status === 'completed' && reusable.localPath) {
      db.update(schema.storyboards)
        .set({ firstFrameImage: reusable.localPath, status: 'image_completed', updatedAt: now() })
        .where(eq(schema.storyboards.id, sb.id))
        .run()
      continue
    }
    if (reusable?.status === 'processing') {
      tasks.push({ sb, genId: reusable.id })
      continue
    }
    if (isBlackScreenStoryboard(sb)) {
      const blackFrame = ensureBlackFrameImage()
      db.update(schema.storyboards)
        .set({ firstFrameImage: blackFrame, status: 'image_completed', updatedAt: now() })
        .where(eq(schema.storyboards.id, sb.id))
        .run()
      continue
    }
    const referenceImages = getStoryboardReferenceImages(sb)
    const genId = await generateImage({
      storyboardId: sb.id,
      dramaId: drama.id,
      prompt: getStoryboardImagePrompt(sb),
      size: orientationImageSize(dramaOrientation(drama)),
      frameType: 'first_frame',
      referenceImages: referenceImages.length ? referenceImages : undefined,
      configId: getProjectImageConfigId(drama, 'shot', ep.imageConfigId),
    })
    tasks.push({ sb, genId })
  }

  await Promise.all(tasks.map(async ({ sb, genId }) => {
    await waitFor(
      () => db.select().from(schema.imageGenerations).where(eq(schema.imageGenerations.id, genId)).all()[0],
      row => row?.status === 'completed' || row?.status === 'failed',
      `第${ep.episodeNumber}集 镜头${sb.storyboardNumber}图片`,
      AUTO_IMAGE_WAIT_ATTEMPTS,
      AUTO_IMAGE_WAIT_DELAY_MS,
    )
    const [record] = db.select().from(schema.imageGenerations).where(eq(schema.imageGenerations.id, genId)).all()
    if (record?.status === 'failed') throw new Error(record.errorMsg || `镜头${sb.storyboardNumber}图片生成失败`)
  }))
}

async function ensureVideos(ep: any, drama: any) {
  const storyboards = getEpisodeStoryboards(ep.id)
  const pending = storyboards.filter((sb: any) => !sb.videoUrl)
  if (!pending.length) return
  const orientation = dramaOrientation(drama)
  const configId = getProjectVideoConfigId(drama, ep.videoConfigId)
  const videoConfig = getVideoConfigById(configId)
  const { width, height } = parseSize(configuredVideoSize(videoConfig, orientation), '1280x720')
  const fps = configuredVideoFps(videoConfig)
  const aspectRatio = orientationAspectRatio(orientation)
  const tasks: Array<{ sb: any; genId: number }> = []

  for (const sb of pending) {
    const first = sb.firstFrameImage || sb.composedImage || ''
    const genId = await generateVideo({
      storyboardId: sb.id,
      dramaId: drama.id,
      prompt: sb.videoPrompt || sb.description || sb.title || '',
      duration: Number(sb.duration || 5),
      aspectRatio,
      width,
      height,
      referenceMode: first ? 'single' : 'none',
      imageUrl: first || undefined,
      fps: fps || undefined,
      configId,
    })
    tasks.push({ sb, genId })
  }

  for (const task of tasks) {
    await waitFor(
      () => db.select().from(schema.videoGenerations).where(eq(schema.videoGenerations.id, task.genId)).all()[0],
      row => row?.status === 'completed' || row?.status === 'failed',
      `第${ep.episodeNumber}集 镜头${task.sb.storyboardNumber}视频`,
      AUTO_VIDEO_WAIT_ATTEMPTS,
      AUTO_VIDEO_WAIT_DELAY_MS,
    )
    const [record] = db.select().from(schema.videoGenerations).where(eq(schema.videoGenerations.id, task.genId)).all()
    if (record?.status === 'failed') throw new Error(record.errorMsg || `镜头${task.sb.storyboardNumber}视频生成失败`)
  }
}

async function ensureDubbing(ep: any, drama: any, job?: AutoJob) {
  const storyboards = getEpisodeStoryboards(ep.id)
  const pending = storyboards
    .map((sb: any) => ({ sb, parsed: parseDialogueForTTS(sb.dialogue) }))
    .filter(({ sb, parsed }) => !parsed.ignorable && !sb.ttsAudioUrl)
  if (!pending.length) return

  const audioCloneConfigId = getProjectAudioCloneConfigId(drama, ep.audioConfigId)
  const dramaCharacters = db.select().from(schema.characters)
    .where(eq(schema.characters.dramaId, drama.id))
    .all()
    .filter((char: any) => !char.deletedAt)

  await Promise.all(pending.map(async ({ sb, parsed }) => {
    assertAutoJobActive(job)
    const speakerCharacter = parsed.speaker
      ? resolveSpeakerCharacter(sb, parsed.speaker, dramaCharacters)
      : null
    if (speakerCharacter?.voiceProvider === 'custom-design' && !speakerCharacter.voiceSampleUrl) {
      throw new Error(`第${ep.episodeNumber}集 镜头${sb.storyboardNumber} 角色「${speakerCharacter.name}」缺少声音样本`)
    }

    const voiceId = speakerCharacter?.voiceStyle || 'alloy'
    db.update(schema.storyboards)
      .set({ status: 'tts_processing', ttsAudioUrl: null, updatedAt: now() })
      .where(eq(schema.storyboards.id, sb.id))
      .run()
    try {
      const audioPath = await generateTTS({
        text: parsed.pureText,
        voice: voiceId,
        purpose: speakerCharacter?.voiceSampleUrl ? 'clone' : undefined,
        instruct: speakerCharacter?.voiceStyle || voiceId,
        refText: speakerCharacter ? voiceSampleText(speakerCharacter.name) : undefined,
        referenceAudioUrl: speakerCharacter?.voiceSampleUrl || null,
        configId: audioCloneConfigId,
      })
      db.update(schema.storyboards)
        .set({ ttsAudioUrl: audioPath, status: 'tts_completed', updatedAt: now() })
        .where(eq(schema.storyboards.id, sb.id))
        .run()
      if (job) addJobLog(job, `已生成镜头${sb.storyboardNumber}配音`, ep.episodeNumber, 'dubbing')
    } catch (err: any) {
      db.update(schema.storyboards)
        .set({ status: 'tts_failed', updatedAt: now() })
        .where(eq(schema.storyboards.id, sb.id))
        .run()
      throw err
    }
  }))
}

async function ensureComposed(ep: any, drama: any) {
  const storyboards = getEpisodeStoryboards(ep.id)
  for (const sb of storyboards) {
    if (sb.composedVideoUrl) continue
    if (!sb.videoUrl) throw new Error(`第${ep.episodeNumber}集 镜头${sb.storyboardNumber}没有视频，无法合成`)
    await composeStoryboard(sb.id)
  }

  const latestStoryboards = getEpisodeStoryboards(ep.id)
  const latestSourceUpdatedAt = latestStoryboards
    .map((sb: any) => Date.parse(sb.updatedAt || sb.createdAt || ''))
    .filter((value: number) => Number.isFinite(value))
    .reduce((max: number, value: number) => Math.max(max, value), 0)
  const merges = db.select().from(schema.videoMerges).where(eq(schema.videoMerges.episodeId, ep.id)).all()
  const latestMerge = merges[merges.length - 1]
  const latestMergeCompletedAt = Date.parse(latestMerge?.completedAt || '')
  if (latestMerge?.status === 'completed' && Number.isFinite(latestMergeCompletedAt) && latestMergeCompletedAt >= latestSourceUpdatedAt) return
  const mergeId = await mergeEpisodeVideos(ep.id, drama.id)
  await waitFor(
    () => db.select().from(schema.videoMerges).where(eq(schema.videoMerges.id, mergeId)).all()[0],
    row => row?.status === 'completed' || row?.status === 'failed',
    `第${ep.episodeNumber}集 最终拼接`,
    AUTO_MERGE_WAIT_ATTEMPTS,
    AUTO_MERGE_WAIT_DELAY_MS,
  )
  const [record] = db.select().from(schema.videoMerges).where(eq(schema.videoMerges.id, mergeId)).all()
  if (record?.status === 'failed') throw new Error(record.errorMsg || `第${ep.episodeNumber}集拼接失败`)
}

async function runAutoJobSequential(job: AutoJob) {
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
      updateJob(job, { currentStage: 'character_images', detail: `第 ${ep.episodeNumber} 集：正在生成角色形象` })
      addJobLog(job, '正在生成角色形象', ep.episodeNumber, 'character_images')
      await ensureCharacterImages(ep, drama)
      await waitIfPaused(job)
      updateJob(job, { currentStage: 'scene_images', detail: `第 ${ep.episodeNumber} 集：正在生成场景图片` })
      addJobLog(job, '正在生成场景图片', ep.episodeNumber, 'scene_images')
      await ensureSceneImages(ep, drama)
      await waitIfPaused(job)
      updateJob(job, { currentStage: 'dubbing', detail: `第 ${ep.episodeNumber} 集：正在生成镜头配音` })
      addJobLog(job, '正在生成镜头配音', ep.episodeNumber, 'dubbing')
      await ensureDubbing(ep, drama, job)
      await waitIfPaused(job)
      updateJob(job, { currentStage: 'shot_images', detail: `第 ${ep.episodeNumber} 集：正在基于角色和场景参考图生成镜头图片` })
      addJobLog(job, '正在基于角色和场景参考图生成镜头图片', ep.episodeNumber, 'shot_images')
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
      updateJob(job, { currentStage: 'compose', detail: `第 ${ep.episodeNumber} 集：正在执行视频配音合成；无台词镜头会输出静音视频` })
      addJobLog(job, '正在执行视频配音合成；无台词镜头会输出静音视频', ep.episodeNumber, 'compose')
      await ensureComposed(ep, drama)
    }
    markEpisodeJob(job, ep.episodeNumber, 'completed', `已生成到${describeTarget(job.target)}`, job.target)
    addJobLog(job, `第 ${ep.episodeNumber} 集完成`, ep.episodeNumber)
    updateJob(job, { completedEpisodes: job.completedEpisodes + 1 })
  }

  updateJob(job, { status: 'completed', message: '自动生成完成', detail: `已完成 ${job.completedEpisodes}/${job.totalEpisodes} 集` })
  addJobLog(job, '任务完成')
}

async function processAutoEpisodeParallel(job: AutoJob, ep: any, drama: any, textConfigId?: number | null, textConfig?: AIConfig | null) {
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
    await ensureStoryboards(ep, drama, textConfigId, job, textConfig)
  }
  if (targetReached(job.target, 'shot_images')) {
    await waitIfPaused(job)
    updateJob(job, { currentStage: 'character_images', detail: `第 ${ep.episodeNumber} 集：正在生成角色形象` })
    addJobLog(job, '正在生成角色形象', ep.episodeNumber, 'character_images')
    await ensureCharacterImages(ep, drama)
    await waitIfPaused(job)
    updateJob(job, { currentStage: 'scene_images', detail: `第 ${ep.episodeNumber} 集：正在生成场景图片` })
    addJobLog(job, '正在生成场景图片', ep.episodeNumber, 'scene_images')
    await ensureSceneImages(ep, drama)
    await waitIfPaused(job)
    updateJob(job, { currentStage: 'dubbing', detail: `第 ${ep.episodeNumber} 集：正在生成镜头配音` })
    addJobLog(job, '正在生成镜头配音', ep.episodeNumber, 'dubbing')
    await ensureDubbing(ep, drama, job)
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
    updateJob(job, { currentStage: 'compose', detail: `第 ${ep.episodeNumber} 集：正在执行视频配音合成；无台词镜头会输出静音视频` })
    addJobLog(job, '正在执行视频配音合成；无台词镜头会输出静音视频', ep.episodeNumber, 'compose')
    await ensureComposed(ep, drama)
  }

  markEpisodeJob(job, ep.episodeNumber, 'completed', `已生成到${describeTarget(job.target)}`, job.target)
  addJobLog(job, `第 ${ep.episodeNumber} 集完成`, ep.episodeNumber)
  updateJob(job, { completedEpisodes: job.completedEpisodes + 1 })
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
  const concurrency = Math.min(resolveAutoConcurrency(drama, job.concurrency), episodes.length)
  job.concurrency = concurrency
  if (job.regenerateMode === 'overwrite') {
    updateJob(job, { detail: '正在按确认选项重置本次范围内资产' })
    addJobLog(job, '已选择重新生成，正在重置本次范围内资产')
    resetAutoAssets(episodes, job.target)
  }
  const textConfigByEpisode = assignEpisodeTextConfigs(episodes, textConfigId)
  const rewriteDone = new Map<number, ReturnType<typeof createDeferred>>()
  const contextDone = new Map<number, ReturnType<typeof createDeferred>>()
  const storyboardDone = new Map<number, ReturnType<typeof createDeferred>>()
  for (const ep of episodes) {
    rewriteDone.set(ep.id, createDeferred())
    contextDone.set(ep.id, createDeferred())
    storyboardDone.set(ep.id, createDeferred())
  }

  updateJob(job, { detail: `目标到${describeTarget(job.target)}，文本任务并行 ${concurrency} 路，ComfyUI 制作任务不限并发下发` })
  addJobLog(job, `任务开始：${episodes.map(ep => `第${ep.episodeNumber}集`).join('、')}，目标到${describeTarget(job.target)}，并行 ${concurrency}`)
  addJobLog(job, 'AI 改写和分镜拆解按文本服务并行；角色、场景和音色按集顺序继承；ComfyUI 制作任务不限并发下发')

  const rewriteQueue = runLimited(episodes, concurrency, async (ep) => {
    const textConfig = textConfigByEpisode.get(ep.id)
    try {
      await waitIfPaused(job)
      assertAutoJobActive(job)
      markEpisodeJob(job, ep.episodeNumber, 'running', '正在 AI 改写', 'script')
      updateJob(job, {
        currentEpisode: ep.episodeNumber,
        currentEpisodeTitle: ep.title,
        currentStage: 'script',
        message: `正在并行改写第 ${ep.episodeNumber} 集`,
        detail: textConfig?.name ? `第 ${ep.episodeNumber} 集锁定文本服务：${textConfig.name}` : `第 ${ep.episodeNumber} 集正在 AI 改写`,
      })
      addJobLog(job, textConfig?.name ? `开始 AI 改写（${textConfig.name}）` : '开始 AI 改写', ep.episodeNumber, 'script')
      await ensureScriptRewrite(ep, drama, textConfigId, job, textConfig)
      addJobLog(job, 'AI 改写完成', ep.episodeNumber, 'script')
      markEpisodeJob(job, ep.episodeNumber, 'pending', 'AI 改写完成，等待前序继承', 'extract')
      rewriteDone.get(ep.id)?.resolve()
    } catch (err) {
      rewriteDone.get(ep.id)?.reject(err)
      throw err
    }
  })

  const contextQueue = (async () => {
    for (const ep of episodes) {
      await waitIfPaused(job)
      const textConfig = textConfigByEpisode.get(ep.id)
      try {
        await rewriteDone.get(ep.id)?.promise
        await waitIfPaused(job)
        assertAutoJobActive(job)
        updateJob(job, {
          currentEpisode: ep.episodeNumber,
          currentEpisodeTitle: ep.title,
          currentStage: 'extract',
          message: `正在整理第 ${ep.episodeNumber} 集共享设定`,
          detail: `第 ${ep.episodeNumber} 集：角色场景提取和音色设计按顺序继承`,
        })
        markEpisodeJob(job, ep.episodeNumber, 'running', '正在整理共享设定', 'extract')
        addJobLog(job, '开始提取角色场景', ep.episodeNumber, 'extract')
        await ensureExtractedContext(ep, drama, textConfigId, job, textConfig)
        addJobLog(job, '角色场景提取完成', ep.episodeNumber, 'extract')
        await ensureVoiceDesignAndSamples(ep, drama, textConfigId, job, textConfig)
        addJobLog(job, '共享设定整理完成，进入制作队列', ep.episodeNumber, 'extract')
        contextDone.get(ep.id)?.resolve()
      } catch (err) {
        contextDone.get(ep.id)?.reject(err)
        throw err
      }
    }
  })()

  const storyboardQueue = runLimited(episodes, concurrency, async (ep) => {
    await contextDone.get(ep.id)?.promise
    await waitIfPaused(job)
    try {
      assertAutoJobActive(job)
      updateJob(job, {
        currentEpisode: ep.episodeNumber,
        currentEpisodeTitle: ep.title,
        currentStage: 'storyboard',
        message: `正在拆解第 ${ep.episodeNumber} 集分镜`,
        detail: `第 ${ep.episodeNumber} 集：正在生成分镜`,
      })
      markEpisodeJob(job, ep.episodeNumber, 'running', '正在生成分镜', 'storyboard')
      addJobLog(job, '正在生成分镜', ep.episodeNumber, 'storyboard')
      await ensureStoryboards(ep, drama, textConfigId, job, textConfigByEpisode.get(ep.id))
      addJobLog(job, '分镜拆解完成', ep.episodeNumber, 'storyboard')
      storyboardDone.get(ep.id)?.resolve()

      if (!targetReached(job.target, 'shot_images')) {
        markEpisodeJob(job, ep.episodeNumber, 'completed', `已生成到${describeTarget(job.target)}`, job.target)
        addJobLog(job, `第 ${ep.episodeNumber} 集完成`, ep.episodeNumber)
        updateJob(job, { completedEpisodes: job.completedEpisodes + 1 })
      } else {
        markEpisodeJob(job, ep.episodeNumber, 'pending', '分镜完成，等待制作任务', 'character_images')
      }
    } catch (err: any) {
      storyboardDone.get(ep.id)?.reject(err)
      const wasCancelled = job.status === 'cancelled' || String(err.message || err).includes('取消')
      markEpisodeJob(job, ep.episodeNumber, wasCancelled ? 'cancelled' : 'failed', wasCancelled ? '任务已取消' : '任务失败', job.currentStage)
      throw err
    }
  })

  const productionQueue = targetReached(job.target, 'shot_images')
    ? runLimited(episodes, Math.max(1, episodes.length), async (ep) => {
      await storyboardDone.get(ep.id)?.promise
      await waitIfPaused(job)
      try {
        assertAutoJobActive(job)
        markEpisodeJob(job, ep.episodeNumber, 'running', `正在生成到${describeTarget(job.target)}`, 'character_images')
        updateJob(job, {
          currentEpisode: ep.episodeNumber,
          currentEpisodeTitle: ep.title,
          currentStage: 'character_images',
          message: `正在制作第 ${ep.episodeNumber} 集素材`,
          detail: `第 ${ep.episodeNumber} 集：正在不限并发下发 ComfyUI 制作任务`,
        })

        await waitIfPaused(job)
        updateJob(job, { currentStage: 'character_images', detail: `第 ${ep.episodeNumber} 集：正在生成角色形象` })
        addJobLog(job, '正在生成角色形象', ep.episodeNumber, 'character_images')
        await ensureCharacterImages(ep, drama)

        await waitIfPaused(job)
        updateJob(job, { currentStage: 'scene_images', detail: `第 ${ep.episodeNumber} 集：正在生成场景图片` })
        addJobLog(job, '正在生成场景图片', ep.episodeNumber, 'scene_images')
        await ensureSceneImages(ep, drama)

        await waitIfPaused(job)
        updateJob(job, { currentStage: 'dubbing', detail: `第 ${ep.episodeNumber} 集：正在生成镜头配音` })
        addJobLog(job, '正在生成镜头配音', ep.episodeNumber, 'dubbing')
        await ensureDubbing(ep, drama, job)

        await waitIfPaused(job)
        updateJob(job, { currentStage: 'shot_images', detail: `第 ${ep.episodeNumber} 集：正在生成镜头图片` })
        addJobLog(job, '正在生成镜头图片', ep.episodeNumber, 'shot_images')
        await ensureShotImages(ep, drama)

        if (targetReached(job.target, 'videos')) {
          await waitIfPaused(job)
          updateJob(job, { currentStage: 'videos', detail: `第 ${ep.episodeNumber} 集：正在生成镜头视频` })
          addJobLog(job, '正在生成镜头视频', ep.episodeNumber, 'videos')
          await ensureVideos(ep, drama)
        }
        if (targetReached(job.target, 'compose')) {
          await waitIfPaused(job)
          updateJob(job, { currentStage: 'compose', detail: `第 ${ep.episodeNumber} 集：正在执行视频配音合成；无台词镜头会输出静音视频` })
          addJobLog(job, '正在执行视频配音合成；无台词镜头会输出静音视频', ep.episodeNumber, 'compose')
          await ensureComposed(ep, drama)
        }

        markEpisodeJob(job, ep.episodeNumber, 'completed', `已生成到${describeTarget(job.target)}`, job.target)
        addJobLog(job, `第 ${ep.episodeNumber} 集完成`, ep.episodeNumber)
        updateJob(job, { completedEpisodes: job.completedEpisodes + 1 })
      } catch (err: any) {
        const wasCancelled = job.status === 'cancelled' || String(err.message || err).includes('取消')
        markEpisodeJob(job, ep.episodeNumber, wasCancelled ? 'cancelled' : 'failed', wasCancelled ? '任务已取消' : '任务失败', job.currentStage)
        throw err
      }
    })
    : Promise.resolve()

  await Promise.all([rewriteQueue, contextQueue, storyboardQueue, productionQueue])
  assertAutoJobActive(job)
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

  const allRows = await query.orderBy(desc(schema.dramas.createdAt))
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
  const orientation = normalizeOrientation(body.orientation || (body.metadata ? safeJson(String(body.metadata)).orientation : ''))
  const res = db.insert(schema.dramas).values({
    title: body.title,
    description: body.description,
    genre: body.genre,
    style: normalizeStyle(body.style),
    totalEpisodes,
    tags: body.tags ? JSON.stringify(body.tags) : null,
    metadata: JSON.stringify({
      ...(body.metadata ? typeof body.metadata === 'string' ? safeJson(body.metadata) : body.metadata : {}),
      orientation,
      aspect_ratio: orientationAspectRatio(orientation),
      image_size: orientationImageSize(orientation),
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
      scriptContent: null,
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
  const requestedConcurrency = body.concurrency === undefined || body.concurrency === null || body.concurrency === ''
    ? null
    : Number(body.concurrency)
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
  const concurrency = resolveAutoConcurrency(drama, requestedConcurrency)
  const ts = new Date().toISOString()
  const job: AutoJob = {
    id: `${id}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    dramaId: id,
    target,
    regenerateMode,
    endEpisode,
    episodeNumbers,
    concurrency,
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
  const preview = {
    target,
    target_label: describeTarget(target),
    total_episodes: episodes.length,
    ...inspectExistingAutoAssets(episodes, target),
  }
  const interrupted = [...autoJobs.values()]
    .filter(job => job.dramaId === id && job.target === target && ['cancelled', 'failed'].includes(job.status))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]
  if (interrupted && !preview.hasExisting) {
    preview.hasExisting = true
    preview.warnings = ['检测到上一次自动任务未完成', ...(preview.warnings || [])]
  }
  return success(c, preview)
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
    for (const [episodeNumber, state] of Object.entries(job.episodeStatus || {})) {
      if (state.status === 'running' || state.status === 'pending') {
        markEpisodeJob(job, Number(episodeNumber), 'cancelled', '任务已取消', state.stage)
      }
    }
    updateJob(job, { status: 'cancelled', message: '自动生成已终止', detail: '已停止分发新任务；正在进行的模型请求返回后不会继续后续步骤' })
    return success(c, job)
  }
  return badRequest(c, 'action must be pause, resume or cancel')
})

// POST /dramas/:id/clear-generated - Clear generated project assets for testing
app.post('/:id/clear-generated', async (c) => {
  const id = Number(c.req.param('id'))
  const [drama] = db.select().from(schema.dramas).where(eq(schema.dramas.id, id)).all()
  if (!drama || drama.deletedAt) return notFound(c, '剧本不存在')

  const body = await c.req.json().catch(() => ({}))
  if (body.confirm !== 'CLEAR') return badRequest(c, '请确认清除操作')

  const counts = clearDramaGeneratedAssets(id)
  return success(c, counts)
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
