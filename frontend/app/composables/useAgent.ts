import { toast } from 'vue-sonner'
import { api } from './useApi'

export function useAgent() {
  const running = ref(false)
  const runningType = ref<string | null>(null)
  const runningMessage = ref('')
  const runningStartedAt = ref('')
  const runningUpdatedAt = ref('')
  const runningId = ref('')
  let pollTimer: ReturnType<typeof setInterval> | null = null

  function stopPolling() {
    if (pollTimer) clearInterval(pollTimer)
    pollTimer = null
  }

  function clearRunning() {
    running.value = false
    runningType.value = null
    runningMessage.value = ''
    runningStartedAt.value = ''
    runningUpdatedAt.value = ''
    runningId.value = ''
    stopPolling()
  }

  function agentMessage(type: string) {
    const messages: Record<string, string> = {
      script_rewriter: '正在改写剧本',
      extractor: '正在提取角色和场景',
      voice_assigner: '正在设计角色音色',
      storyboard_breaker: '正在生成分镜',
      grid_prompt_generator: '正在生成图片提示词',
    }
    return messages[type] || '任务运行中'
  }

  async function sync(dramaId: number, episodeId: number, onDone?: () => void) {
    if (!dramaId || !episodeId) return
    try {
      const current = await api.get<any>(`/agent/current?drama_id=${dramaId}&episode_id=${episodeId}`)
      if (current?.status === 'running') {
        running.value = true
        runningType.value = current.agent_type
        runningMessage.value = current.message || agentMessage(current.agent_type)
        runningStartedAt.value = current.started_at || ''
        runningUpdatedAt.value = current.updated_at || ''
        runningId.value = current.id || ''
        if (!pollTimer) {
          pollTimer = setInterval(() => { void sync(dramaId, episodeId, onDone) }, 5000)
        }
        return
      }
      if (running.value) {
        clearRunning()
        onDone?.()
      }
    } catch {}
  }

  async function run(type: string, msg: string, dramaId: number, episodeId: number, onDone?: () => void, options: { textConfigId?: number | null } = {}) {
    if (running.value) { toast.warning('操作执行中'); return }
    running.value = true
    runningType.value = type
    runningMessage.value = agentMessage(type)
    runningStartedAt.value = new Date().toISOString()
    runningUpdatedAt.value = runningStartedAt.value
    runningId.value = `${dramaId}:${episodeId}:${type}:${Date.now()}`
    if (!pollTimer) {
      pollTimer = setInterval(() => { void sync(dramaId, episodeId, onDone) }, 5000)
    }
    try {
      const data = await api.post<any>(`/agent/${type}/chat`, {
        message: msg,
        drama_id: dramaId,
        episode_id: episodeId,
        text_config_id: options.textConfigId || undefined,
      })
      toast.success('完成')
      onDone?.()
    } catch (err: any) {
      toast.error(err.message)
    } finally {
      clearRunning()
    }
  }

  onBeforeUnmount(stopPolling)

  return { running, runningType, runningMessage, runningStartedAt, runningUpdatedAt, runningId, run, sync }
}
