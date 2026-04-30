export type DramaOrientation = 'portrait' | 'landscape'

export function parseDramaMetadata(value: unknown): Record<string, any> {
  if (!value) return {}
  if (typeof value === 'object') return value as Record<string, any>
  try {
    return JSON.parse(String(value)) || {}
  } catch {
    return {}
  }
}

export function normalizeOrientation(value?: unknown): DramaOrientation {
  const text = String(value || '').toLowerCase().trim()
  if (['portrait', 'vertical', '9:16', 'shorts', '竖屏'].includes(text)) return 'portrait'
  if (['landscape', 'horizontal', '16:9', 'wide', '横屏'].includes(text)) return 'landscape'
  return 'portrait'
}

export function orientationLabel(value?: unknown) {
  return normalizeOrientation(value) === 'landscape' ? '横屏' : '竖屏'
}

export function orientationAspectRatio(value?: unknown) {
  return normalizeOrientation(value) === 'landscape' ? '16:9' : '9:16'
}

export function orientationImageSize(value?: unknown) {
  return normalizeOrientation(value) === 'landscape' ? '1920x1080' : '1080x1920'
}

export function orientationVideoSize(value?: unknown) {
  return normalizeOrientation(value) === 'landscape' ? '1280x720' : '720x1280'
}

export function parseSize(value?: unknown, fallback = '1024x1024') {
  const match = String(value || fallback).match(/(\d+)\s*x\s*(\d+)/i)
  return {
    width: Number(match?.[1] || 1024),
    height: Number(match?.[2] || 1024),
  }
}

export function dramaOrientation(drama?: { metadata?: unknown } | null) {
  const metadata = parseDramaMetadata(drama?.metadata)
  return normalizeOrientation(metadata.orientation || metadata.aspect_orientation || metadata.aspectRatio || metadata.aspect_ratio)
}
