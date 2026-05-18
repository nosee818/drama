/**
 * Provider Adapter 注册表
 * 根据 provider 名称返回对应的 Adapter 实例
 */
import { MiniMaxImageAdapter } from './minimax-image.js'
import { MiniMaxVideoAdapter } from './minimax-video.js'
import { MiniMaxTTSAdapter } from './minimax-tts.js'
import { GenericTTSAdapter } from './generic-tts.js'
import { OpenAIImageAdapter } from './openai-image.js'
import { GeminiImageAdapter } from './gemini-image.js'
import { VolcEngineImageAdapter } from './volcengine-image.js'
import { VolcEngineVideoAdapter } from './volcengine-video.js'
import { ViduVideoAdapter } from './vidu-video.js'
import { AliImageAdapter } from './ali-image.js'
import { AliVideoAdapter } from './ali-video.js'
import { ComfyUIImageAdapter, ComfyUIVideoAdapter, ComfyUITTSAdapter } from './comfyui.js'
import { GenericVideoAdapter } from './generic-video.js'
import type { ImageProviderAdapter, VideoProviderAdapter, TTSProviderAdapter } from './types.js'

// 图片 Adapter 注册表
export const imageAdapters: Record<string, ImageProviderAdapter> = {
  minimax: new MiniMaxImageAdapter(),
  openai: new OpenAIImageAdapter(),
  gemini: new GeminiImageAdapter(),
  volcengine: new VolcEngineImageAdapter(),
  ali: new AliImageAdapter(),
  comfyui: new ComfyUIImageAdapter(),
  // Chatfire - 待确认 API 格式，暂用 OpenAI
  chatfire: new OpenAIImageAdapter(),
  custom: new OpenAIImageAdapter(),
}

// 视频 Adapter 注册表
export const videoAdapters: Record<string, VideoProviderAdapter> = {
  minimax: new MiniMaxVideoAdapter(),
  volcengine: new VolcEngineVideoAdapter(),
  vidu: new ViduVideoAdapter(),
  ali: new AliVideoAdapter(),
  comfyui: new ComfyUIVideoAdapter(),
  custom: new GenericVideoAdapter(),
  // Chatfire 视频 - 待确认 API 格式
}

// TTS Adapter 注册表
export const ttsAdapters: Record<string, TTSProviderAdapter> = {
  minimax: new MiniMaxTTSAdapter(),
  custom: new GenericTTSAdapter(),
  comfyui: new ComfyUITTSAdapter(),
}

export function getTTSAdapter(provider: string): TTSProviderAdapter {
  const key = provider.toLowerCase()
  if (key.startsWith('comfyui')) return ttsAdapters['comfyui']
  return ttsAdapters[key] || ttsAdapters['custom']
}

/**
 * 获取图片 Adapter
 * @param provider 厂商名称
 * @returns 对应的 Adapter，未知厂商返回 MiniMax 默认
 */
export function getImageAdapter(provider: string): ImageProviderAdapter {
  const key = provider.toLowerCase()
  if (key.startsWith('comfyui')) return imageAdapters['comfyui']
  return imageAdapters[key] || imageAdapters['custom']
}

/**
 * 获取视频 Adapter
 * @param provider 厂商名称
 * @returns 对应的 Adapter，未知厂商返回 MiniMax 默认
 */
export function getVideoAdapter(provider: string): VideoProviderAdapter {
  const key = provider.toLowerCase()
  if (key.startsWith('comfyui')) return videoAdapters['comfyui']
  return videoAdapters[key] || videoAdapters['custom']
}
