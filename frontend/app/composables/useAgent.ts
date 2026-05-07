import { toast } from 'vue-sonner'
import { api } from './useApi'

export function useAgent() {
  const running = ref(false)
  const runningType = ref<string | null>(null)
  const runningMessage = ref('')
  let pollTimer: ReturnType<typeof setInterval> | null = null

  function stopPolling() {
    if (pollTimer) clearInterval(pollTimer)
    pollTimer = null
  }

  function clearRunning() {
    running.value = false
    runningType.value = null
    runningMessage.value = ''
    stopPolling()
  }

  async function sync(dramaId: number, episodeId: number, onDone?: () => void) {
    if (!dramaId || !episodeId) return
    try {
      const current = await api.get<any>(`/agent/current?drama_id=${dramaId}&episode_id=${episodeId}`)
      if (current?.status === 'running') {
        running.value = true
        runningType.value = current.agent_type
        runningMessage.value = current.message || '任务运行中'
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
    runningMessage.value = type === 'storyboard_breaker' ? '正在生成分镜' : '任务运行中'
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

  return { running, runningType, runningMessage, run, sync }
}
