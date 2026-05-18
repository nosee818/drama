/**
 * Agent 聊天路由 — 非流式版本
 */
import { Hono } from 'hono'
import { agentRunningMessage, generateWithTextFailover, validAgentTypes } from '../agents/index.js'
import { success, badRequest } from '../utils/response.js'
import { logTaskError, logTaskPayload, logTaskProgress, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'

const app = new Hono()

type AgentRunStatus = {
  id: string
  agentType: string
  dramaId: number
  episodeId: number
  textConfigId?: number | null
  status: 'running' | 'completed' | 'failed'
  message: string
  startedAt: string
  updatedAt: string
  error?: string
}

const agentRuns = new Map<string, AgentRunStatus>()

function agentRunKey(dramaId: number, episodeId: number, agentType: string) {
  return `${dramaId}:${episodeId}:${agentType}`
}

function publicRun(run: AgentRunStatus) {
  return {
    id: run.id,
    agent_type: run.agentType,
    drama_id: run.dramaId,
    episode_id: run.episodeId,
    text_config_id: run.textConfigId || null,
    status: run.status,
    message: run.message,
    started_at: run.startedAt,
    updated_at: run.updatedAt,
    error: run.error || '',
  }
}

function pruneAgentRuns() {
  const nowTime = Date.now()
  const maxAge = 6 * 60 * 60 * 1000
  for (const [key, run] of agentRuns.entries()) {
    if (nowTime - new Date(run.updatedAt).getTime() > maxAge) agentRuns.delete(key)
  }
}

function normalizeToolName(entry: any) {
  return entry?.toolName
    || entry?.tool?.toolName
    || entry?.tool?.id
    || entry?.name
    || entry?.type
    || null
}

function normalizeToolResult(entry: any) {
  const result = entry?.result ?? entry?.output ?? entry?.data ?? null
  return typeof result === 'string' ? result : JSON.stringify(result)
}

// GET /agent/current?drama_id=1&episode_id=2 — 查询当前集正在运行的 Agent
app.get('/current', async (c) => {
  pruneAgentRuns()
  const dramaId = Number(c.req.query('drama_id') || 0)
  const episodeId = Number(c.req.query('episode_id') || 0)
  if (!dramaId || !episodeId) return badRequest(c, 'drama_id and episode_id are required')

  const runs = [...agentRuns.values()]
    .filter(run => run.dramaId === dramaId && run.episodeId === episodeId)
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
  const running = runs.find(run => run.status === 'running')
  return success(c, running ? publicRun(running) : null)
})

// POST /agent/:type/chat — 非流式 Agent 对话
app.post('/:type/chat', async (c) => {
  const agentType = c.req.param('type')
  if (!validAgentTypes.includes(agentType)) {
    return badRequest(c, `Invalid agent type: ${agentType}`)
  }

  const body = await c.req.json()
  const { message, drama_id, episode_id, text_config_id } = body
  const dramaId = Number(drama_id || 0)
  const episodeId = Number(episode_id || 0)

  logTaskStart('Agent', agentType, {
    dramaId: drama_id,
    episodeId: episode_id,
    textConfigId: text_config_id || null,
    message,
  })
  logTaskPayload('Agent', `${agentType} input`, body)

  if (!episodeId || !dramaId) {
    logTaskError('Agent', agentType, { reason: 'missing drama_id or episode_id' })
    return badRequest(c, 'drama_id and episode_id are required')
  }

  const startedAt = new Date().toISOString()
  const runKey = agentRunKey(dramaId, episodeId, agentType)
  agentRuns.set(runKey, {
    id: `${runKey}:${Date.now()}`,
    agentType,
    dramaId,
    episodeId,
    textConfigId: text_config_id ? Number(text_config_id) : null,
    status: 'running',
    message: agentRunningMessage(agentType),
    startedAt,
    updatedAt: startedAt,
  })

  const startTime = performance.now()

  try {
    const { result, textConfig, attempts } = await generateWithTextFailover(agentType, episodeId, dramaId, message, {
      textConfigId: text_config_id ? Number(text_config_id) : null,
      maxSteps: 20,
    })

    const elapsed = ((performance.now() - startTime) / 1000).toFixed(1)
    logTaskSuccess('Agent', agentType, {
      elapsedSeconds: elapsed,
      textConfigId: textConfig.id || null,
      textConfigName: textConfig.name || '',
      attempts,
    })
    const currentRun = agentRuns.get(runKey)
    if (currentRun) {
      agentRuns.set(runKey, {
        ...currentRun,
        status: 'completed',
        message: '任务完成',
        updatedAt: new Date().toISOString(),
      })
    }

    // 收集所有 tool calls 和 results
    const toolCalls = result.toolCalls || []
    const toolResults = result.toolResults || []
    const normalizedToolCalls = toolCalls.map((tc: any) => ({
      toolName: normalizeToolName(tc),
      args: tc?.args ?? tc?.input ?? null,
    }))
    const normalizedToolResults = toolResults.map((tr: any) => ({
      toolName: normalizeToolName(tr),
      result: normalizeToolResult(tr),
    }))

    logTaskProgress('Agent', 'tool-summary', {
      agentType,
      toolCalls: normalizedToolCalls.map((tc: any) => tc.toolName),
      toolResults: normalizedToolResults.map((tr: any) => tr.toolName),
    })
    logTaskPayload('Agent', `${agentType} tool-results`, normalizedToolResults)

    return success(c, {
      type: 'done',
      text: result.text || '',
      toolCalls: normalizedToolCalls,
      toolResults: normalizedToolResults,
    })
  } catch (err: any) {
    const elapsed = ((performance.now() - startTime) / 1000).toFixed(1)
    logTaskError('Agent', agentType, { elapsedSeconds: elapsed, error: err.message })
    const currentRun = agentRuns.get(runKey)
    if (currentRun) {
      agentRuns.set(runKey, {
        ...currentRun,
        status: 'failed',
        message: '任务失败',
        error: err.message || 'Agent execution failed',
        updatedAt: new Date().toISOString(),
      })
    }
    console.error(err.stack || err)
    return badRequest(c, err.message || 'Agent execution failed')
  }
})

// GET /agent/:type/debug
app.get('/:type/debug', async (c) => {
  const agentType = c.req.param('type')
  if (!validAgentTypes.includes(agentType)) return badRequest(c, 'Invalid agent type')
  return success(c, { agent_type: agentType, valid: true })
})

export default app
