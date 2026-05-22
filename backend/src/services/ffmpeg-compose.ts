/**
 * FFmpeg 单镜头合成 — 视频 + 可选原声 + TTS音频 + 烧录字幕
 */
import ffmpeg from 'fluent-ffmpeg'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { execFileSync } from 'child_process'
import { v4 as uuid } from 'uuid'
import { db, schema } from '../db/index.js'
import { eq } from 'drizzle-orm'
import { now } from '../utils/response.js'
import { logTaskError, logTaskProgress, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const STORAGE_ROOT = process.env.STORAGE_PATH || path.resolve(__dirname, '../../../data/static')
const DATA_ROOT = path.resolve(__dirname, '../../../data')
let subtitleFilterSupport: boolean | null = null
const IGNORE_TTS_SPEAKERS = /^(环境音|环境声|音效|效果音|sfx|sound ?effect|bgm|背景音|背景音乐|ambient)$/i
const IGNORE_TTS_TEXT = /^(无|无对白|无台词|无旁白|无需配音|无需对白|none|null|n\/a|na|环境音|环境声|音效|效果音|纯音效|纯环境音|只有环境音|仅环境音|背景音|背景音乐|bgm|sfx|ambient)$/i

type ComposeOptions = {
  keepOriginalAudio?: boolean
}

function toAbsPath(relativePath: string): string {
  if (path.isAbsolute(relativePath)) return relativePath
  if (relativePath.startsWith('static/')) return path.join(DATA_ROOT, relativePath)
  return path.join(STORAGE_ROOT, relativePath)
}

function supportsSubtitleFilter(): boolean {
  if (subtitleFilterSupport != null) return subtitleFilterSupport
  try {
    const output = execFileSync('ffmpeg', ['-hide_banner', '-filters'], { encoding: 'utf8' })
    subtitleFilterSupport = /\bsubtitles\b/.test(output)
  } catch {
    subtitleFilterSupport = false
  }
  return subtitleFilterSupport
}

function hasAudioStream(filePath: string): Promise<boolean> {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) {
        resolve(false)
        return
      }
      resolve((metadata.streams || []).some((stream: any) => stream.codec_type === 'audio'))
    })
  })
}

function getMediaDuration(filePath: string): Promise<number> {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) {
        resolve(0)
        return
      }
      const formatDuration = Number(metadata.format?.duration || 0)
      const streamDuration = Math.max(
        0,
        ...(metadata.streams || []).map((stream: any) => Number(stream.duration || 0)).filter(Number.isFinite),
      )
      resolve(Math.max(formatDuration, streamDuration, 0))
    })
  })
}

function formatSrtTime(seconds: number) {
  const totalMs = Math.max(0, Math.floor(seconds * 1000))
  const ms = totalMs % 1000
  const totalSeconds = Math.floor(totalMs / 1000)
  const s = totalSeconds % 60
  const totalMinutes = Math.floor(totalSeconds / 60)
  const m = totalMinutes % 60
  const h = Math.floor(totalMinutes / 60)
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`
}

function parseDialogueForTTS(dialogue?: string | null) {
  const raw = dialogue?.trim() || ''
  if (!raw) return { speaker: '', pureText: '', ignorable: true }
  const speakerMatch = raw.match(/^(.+?)[:：]/)
  const speaker = speakerMatch ? speakerMatch[1].replace(/[（(].+?[)）]/g, '').trim() : ''
  const pureText = raw.replace(/^.+?[:：]\s*/, '').replace(/[（(].+?[)）]/g, '').trim()
  const ignorable = (!!speaker && IGNORE_TTS_SPEAKERS.test(speaker)) || !pureText || IGNORE_TTS_TEXT.test(pureText)
  return { speaker, pureText, ignorable }
}

function activeDubbingRowsForStoryboard(storyboardId: number) {
  return db.select().from(schema.storyboardDubbings)
    .where(eq(schema.storyboardDubbings.storyboardId, storyboardId))
    .all()
    .filter((row: any) => !row.deletedAt)
    .sort((a: any, b: any) => (Number(a.sortOrder || 0) - Number(b.sortOrder || 0)) || (Number(a.id) - Number(b.id)))
}

function getDubbingSegments(sb: any) {
  const rows = activeDubbingRowsForStoryboard(sb.id)
  if (rows.length) {
    return rows
      .map((row: any) => ({
        id: row.id,
        speaker: row.speakerName || '',
        text: String(row.text || '').trim(),
        audioUrl: row.audioUrl || '',
      }))
      .filter((row: any) => row.text && !IGNORE_TTS_TEXT.test(row.text))
  }

  const parsedDialogue = parseDialogueForTTS(sb.dialogue)
  if (parsedDialogue.ignorable) return []
  return [{
    id: 0,
    speaker: parsedDialogue.speaker,
    text: parsedDialogue.pureText,
    audioUrl: sb.ttsAudioUrl || '',
  }]
}

function concatAudioFiles(audioPaths: string[]): Promise<string> {
  if (audioPaths.length === 1) return Promise.resolve(audioPaths[0])
  const outputDir = path.join(STORAGE_ROOT, 'audio')
  fs.mkdirSync(outputDir, { recursive: true })
  const outputPath = path.join(outputDir, `${uuid()}.m4a`)
  return new Promise((resolve, reject) => {
    let cmd = ffmpeg()
    audioPaths.forEach((audioPath) => { cmd = cmd.input(audioPath) })
    const inputs = audioPaths.map((_, index) => `[${index}:a]`).join('')
    cmd.complexFilter([`${inputs}concat=n=${audioPaths.length}:v=0:a=1[aout]`])
      .outputOptions(['-map', '[aout]', '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-b:a', '192k'])
      .output(outputPath)
      .on('end', () => resolve(outputPath))
      .on('error', reject)
      .run()
  })
}

/**
 * 合成单个镜头：原视频画面 + TTS对白音频 + 烧录字幕。
 * 默认不保留原视频自带声音；开启 keepOriginalAudio 时，有 TTS 会混音，无对白镜头会保留原声。
 */
export async function composeStoryboard(storyboardId: number, options: ComposeOptions = {}): Promise<string> {
  const [sb] = db.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboardId)).all()
  if (!sb) throw new Error(`Storyboard ${storyboardId} not found`)
  if (!sb.videoUrl) throw new Error(`Storyboard ${storyboardId} has no video`)
  db.update(schema.storyboards)
    .set({ status: 'compose_processing', composedVideoUrl: null, updatedAt: now() })
    .where(eq(schema.storyboards.id, storyboardId))
    .run()

  logTaskStart('ComposeTask', 'storyboard-compose', {
    storyboardId,
    storyboardNumber: sb.storyboardNumber,
    episodeId: sb.episodeId,
  })

  const videoPath = toAbsPath(sb.videoUrl)
  let audioPath: string | null = null
  let subtitlePath: string | null = null
  const dubbingSegments = getDubbingSegments(sb)

  // 1. 只读取配音生成阶段已经产出的 TTS 音频。合成阶段不再临时生成 TTS，
  // 避免长耗时 TTS 任务阻塞视频合成和最终拼接。
  try {
    if (dubbingSegments.length) {
      const audioPaths: string[] = []
      for (const segment of dubbingSegments) {
        if (segment.audioUrl) {
          const existingAudioPath = toAbsPath(segment.audioUrl)
          if (fs.existsSync(existingAudioPath)) {
            audioPaths.push(existingAudioPath)
            continue
          }
        }
        logTaskError('ComposeTask', 'missing-tts-audio', {
          storyboardId,
          speaker: segment.speaker,
          textPreview: segment.text.slice(0, 40),
        })
        throw new Error(`镜头 ${sb.storyboardNumber || storyboardId} 有台词但缺少配音音频，请先在“配音生成”步骤生成 TTS`)
      }

      if (audioPaths.length) {
        audioPath = await concatAudioFiles(audioPaths)
      } else if (sb.ttsAudioUrl) {
        const existingAudioPath = toAbsPath(sb.ttsAudioUrl)
        if (fs.existsSync(existingAudioPath)) {
          audioPath = existingAudioPath
        }
      }

      if (!audioPath) {
        throw new Error(`镜头 ${sb.storyboardNumber || storyboardId} 有台词但缺少配音音频，请先在“配音生成”步骤生成 TTS`)
      }
    }

    // 2. 生成字幕文件（SRT）
    if (dubbingSegments.length) {
      const srtDir = path.join(STORAGE_ROOT, 'subtitles')
      fs.mkdirSync(srtDir, { recursive: true })
      const srtFilename = `${uuid()}.srt`
      subtitlePath = path.join(srtDir, srtFilename)

      const videoDurationForSubtitle = await getMediaDuration(videoPath)
      const audioDurationForSubtitle = audioPath ? await getMediaDuration(audioPath) : 0
      const duration = Math.ceil(Math.max(videoDurationForSubtitle, audioDurationForSubtitle, Number(sb.duration || 10), 1))
      const segmentDurations = audioPath && dubbingSegments.length > 1
        ? await Promise.all(dubbingSegments.map(segment => segment.audioUrl ? getMediaDuration(toAbsPath(segment.audioUrl)) : Promise.resolve(0)))
        : [duration]
      let cursor = 0.5
      const srtContent = dubbingSegments.map((segment, index) => {
        const segmentDuration = Math.max(1, Number(segmentDurations[index] || duration / dubbingSegments.length || 1))
        const start = cursor
        const end = Math.min(duration, cursor + segmentDuration)
        cursor = end
        return `${index + 1}\n${formatSrtTime(start)} --> ${formatSrtTime(Math.max(start + 0.5, end))}\n${segment.text}\n`
      }).join('\n')
      fs.writeFileSync(subtitlePath, srtContent, 'utf-8')

      const srtRelative = `static/subtitles/${srtFilename}`
      db.update(schema.storyboards).set({ subtitleUrl: srtRelative, updatedAt: now() })
        .where(eq(schema.storyboards.id, storyboardId)).run()
    }

    // 3. FFmpeg 合成
    const outputDir = path.join(STORAGE_ROOT, 'composed')
    fs.mkdirSync(outputDir, { recursive: true })
    const outputFilename = `${uuid()}.mp4`
    const outputPath = path.join(outputDir, outputFilename)
    const keepOriginalAudio = Boolean(options.keepOriginalAudio)
    const sourceHasAudio = keepOriginalAudio ? await hasAudioStream(videoPath) : false
    const videoDuration = await getMediaDuration(videoPath)
    const audioDuration = audioPath ? await getMediaDuration(audioPath) : 0
    const extendVideoBy = Math.max(0, audioDuration - videoDuration)

    await new Promise<void>((resolve, reject) => {
      let cmd = ffmpeg(videoPath)

      if (audioPath) {
        cmd = cmd.input(audioPath)
      }

      const filters: string[] = []

      if (extendVideoBy > 0.05) {
        filters.push(`tpad=stop_mode=add:stop_duration=${extendVideoBy.toFixed(3)}:color=black`)
      }

      if (subtitlePath && supportsSubtitleFilter()) {
        const escapedPath = subtitlePath
          .replace(/\\/g, '/')
          .replace(/:/g, '\\:')
          .replace(/'/g, "\\'")
        const forceStyle = 'FontSize=20\\,PrimaryColour=&HFFFFFF&\\,OutlineColour=&H000000&\\,Outline=2'
        filters.push(`subtitles=filename='${escapedPath}':force_style='${forceStyle}'`)
      } else if (subtitlePath) {
        logTaskProgress('ComposeTask', 'subtitle-filter-unavailable', {
          storyboardId,
          subtitlePath,
        })
      }

      if (filters.length > 0) {
        cmd = cmd.videoFilter(filters)
      }

      const outputOptions = ['-c:v', 'libx264', '-preset', 'fast', '-crf', '23']
      const audioOutputOptions = ['-c:a', 'aac', '-ar', '48000', '-ac', '2', '-b:a', '192k']
      const audioOutputOptionsWithShortest = [...audioOutputOptions, '-shortest']

      if (audioPath && keepOriginalAudio && sourceHasAudio) {
        cmd = cmd.complexFilter(['[0:a][1:a]amix=inputs=2:duration=longest:dropout_transition=0[aout]'])
        outputOptions.push('-map', '0:v', '-map', '[aout]', ...audioOutputOptions)
      } else if (audioPath) {
        outputOptions.push('-map', '0:v', '-map', '1:a', ...audioOutputOptions)
      } else if (keepOriginalAudio && sourceHasAudio) {
        outputOptions.push('-map', '0:v', '-map', '0:a?', ...audioOutputOptions)
      } else {
        cmd = cmd.input('anullsrc=channel_layout=stereo:sample_rate=48000')
          .inputFormat('lavfi')
        outputOptions.push('-map', '0:v', '-map', '1:a', ...audioOutputOptionsWithShortest)
      }

      cmd.outputOptions(outputOptions)
        .output(outputPath)
        .on('end', () => resolve())
        .on('error', (err) => reject(err))
        .run()
    })

    const composedRelative = `static/composed/${outputFilename}`
    db.update(schema.storyboards).set({ composedVideoUrl: composedRelative, status: 'compose_completed', updatedAt: now() })
      .where(eq(schema.storyboards.id, storyboardId)).run()

    logTaskSuccess('ComposeTask', 'storyboard-compose', {
      storyboardId,
      storyboardNumber: sb.storyboardNumber,
      output: composedRelative,
      keepOriginalAudio,
    })
    return composedRelative
  } catch (err) {
    db.update(schema.storyboards)
      .set({ status: 'compose_failed', composedVideoUrl: null, updatedAt: now() })
      .where(eq(schema.storyboards.id, storyboardId))
      .run()
    throw err
  }
}
