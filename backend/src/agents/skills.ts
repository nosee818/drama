import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const SKILLS_DIR = path.resolve(__dirname, '../../../skills')
const ACTIVE_SKILLS_FILE = path.join(SKILLS_DIR, '.active-skills.json')
const AGENT_SKILL_MAP: Record<string, string[]> = {
  script_rewriter: ['script_rewriter'],
  extractor: ['extractor'],
  storyboard_breaker: ['storyboard_breaker'],
  voice_assigner: ['voice_assigner'],
  grid_prompt_generator: ['grid_prompt_generator'],
}

function stripFrontmatter(content: string): string {
  if (!content.startsWith('---')) return content.trim()
  const end = content.indexOf('\n---', 3)
  if (end === -1) return content.trim()
  return content.slice(end + 4).trim()
}

function normalizeSkillId(skillId?: string | null): string {
  return String(skillId || '').replace(/\\/g, '/').replace(/^\/+/, '').trim()
}

function skillPath(skillId: string): string {
  return path.join(SKILLS_DIR, normalizeSkillId(skillId), 'SKILL.md')
}

function skillExists(skillId: string): boolean {
  return fs.existsSync(skillPath(skillId))
}

function isAgentSkill(agentType: string, skillId: string): boolean {
  const normalized = normalizeSkillId(skillId)
  return normalized === agentType || normalized.startsWith(`${agentType}/`)
}

function readActiveSkillMap(): Record<string, string> {
  try {
    if (!fs.existsSync(ACTIVE_SKILLS_FILE)) return {}
    const parsed = JSON.parse(fs.readFileSync(ACTIVE_SKILLS_FILE, 'utf-8'))
    if (!parsed || typeof parsed !== 'object') return {}
    return Object.fromEntries(
      Object.entries(parsed)
        .map(([agentType, skillId]) => [agentType, normalizeSkillId(String(skillId || ''))])
        .filter(([, skillId]) => !!skillId),
    )
  } catch {
    return {}
  }
}

function writeActiveSkillMap(map: Record<string, string>) {
  if (!fs.existsSync(SKILLS_DIR)) fs.mkdirSync(SKILLS_DIR, { recursive: true })
  fs.writeFileSync(ACTIVE_SKILLS_FILE, JSON.stringify(map, null, 2), 'utf-8')
}

export function listActiveAgentSkills(): Record<string, string> {
  const map = readActiveSkillMap()
  const result: Record<string, string> = {}
  for (const agentType of Object.keys(AGENT_SKILL_MAP)) {
    const skillId = getActiveAgentSkill(agentType)
    if (skillId) result[agentType] = skillId
  }
  for (const [agentType, skillId] of Object.entries(map)) {
    if (skillId && skillExists(skillId) && isAgentSkill(agentType, skillId)) {
      result[agentType] = skillId
    }
  }
  return result
}

export function getActiveAgentSkill(agentType: string): string | null {
  const activeSkill = readActiveSkillMap()[agentType]
  if (activeSkill && isAgentSkill(agentType, activeSkill) && skillExists(activeSkill)) {
    return activeSkill
  }

  const fallback = AGENT_SKILL_MAP[agentType]?.[0]
  return fallback && skillExists(fallback) ? fallback : null
}

export function setActiveAgentSkill(agentType: string, skillId: string): string {
  const normalized = normalizeSkillId(skillId)
  if (!normalized) throw new Error('skill_id required')
  if (!isAgentSkill(agentType, normalized)) {
    throw new Error('Skill does not belong to this Agent')
  }
  if (!skillExists(normalized)) {
    throw new Error('Skill not found')
  }
  const map = readActiveSkillMap()
  map[agentType] = normalized
  writeActiveSkillMap(map)
  return normalized
}

function readSkill(skillId: string): string {
  const filePath = skillPath(skillId)
  if (!fs.existsSync(filePath)) return ''

  const raw = fs.readFileSync(filePath, 'utf-8')
  const content = stripFrontmatter(raw)
  if (!content) return ''

  return [
    `## Skill: ${skillId}`,
    content,
  ].join('\n')
}

export function loadAgentSkills(agentType: string): string {
  const skillId = getActiveAgentSkill(agentType)
  if (!skillId) return ''
  const content = readSkill(skillId)
  if (!content) return ''

  return [
    '以下是该 Agent 当前应用中的项目技能规范（SKILL.md）。',
    '同一个 Agent 可以有多个 Skill，但本次只会加载被设置为“应用中”的这个 Skill。',
    '你必须在不违背当前工具边界的前提下优先遵守该规范；若与用户明确要求冲突，以用户要求为准。',
    '',
    content,
  ].join('\n')
}
