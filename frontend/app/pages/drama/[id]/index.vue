<template>
  <div class="page" v-if="drama">
    <!-- Header -->
    <div class="page-head">
      <div class="head-left">
        <button class="back-btn" @click="navigateTo('/')">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>
          </svg>
          返回
        </button>
        <div class="head-info">
          <h1 class="page-title">{{ drama.title }}</h1>
          <div class="page-meta">
            <span v-if="drama.style" class="style-chip">{{ styleLabel(drama.style) }}</span>
            <span class="style-chip orientation-chip">{{ projectOrientationLabel }}</span>
            <span class="meta-divider"></span>
            <span class="meta-item">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
              {{ drama.characters?.length || 0 }} 角色
            </span>
            <span class="meta-divider"></span>
            <span class="meta-item">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/></svg>
              {{ drama.scenes?.length || 0 }} 场景
            </span>
          </div>
        </div>
      </div>
      <button class="btn btn-primary" @click="openAddEpisode">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round">
          <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
        </svg>
        添加集
      </button>
    </div>

    <section class="defaults-panel">
      <div class="defaults-head">
        <div>
          <div class="section-label defaults-label">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
              <path d="M12 2v20"/><path d="M2 12h20"/><path d="m4.93 4.93 14.14 14.14"/><path d="m19.07 4.93-14.14 14.14"/>
            </svg>
            默认模型
          </div>
          <p class="defaults-copy">用于新建剧集和当前剧集工作台，可随时调整文本、生图、配音和视频服务。</p>
        </div>
        <button class="btn btn-primary" :disabled="savingDefaults || !canSaveDefaults" @click="saveProjectDefaults">
          {{ savingDefaults ? '保存中...' : '保存默认模型' }}
        </button>
      </div>
      <div class="defaults-grid">
        <label class="default-card">
          <span class="config-card-kicker">FORMAT</span>
          <span class="field-label">成片画幅</span>
          <BaseSelect v-model="projectOrientationForm" :options="orientationOptions" placeholder="选择画幅" />
        </label>
        <label class="default-card">
          <span class="config-card-kicker">TEXT</span>
          <span class="field-label">文本模型</span>
          <BaseSelect v-model="defaultTextConfigId" :options="textConfigOptions" placeholder="选择文本模型" searchable />
        </label>
        <label class="default-card">
          <span class="config-card-kicker">CHARACTER</span>
          <span class="field-label">角色形象模型</span>
          <BaseSelect v-model="defaultCharacterImageConfigId" :options="imageConfigOptions" placeholder="选择角色图片服务" searchable />
        </label>
        <label class="default-card">
          <span class="config-card-kicker">SCENE</span>
          <span class="field-label">场景图片模型</span>
          <BaseSelect v-model="defaultSceneImageConfigId" :options="imageConfigOptions" placeholder="选择场景图片服务" searchable />
        </label>
        <label class="default-card">
          <span class="config-card-kicker">SHOT</span>
          <span class="field-label">镜头图片模型</span>
          <BaseSelect v-model="defaultShotImageConfigId" :options="imageConfigOptions" placeholder="选择镜头图片服务" searchable />
        </label>
        <label class="default-card">
          <span class="config-card-kicker">AUDIO</span>
          <span class="field-label">TTS / 音频模型</span>
          <BaseSelect v-model="defaultAudioConfigId" :options="audioConfigOptions" placeholder="选择音频服务" searchable />
        </label>
        <label class="default-card">
          <span class="config-card-kicker">VIDEO</span>
          <span class="field-label">视频模型</span>
          <BaseSelect v-model="defaultVideoConfigId" :options="videoConfigOptions" placeholder="选择视频服务" searchable />
        </label>
      </div>
    </section>

    <section class="auto-panel">
      <div class="auto-head">
        <div>
          <div class="section-label defaults-label">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
              <path d="M13 2 3 14h8l-1 8 11-14h-8l1-6Z"/>
            </svg>
            自动生成
          </div>
          <p class="defaults-copy">选择目标阶段后，系统会按集数顺序补齐前置流程。没有 TTS 配置时会跳过配音和视频配音合成，不阻塞最终拼接。</p>
        </div>
        <div class="auto-actions">
          <button class="btn btn-ghost" @click="taskLogDialog = true">
            任务日志
            <span v-if="finishedAutoJobs.length" class="btn-count">{{ finishedAutoJobs.length }}</span>
          </button>
          <BaseSelect v-model="autoTarget" :options="autoTargetOptions" placeholder="选择目标阶段" style="width:220px" />
          <BaseSelect v-model="autoRangeMode" :options="autoRangeOptions" placeholder="选择范围" style="width:150px" />
          <label v-if="autoRangeMode === 'prefix'" class="auto-range-field">
            <span>前</span>
            <input v-model.number="autoEndEpisode" class="input auto-range-input" type="number" min="1" :max="drama.episodes?.length || 1" />
            <span>集</span>
          </label>
          <button class="btn btn-primary" @click="startAutoGenerate">
            开始自动生成
          </button>
        </div>
      </div>
      <div v-if="autoRangeMode === 'custom'" class="auto-episode-picker">
        <button
          v-for="ep in sortedEpisodes"
          :key="ep.id"
          type="button"
          :class="['episode-toggle', selectedAutoEpisodes.includes(ep.episode_number || ep.episodeNumber) && 'is-selected']"
          @click="toggleAutoEpisode(ep.episode_number || ep.episodeNumber)"
        >
          E{{ String(ep.episode_number || ep.episodeNumber).padStart(2, '0') }}
        </button>
      </div>
      <div v-if="activeAutoJobs.length" class="auto-job-list">
        <article v-for="job in activeAutoJobs" :key="job.id" class="auto-status">
          <div class="auto-progress-head">
            <div class="auto-job-title">
              <span :class="['job-status-dot', `is-${job.status}`]"></span>
              <span>{{ job.message }}</span>
            </div>
            <span class="mono">{{ job.completedEpisodes || 0 }}/{{ job.totalEpisodes || 0 }}</span>
          </div>
          <div class="auto-range-note">{{ describeAutoJob(job) }}</div>
          <div v-if="job.detail" class="auto-detail">{{ job.detail }}</div>
          <div class="auto-progress-bar" :class="{ active: job.status === 'running' }">
            <span :style="{ width: `${jobProgress(job)}%` }"></span>
          </div>
          <div class="auto-status-foot">
            <span v-if="job.currentEpisode">当前：第 {{ job.currentEpisode }} 集 {{ job.currentEpisodeTitle || '' }}</span>
            <span v-if="job.error" class="auto-error">{{ job.error }}</span>
            <div class="job-actions">
              <button v-if="job.status === 'running'" class="btn btn-ghost btn-xs" @click="controlAutoJob(job, 'pause')">暂停</button>
              <button v-if="job.status === 'paused'" class="btn btn-primary btn-xs" @click="controlAutoJob(job, 'resume')">继续</button>
              <button v-if="job.status === 'running' || job.status === 'paused'" class="btn btn-ghost btn-xs" @click="controlAutoJob(job, 'cancel')">终止</button>
              <button v-if="job.status !== 'running' && job.status !== 'paused'" class="btn btn-ghost btn-xs" @click="restartAutoJob(job)">重新开始</button>
            </div>
          </div>
          <details v-if="job.logs?.length" class="job-log">
            <summary>任务记录</summary>
            <div v-for="log in job.logs.slice(-8).reverse()" :key="`${job.id}-${log.at}-${log.message}`" class="job-log-line">
              <span>{{ formatLogTime(log.at) }}</span>
              <span>{{ log.message }}</span>
            </div>
          </details>
        </article>
      </div>
    </section>

    <div v-if="taskLogDialog" class="dialog-mask">
      <div class="card dialog task-log-dialog">
        <div class="dialog-head">
          <div class="dialog-head-copy">
            <div class="dialog-kicker">Task Logs</div>
            <div class="dialog-title-row">
              <div class="dialog-title">任务日志</div>
              <span class="dialog-badge">{{ autoJobs.length }} 条记录</span>
            </div>
            <div class="dialog-sub">已完成、失败、取消和正在运行的自动生成任务都会记录在这里。</div>
          </div>
          <button class="back-btn" @click="taskLogDialog = false">关闭</button>
        </div>
        <div class="task-log-list">
          <article v-for="job in autoJobs" :key="job.id" class="task-log-card">
            <div class="task-log-head">
              <div class="auto-job-title">
                <span :class="['job-status-dot', `is-${job.status}`]"></span>
                <span>{{ job.message }}</span>
              </div>
              <span class="mono">{{ job.completedEpisodes || 0 }}/{{ job.totalEpisodes || 0 }}</span>
            </div>
            <div class="auto-range-note">{{ describeAutoJob(job) }}</div>
            <div v-if="job.detail" class="auto-detail">{{ job.detail }}</div>
            <div class="task-log-actions">
              <button v-if="job.status !== 'running' && job.status !== 'paused'" class="btn btn-ghost btn-xs" @click="restartAutoJob(job)">重新开始</button>
            </div>
            <details v-if="job.logs?.length" class="job-log" open>
              <summary>记录</summary>
              <div v-for="log in job.logs.slice().reverse()" :key="`${job.id}-${log.at}-${log.message}`" class="job-log-line">
                <span>{{ formatLogTime(log.at) }}</span>
                <span>{{ log.message }}</span>
              </div>
            </details>
          </article>
        </div>
      </div>
    </div>

    <div v-if="autoConfirmDialog" class="dialog-mask">
      <div class="card dialog auto-confirm-dialog">
        <div class="dialog-head">
          <div class="dialog-head-copy">
            <div class="dialog-kicker">Auto Generate</div>
            <div class="dialog-title-row">
              <div class="dialog-title">发现已有资产</div>
              <span class="dialog-badge">默认补缺</span>
            </div>
            <div class="dialog-sub">本次范围内已经有部分内容。为了避免误删资产，默认会继续生成缺失部分；只有你明确选择时才会重置并重新生成。</div>
          </div>
          <button class="back-btn" @click="autoConfirmDialog = false">取消</button>
        </div>
        <div class="dialog-section">
          <div class="auto-existing-list">
            <div v-for="item in autoPreview?.warnings || []" :key="item" class="auto-existing-item">{{ item }}</div>
          </div>
          <div class="field-hint">重新生成只会影响本次选择的集数和目标阶段。角色库中已继承的全局人物参考图不会被清空。</div>
        </div>
        <div class="dialog-foot">
          <div class="dialog-foot-copy">建议先选择“继续补缺”。需要完整重做分镜/图片/视频时，再选择重新生成。</div>
          <div class="dialog-actions">
            <button class="btn btn-ghost" @click="autoConfirmDialog = false">取消</button>
            <button class="btn btn-primary" @click="confirmAutoGenerate('missing')">继续补缺</button>
            <button class="btn btn-ghost danger-btn" @click="confirmAutoGenerate('overwrite')">重置并重新生成</button>
          </div>
        </div>
      </div>
    </div>

    <section v-if="characterLibrary.length" class="library-panel">
      <div class="library-head">
        <div>
          <div class="section-label defaults-label">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
              <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>
            </svg>
            角色库
          </div>
          <p class="defaults-copy">跨集复用的角色形象库。同名角色在后续集出现时会继承这里已经制作过的人物形象。</p>
        </div>
        <span class="summary-chip">{{ producedCharacters.length }}/{{ characterLibrary.length }} 已制作形象</span>
      </div>
      <div class="character-grid">
        <article v-for="char in visibleCharacters" :key="char.id" class="character-card">
          <div :class="['character-avatar', characterAvatarClass(char)]">
            <img
              v-if="char.image_url || char.imageUrl"
              :src="assetUrl(char.image_url || char.imageUrl)"
              :alt="char.name"
              @load="rememberImageRatio(char.id, $event)"
            />
            <span v-else>{{ (char.name || '?').slice(0, 1) }}</span>
          </div>
          <div class="character-copy">
            <div class="character-title-row">
              <div class="character-name">{{ char.name }}</div>
              <span v-if="isPendingCharacterImage(char.id)" class="mini-status">生成中</span>
            </div>
            <div class="character-role">{{ char.role || '未设定位' }}</div>
            <div class="character-meta">
              <span>{{ char.episode_count || 0 }} 集出现</span>
              <span v-if="char.image_url || char.imageUrl">已有人物图</span>
              <span v-else>待制作形象</span>
            </div>
            <div class="character-actions">
              <button class="btn btn-ghost btn-xs" @click="openCharacterEditor(char)">编辑</button>
              <button class="btn btn-primary btn-xs" :disabled="isPendingCharacterImage(char.id)" @click="regenerateCharacterImage(char)">
                {{ isPendingCharacterImage(char.id) ? '生成中' : '重新生成' }}
              </button>
            </div>
          </div>
        </article>
      </div>
      <button v-if="characterLibrary.length > visibleCharacters.length" class="btn btn-ghost btn-sm library-more" @click="showAllCharacters = true">
        展开全部 {{ characterLibrary.length }} 个角色
      </button>
    </section>

    <div v-if="characterDialog" class="dialog-mask">
      <div class="card dialog character-dialog">
        <div class="dialog-head">
          <div class="dialog-head-copy">
            <div class="dialog-kicker">Character Library</div>
            <div class="dialog-title-row">
              <div class="dialog-title">编辑角色</div>
              <span class="dialog-badge">跨集复用</span>
            </div>
            <div class="dialog-sub">这里保存的是整部剧的统一角色资料。修改后，后续分镜和生图都会优先读取这份角色设定。</div>
          </div>
          <button class="back-btn" @click="closeCharacterEditor">取消</button>
        </div>
        <div class="dialog-body">
          <div class="dialog-section">
            <div class="config-grid character-form-grid">
              <label class="field">
                <span class="field-label">姓名</span>
                <input v-model="characterForm.name" class="input" placeholder="角色姓名" />
              </label>
              <label class="field">
                <span class="field-label">定位</span>
                <input v-model="characterForm.role" class="input" placeholder="主角、反派、配角..." />
              </label>
            </div>
            <label class="field">
              <span class="field-label">外貌设定</span>
              <textarea v-model="characterForm.appearance" class="textarea" rows="4" placeholder="稳定参考图设定：年龄感、身高体态、国籍/地域气质、脸型五官、发型发色、是否戴眼镜、常服、标志性配饰。不要写昏迷、受伤、倒地、面容模糊等剧情状态。" />
            </label>
            <label class="field">
              <span class="field-label">性格</span>
              <textarea v-model="characterForm.personality" class="textarea" rows="2" placeholder="稳定性格和气质，例如沉稳、敏感、强势、精英感、少年感等。" />
            </label>
            <label class="field">
              <span class="field-label">描述</span>
              <textarea v-model="characterForm.description" class="textarea" rows="3" placeholder="补充人物背景和重要设定" />
            </label>
            <label class="field">
              <span class="field-label">音色</span>
              <input v-model="characterForm.voice_style" class="input" placeholder="可选，例如：沉稳男声、清冷女声" />
            </label>
          </div>
        </div>
        <div class="dialog-foot">
          <div class="dialog-foot-copy">保存后不会自动覆盖已经生成的视频，但重新生成图片会使用新的角色设定。</div>
          <div class="dialog-actions">
            <button class="btn btn-ghost" :disabled="savingCharacter" @click="closeCharacterEditor">取消</button>
            <button class="btn btn-primary" :disabled="savingCharacter || !characterForm.name.trim()" @click="saveCharacter">
              {{ savingCharacter ? '保存中...' : '保存角色' }}
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- Episode List -->
    <div class="section-label">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
        <rect x="2" y="2" width="20" height="20" rx="2.5"/>
        <line x1="7" y1="8" x2="7" y2="16"/>
        <line x1="10" y1="8" x2="10" y2="16"/>
        <line x1="13" y1="8" x2="13" y2="16"/>
        <line x1="16" y1="8" x2="16" y2="16"/>
      </svg>
      剧集列表
    </div>

    <div class="ep-grid">
      <div
        v-for="(ep, i) in drama.episodes"
        :key="ep.id"
        class="card ep-card"
        :style="{ animationDelay: `${i * 0.05}s` }"
        @click="navigateTo(`/drama/${drama.id}/episode/${ep.episode_number || ep.episodeNumber}`)"
      >
        <div class="ep-number">E{{ String(ep.episode_number || ep.episodeNumber).padStart(2, '0') }}</div>
        <div class="ep-body">
          <span class="ep-title">{{ ep.title }}</span>
          <div class="ep-status">
            <span :class="['status-dot', episodeAutoJob(ep)?.episodeStatus?.[String(ep.episode_number || ep.episodeNumber)]?.status === 'running' ? 'dot-running' : hasScript(ep) ? 'dot-ready' : 'dot-pending']"></span>
            <span class="status-text">{{ episodeAutoJob(ep)?.episodeStatus?.[String(ep.episode_number || ep.episodeNumber)]?.message || (hasScript(ep) ? '已完成剧本' : '待编写') }}</span>
            <span v-if="ep.duration" class="ep-duration">{{ ep.duration }}s</span>
          </div>
        </div>
        <div class="ep-arrow">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="9 18 15 12 9 6"/>
          </svg>
        </div>
      </div>

      <!-- Empty episode state -->
      <div v-if="!drama.episodes?.length" class="card ep-empty">
        <div class="ep-empty-icon">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round">
            <circle cx="12" cy="12" r="10"/>
            <line x1="12" y1="8" x2="12" y2="16"/>
            <line x1="8" y1="12" x2="16" y2="12"/>
          </svg>
        </div>
        <p>点击上方「添加集」创建第一集</p>
      </div>
    </div>

    <div v-if="addDialog" class="dialog-mask">
      <div class="card dialog">
        <div class="dialog-head">
          <div class="dialog-head-copy">
            <div class="dialog-kicker">Episode Setup</div>
            <div class="dialog-title-row">
              <div class="dialog-title">创建新集</div>
              <span class="dialog-badge">配置将锁定</span>
            </div>
            <div class="dialog-sub">为这一集预先锁定图片、视频和音频生成服务。创建后，这些生成链路将始终跟随当前集配置。</div>
          </div>
          <button class="back-btn" @click="addDialog = false">取消</button>
        </div>
        <div class="dialog-summary">
          <div class="summary-chip">文本 · {{ textConfigs.length }} 可选</div>
          <div class="summary-chip">图片 · {{ imageConfigs.length }} 可选</div>
          <div class="summary-chip">视频 · {{ videoConfigs.length }} 可选</div>
          <div class="summary-chip">音频 · {{ audioConfigs.length }} 可选</div>
        </div>
        <div class="dialog-body">
          <div class="dialog-section">
            <div class="dialog-section-head">
              <span class="dialog-section-title">基础信息</span>
              <span class="dialog-section-copy">这一项只影响显示名称，不影响生成配置</span>
            </div>
            <label class="field">
              <span class="field-label">标题</span>
              <input v-model="newEpisodeTitle" class="input" placeholder="默认按集数自动命名" />
              <span class="field-hint">留空时会自动按集数命名，例如“第 3 集”。</span>
            </label>
          </div>

          <div class="dialog-section">
            <div class="dialog-section-head">
              <span class="dialog-section-title">生成配置</span>
              <span class="dialog-section-copy">创建后不可更改，建议在这里一次性选对</span>
            </div>
            <div class="config-grid">
              <label class="config-card">
                <span class="config-card-kicker">IMAGE</span>
                <span class="field-label">图片配置</span>
                <BaseSelect v-model="newEpisodeImageConfigId" :options="imageConfigOptions" placeholder="选择图片服务" searchable />
              </label>
              <label class="config-card">
                <span class="config-card-kicker">VIDEO</span>
                <span class="field-label">视频配置</span>
                <BaseSelect v-model="newEpisodeVideoConfigId" :options="videoConfigOptions" placeholder="选择视频服务" searchable />
              </label>
              <label class="config-card">
                <span class="config-card-kicker">AUDIO</span>
                <span class="field-label">音频配置</span>
                <BaseSelect v-model="newEpisodeAudioConfigId" :options="audioConfigOptions" placeholder="选择音频服务" searchable />
              </label>
            </div>
          </div>
        </div>
        <div class="dialog-foot">
          <div class="dialog-foot-copy">创建后，工作台中的图片、视频、音频生成入口都会锁定到当前集。</div>
          <button class="btn btn-primary" :disabled="creatingEpisode || !canCreateEpisode" @click="addEpisode">
            {{ creatingEpisode ? '创建中...' : '创建并锁定配置' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { toast } from 'vue-sonner'
import { aiConfigAPI, characterAPI, dramaAPI, episodeAPI } from '~/composables/useApi'

const route = useRoute()
const drama = ref(null)
const dramaId = Number(route.params.id)
const addDialog = ref(false)
const creatingEpisode = ref(false)
const savingDefaults = ref(false)
const autoTarget = ref('storyboard')
const autoRangeMode = ref('all')
const autoEndEpisode = ref(null)
const selectedAutoEpisodes = ref([])
const autoJob = ref(null)
const autoJobs = ref([])
const autoPollJobIds = ref([])
const autoRunning = computed(() => autoJobs.value.some(job => job.status === 'running'))
const taskLogDialog = ref(false)
const autoConfirmDialog = ref(false)
const autoPreview = ref(null)
const pendingAutoPayload = ref(null)
const showAllCharacters = ref(false)
const characterDialog = ref(false)
const editingCharacter = ref(null)
const savingCharacter = ref(false)
const pendingCharacterImageIds = ref([])
const imageRatios = ref({})
const characterForm = ref({
  name: '',
  role: '',
  description: '',
  appearance: '',
  personality: '',
  voice_style: '',
})
const newEpisodeTitle = ref('')
const textConfigs = ref([])
const imageConfigs = ref([])
const videoConfigs = ref([])
const audioConfigs = ref([])
const defaultTextConfigId = ref(null)
const defaultImageConfigId = ref(null)
const defaultCharacterImageConfigId = ref(null)
const defaultSceneImageConfigId = ref(null)
const defaultShotImageConfigId = ref(null)
const defaultVideoConfigId = ref(null)
const defaultAudioConfigId = ref(null)
const projectOrientationForm = ref('portrait')
const newEpisodeImageConfigId = ref(null)
const newEpisodeVideoConfigId = ref(null)
const newEpisodeAudioConfigId = ref(null)
const autoTargetOptions = [
  { label: '到分镜', value: 'storyboard' },
  { label: '到镜头图片', value: 'shot_images' },
  { label: '到视频生成', value: 'videos' },
  { label: '到最终拼接', value: 'compose' },
]
const autoRangeOptions = [
  { label: '全剧', value: 'all' },
  { label: '前 N 集', value: 'prefix' },
  { label: '指定集数', value: 'custom' },
]
const orientationOptions = [
  { label: '竖屏 9:16', value: 'portrait' },
  { label: '横屏 16:9', value: 'landscape' },
]

function hasScript(ep) { return !!(ep.script_content || ep.scriptContent) }

function toggleAutoEpisode(number) {
  const value = Number(number)
  if (!Number.isFinite(value)) return
  selectedAutoEpisodes.value = selectedAutoEpisodes.value.includes(value)
    ? selectedAutoEpisodes.value.filter(item => item !== value)
    : [...selectedAutoEpisodes.value, value].sort((a, b) => a - b)
}

function targetLabel(target) {
  return ({ storyboard: '分镜', shot_images: '镜头图片', videos: '视频生成', compose: '最终拼接' })[target] || target
}

function describeAutoJob(job) {
  const range = job.episodeNumbers?.length
    ? `第 ${job.episodeNumbers.join('、')} 集`
    : job.endEpisode ? `第 1 集到第 ${job.endEpisode} 集` : '全剧'
  return `${range} · 生成到${targetLabel(job.target)}`
}

function formatLogTime(value) {
  if (!value) return ''
  try { return new Date(value).toLocaleTimeString('zh-CN', { hour12: false }) } catch { return '' }
}

function upsertAutoJob(job) {
  if (!job) return
  autoJob.value = job
  const index = autoJobs.value.findIndex(item => item.id === job.id)
  if (index >= 0) autoJobs.value.splice(index, 1, job)
  else autoJobs.value.unshift(job)
  autoJobs.value = autoJobs.value.slice(0, 20)
}

function episodeAutoJob(ep) {
  const number = String(ep.episode_number || ep.episodeNumber)
  return autoJobs.value.find(job => job.episodeStatus?.[number] && ['running', 'paused'].includes(job.status))
    || autoJobs.value.find(job => job.episodeStatus?.[number])
}

function configLabel(config) {
  if (!config) return ''
  let modelName = ''
  try { const m = JSON.parse(config.model || '[]'); modelName = Array.isArray(m) ? (m[0] || '') : (m || '') } catch { modelName = config.model || '' }
  return modelName ? `${config.name} · ${modelName} (${config.provider})` : `${config.name} (${config.provider})`
}

const textConfigOptions = computed(() => textConfigs.value.map(c => ({ label: configLabel(c), value: c.id })))
const imageConfigOptions = computed(() => imageConfigs.value.map(c => ({ label: configLabel(c), value: c.id })))
const videoConfigOptions = computed(() => videoConfigs.value.map(c => ({ label: configLabel(c), value: c.id })))
const audioConfigOptions = computed(() => audioConfigs.value.map(c => ({ label: configLabel(c), value: c.id })))
const canCreateEpisode = computed(() => !!(newEpisodeImageConfigId.value && newEpisodeVideoConfigId.value && newEpisodeAudioConfigId.value))
const canSaveDefaults = computed(() => !!(projectOrientationForm.value || defaultTextConfigId.value || defaultImageConfigId.value || defaultCharacterImageConfigId.value || defaultSceneImageConfigId.value || defaultShotImageConfigId.value || defaultVideoConfigId.value || defaultAudioConfigId.value))
const sortedEpisodes = computed(() => [...(drama.value?.episodes || [])].sort((a, b) => Number(a.episode_number || a.episodeNumber) - Number(b.episode_number || b.episodeNumber)))
function jobProgress(job) {
  const total = Number(job?.totalEpisodes || 0)
  if (!total) return 0
  return Math.min(100, Math.round((Number(job?.completedEpisodes || 0) / total) * 100))
}
const activeAutoJobs = computed(() => autoJobs.value.filter(job => job.status === 'running' || job.status === 'paused'))
const finishedAutoJobs = computed(() => autoJobs.value.filter(job => !['running', 'paused'].includes(job.status)))
const characterLibrary = computed(() => {
  const chars = drama.value?.characters || []
  return [...chars].sort((a, b) => {
    const producedDelta = Number(!!(b.image_url || b.imageUrl)) - Number(!!(a.image_url || a.imageUrl))
    if (producedDelta) return producedDelta
    return Number(b.episode_count || b.episodeCount || 0) - Number(a.episode_count || a.episodeCount || 0)
  })
})
const producedCharacters = computed(() => characterLibrary.value.filter(c => c.image_url || c.imageUrl || c.voice_sample_url || c.voiceSampleUrl))
const visibleCharacters = computed(() => showAllCharacters.value ? characterLibrary.value : characterLibrary.value.slice(0, 8))
const projectOrientation = computed(() => normalizeOrientation(parseMetadata(drama.value?.metadata).orientation || parseMetadata(drama.value?.metadata).aspect_ratio))
const projectOrientationLabel = computed(() => projectOrientation.value === 'landscape' ? '横屏 16:9' : '竖屏 9:16')

function assetUrl(value) {
  if (!value) return ''
  if (/^https?:\/\//.test(value)) return value
  return value.startsWith('/') ? value : `/${value}`
}

function normalizeOrientation(value) {
  const text = String(value || '').toLowerCase()
  if (['landscape', 'horizontal', '16:9', 'wide', '横屏'].includes(text)) return 'landscape'
  return 'portrait'
}

function styleLabel(value) {
  return ({
    realistic: '写实',
    anime: '动漫',
    ghibli: '吉卜力',
    cinematic: '电影感',
    comic: '漫画',
    watercolor: '水彩',
  })[value] || value
}

function rememberImageRatio(id, event) {
  const img = event.target
  if (!img?.naturalWidth || !img?.naturalHeight) return
  imageRatios.value = {
    ...imageRatios.value,
    [id]: img.naturalWidth / img.naturalHeight,
  }
}

function characterAvatarClass(char) {
  if (!(char?.image_url || char?.imageUrl)) return 'is-empty'
  const ratio = imageRatios.value[char.id]
  if (!ratio) return projectOrientation.value === 'landscape' ? 'is-wide' : 'is-tall'
  if (ratio > 1.25) return 'is-wide'
  if (ratio < 0.82) return 'is-tall'
  return 'is-square'
}

function characterImage(char) {
  return char?.image_url || char?.imageUrl || ''
}

function isPendingCharacterImage(id) {
  return pendingCharacterImageIds.value.includes(id)
}

function firstEpisodeIdForCharacter(char) {
  const ids = char?.episode_ids || char?.episodeIds || []
  if (ids.length) return ids[0]
  return drama.value?.episodes?.[0]?.id || null
}

function openCharacterEditor(char) {
  editingCharacter.value = char
  characterForm.value = {
    name: char.name || '',
    role: char.role || '',
    description: char.description || '',
    appearance: char.appearance || '',
    personality: char.personality || '',
    voice_style: char.voice_style || char.voiceStyle || '',
  }
  characterDialog.value = true
  nextTick(() => {
    document.querySelector('.character-dialog .dialog-body')?.scrollTo({ top: 0 })
  })
}

function closeCharacterEditor() {
  if (savingCharacter.value) return
  characterDialog.value = false
  editingCharacter.value = null
}

async function saveCharacter() {
  if (!editingCharacter.value) return
  try {
    savingCharacter.value = true
    await characterAPI.update(editingCharacter.value.id, {
      name: characterForm.value.name.trim(),
      role: characterForm.value.role,
      description: characterForm.value.description,
      appearance: characterForm.value.appearance,
      personality: characterForm.value.personality,
      voice_style: characterForm.value.voice_style,
    })
    toast.success('角色已保存')
    characterDialog.value = false
    editingCharacter.value = null
    await load()
  } catch (e) {
    toast.error(e.message)
  } finally {
    savingCharacter.value = false
  }
}

async function regenerateCharacterImage(char) {
  const id = char.id
  try {
    if (!isPendingCharacterImage(id)) pendingCharacterImageIds.value.push(id)
    await characterAPI.generateImage(id, firstEpisodeIdForCharacter(char))
    toast.success('角色形象已开始重新生成')
    await load()
    pollCharacterImage(id, characterImage(char))
  } catch (e) {
    pendingCharacterImageIds.value = pendingCharacterImageIds.value.filter(item => item !== id)
    toast.error(e.message)
  }
}

async function pollCharacterImage(id, previousImage = '') {
  for (let i = 0; i < 40; i++) {
    await new Promise(resolve => setTimeout(resolve, 3000))
    await load()
    const char = (drama.value?.characters || []).find(item => item.id === id)
    const nextImage = characterImage(char)
    if (nextImage && nextImage !== previousImage) {
      pendingCharacterImageIds.value = pendingCharacterImageIds.value.filter(item => item !== id)
      toast.success('角色形象已更新')
      return
    }
  }
  pendingCharacterImageIds.value = pendingCharacterImageIds.value.filter(item => item !== id)
}

function parseMetadata(value) {
  if (!value) return {}
  if (typeof value === 'object') return value
  try { return JSON.parse(value) || {} } catch { return {} }
}

function activeFirst(configs) {
  return [...configs]
    .filter(c => c.is_active !== false)
    .sort((a, b) => {
      if (!!a.is_default !== !!b.is_default) return a.is_default ? -1 : 1
      return (Number(b.priority) || 0) - (Number(a.priority) || 0)
    })[0] || configs[0] || null
}

function projectDefaults() {
  return parseMetadata(drama.value?.metadata).ai_defaults || {}
}

function applyProjectDefaultsToForm() {
  const defaults = projectDefaults()
  projectOrientationForm.value = projectOrientation.value
  defaultTextConfigId.value = defaults.text_config_id || defaultTextConfigId.value || activeFirst(textConfigs.value)?.id || null
  defaultImageConfigId.value = defaults.image_config_id || defaultImageConfigId.value || activeFirst(imageConfigs.value)?.id || null
  defaultCharacterImageConfigId.value = defaults.character_image_config_id || defaults.image_config_id || defaultCharacterImageConfigId.value || activeFirst(imageConfigs.value)?.id || null
  defaultSceneImageConfigId.value = defaults.scene_image_config_id || defaults.image_config_id || defaultSceneImageConfigId.value || activeFirst(imageConfigs.value)?.id || null
  defaultShotImageConfigId.value = defaults.shot_image_config_id || defaults.image_config_id || defaultShotImageConfigId.value || activeFirst(imageConfigs.value)?.id || null
  defaultVideoConfigId.value = defaults.video_config_id || defaultVideoConfigId.value || activeFirst(videoConfigs.value)?.id || null
  defaultAudioConfigId.value = defaults.audio_config_id || defaultAudioConfigId.value || activeFirst(audioConfigs.value)?.id || null
}

function syncNewEpisodeDefaults() {
  newEpisodeImageConfigId.value = defaultShotImageConfigId.value || defaultImageConfigId.value || activeFirst(imageConfigs.value)?.id || null
  newEpisodeVideoConfigId.value = defaultVideoConfigId.value || activeFirst(videoConfigs.value)?.id || null
  newEpisodeAudioConfigId.value = defaultAudioConfigId.value || activeFirst(audioConfigs.value)?.id || null
}

async function load() {
  try {
    drama.value = await dramaAPI.get(dramaId)
    if (!autoEndEpisode.value) autoEndEpisode.value = drama.value?.episodes?.length || null
    if (!selectedAutoEpisodes.value.length) {
      selectedAutoEpisodes.value = sortedEpisodes.value
        .map(ep => ep.episode_number || ep.episodeNumber)
        .slice(0, Math.min(5, sortedEpisodes.value.length))
    }
    applyProjectDefaultsToForm()
    syncNewEpisodeDefaults()
  } catch (e) {
    toast.error(e.message)
  }
}

async function loadConfigs() {
  try {
    const [texts, imgs, vids, auds] = await Promise.all([
      aiConfigAPI.list('text'),
      aiConfigAPI.list('image'),
      aiConfigAPI.list('video'),
      aiConfigAPI.list('audio'),
    ])
    textConfigs.value = texts || []
    imageConfigs.value = imgs || []
    videoConfigs.value = vids || []
    audioConfigs.value = auds || []
    applyProjectDefaultsToForm()
    syncNewEpisodeDefaults()
  } catch (e) {
    toast.error(e.message)
  }
}

async function restoreAutoGenerateJob() {
  try {
    const jobs = await dramaAPI.autoGenerateJobs(dramaId)
    autoJobs.value = jobs || []
    for (const job of autoJobs.value) {
      if (job.status === 'running' || job.status === 'paused') {
        pollAutoGenerate(job.id)
      }
    }
  } catch {
  }
}

function openAddEpisode() {
  newEpisodeTitle.value = ''
  syncNewEpisodeDefaults()
  addDialog.value = true
}

async function saveProjectDefaults() {
  try {
    savingDefaults.value = true
    const metadata = {
      ...parseMetadata(drama.value?.metadata),
      orientation: projectOrientationForm.value,
      aspect_ratio: projectOrientationForm.value === 'landscape' ? '16:9' : '9:16',
      image_size: projectOrientationForm.value === 'landscape' ? '1920x1080' : '1080x1920',
      ai_defaults: {
        text_config_id: defaultTextConfigId.value || null,
        image_config_id: defaultShotImageConfigId.value || defaultImageConfigId.value || null,
        character_image_config_id: defaultCharacterImageConfigId.value || null,
        scene_image_config_id: defaultSceneImageConfigId.value || null,
        shot_image_config_id: defaultShotImageConfigId.value || null,
        video_config_id: defaultVideoConfigId.value || null,
        audio_config_id: defaultAudioConfigId.value || null,
      },
    }
    await dramaAPI.update(dramaId, { metadata: JSON.stringify(metadata) })
    const episodes = drama.value?.episodes || []
    await Promise.all(episodes.map(ep => episodeAPI.update(ep.id, {
      image_config_id: defaultShotImageConfigId.value || defaultImageConfigId.value || ep.image_config_id || ep.imageConfigId,
      video_config_id: defaultVideoConfigId.value || ep.video_config_id || ep.videoConfigId,
      audio_config_id: defaultAudioConfigId.value || ep.audio_config_id || ep.audioConfigId,
    })))
    toast.success('默认模型已保存')
    await load()
  } catch (e) {
    toast.error(e.message)
  } finally {
    savingDefaults.value = false
  }
}

async function startAutoGenerate() {
  try {
    if (autoRangeMode.value === 'custom' && !selectedAutoEpisodes.value.length) {
      toast.warning('请至少选择一集')
      return
    }
    const payload = {
      target: autoTarget.value,
      end_episode: autoRangeMode.value === 'prefix' ? (autoEndEpisode.value || null) : null,
      episode_numbers: autoRangeMode.value === 'custom' ? selectedAutoEpisodes.value : [],
    }
    pendingAutoPayload.value = payload
    const preview = await dramaAPI.autoGeneratePreview(dramaId, payload)
    autoPreview.value = preview
    if (preview?.hasExisting) {
      autoConfirmDialog.value = true
      return
    }
    await beginAutoGenerate('missing')
  } catch (e) {
    toast.error(e.message)
  }
}

async function beginAutoGenerate(regenerateMode = 'missing') {
  try {
    const job = await dramaAPI.autoGenerate(dramaId, {
      ...(pendingAutoPayload.value || {
        target: autoTarget.value,
        end_episode: autoRangeMode.value === 'prefix' ? (autoEndEpisode.value || null) : null,
        episode_numbers: autoRangeMode.value === 'custom' ? selectedAutoEpisodes.value : [],
      }),
      regenerate_mode: regenerateMode,
    })
    upsertAutoJob(job)
    toast.success('自动生成已开始')
    pollAutoGenerate(job.id)
    autoConfirmDialog.value = false
    autoPreview.value = null
    pendingAutoPayload.value = null
  } catch (e) {
    toast.error(e.message)
  }
}

function confirmAutoGenerate(mode) {
  beginAutoGenerate(mode)
}

async function pollAutoGenerate(jobId) {
  if (autoPollJobIds.value.includes(jobId)) return
  autoPollJobIds.value.push(jobId)
  for (let i = 0; i < 720; i++) {
    await new Promise(resolve => setTimeout(resolve, 3000))
    if (!autoPollJobIds.value.includes(jobId)) return
    try {
      const job = await dramaAPI.autoGenerateStatus(dramaId, jobId)
      upsertAutoJob(job)
      if (job?.status === 'completed') {
        autoPollJobIds.value = autoPollJobIds.value.filter(id => id !== jobId)
        toast.success('自动生成完成')
        await load()
        return
      }
      if (job?.status === 'failed' || job?.status === 'cancelled') {
        autoPollJobIds.value = autoPollJobIds.value.filter(id => id !== jobId)
        if (job.status === 'failed') toast.error(job.error || '自动生成失败')
        await load()
        return
      }
    } catch (e) {
      toast.error(e.message)
      autoPollJobIds.value = autoPollJobIds.value.filter(id => id !== jobId)
      return
    }
  }
  autoPollJobIds.value = autoPollJobIds.value.filter(id => id !== jobId)
  toast.warning('自动生成仍在后台运行，请稍后刷新查看')
}

async function controlAutoJob(job, action) {
  try {
    const next = await dramaAPI.autoGenerateControl(dramaId, job.id, action)
    upsertAutoJob(next)
    if (action === 'resume') pollAutoGenerate(job.id)
  } catch (e) {
    toast.error(e.message)
  }
}

async function restartAutoJob(job) {
  try {
    const payload = {
      target: job.target,
      end_episode: job.episodeNumbers?.length ? null : (job.endEpisode || null),
      episode_numbers: job.episodeNumbers || [],
    }
    pendingAutoPayload.value = payload
    const preview = await dramaAPI.autoGeneratePreview(dramaId, payload)
    autoPreview.value = preview
    if (preview?.hasExisting) {
      autoConfirmDialog.value = true
      return
    }
    await beginAutoGenerate('missing')
  } catch (e) {
    toast.error(e.message)
  }
}

async function addEpisode() {
  try {
    creatingEpisode.value = true
    await episodeAPI.create({
      drama_id: dramaId,
      title: newEpisodeTitle.value || undefined,
      image_config_id: newEpisodeImageConfigId.value,
      video_config_id: newEpisodeVideoConfigId.value,
      audio_config_id: newEpisodeAudioConfigId.value,
    })
    toast.success('已添加新集')
    addDialog.value = false
    load()
  } catch (e) {
    toast.error(e.message)
  } finally {
    creatingEpisode.value = false
  }
}

function handleAddDialogKeydown(event) {
  if (event.key === 'Escape' && addDialog.value) addDialog.value = false
  if (event.key === 'Escape' && characterDialog.value) closeCharacterEditor()
  if (event.key === 'Escape' && autoConfirmDialog.value) autoConfirmDialog.value = false
  if (event.key === 'Escape' && taskLogDialog.value) taskLogDialog.value = false
}

watch([defaultImageConfigId, defaultShotImageConfigId, defaultVideoConfigId, defaultAudioConfigId], () => {
  if (!addDialog.value) return
  syncNewEpisodeDefaults()
})

onMounted(() => {
  load()
  loadConfigs()
  restoreAutoGenerateJob()
  window.addEventListener('keydown', handleAddDialogKeydown)
})

onBeforeUnmount(() => {
  autoPollJobIds.value = []
  window.removeEventListener('keydown', handleAddDialogKeydown)
})
</script>

<style scoped>
.page {
  padding: 28px 48px 40px;
  overflow-y: auto;
  height: 100%;
  animation: none;
}

.page-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-end;
  margin-bottom: 18px;
  gap: 20px;
}
.head-left { display: flex; align-items: flex-start; gap: 12px; }
.head-info { display: flex; flex-direction: column; gap: 8px; }

.back-btn {
  display: flex; align-items: center; gap: 6px;
  padding: 7px 12px; font-size: 13px; font-weight: 500;
  border: 1px solid var(--border); border-radius: var(--radius);
  background: var(--bg-0); color: var(--text-2);
  cursor: pointer; transition: all 0.18s var(--ease-out);
  box-shadow: var(--shadow-xs);
}
.back-btn:hover { background: var(--bg-hover); border-color: var(--border-strong); color: var(--text-0); }

.page-title {
  font-family: var(--font-display);
  font-size: 26px; font-weight: 700;
  letter-spacing: -0.02em;
  line-height: 1.2;
}

.page-meta { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.style-chip {
  font-size: 11px; font-weight: 500;
  padding: 2px 8px;
  background: var(--accent-bg); color: var(--accent-text);
  border-radius: 99px; border: 1px solid rgba(184,120,20,0.12);
}
.orientation-chip {
  background: rgba(76,125,255,0.1);
  color: var(--accent);
  border-color: rgba(76,125,255,0.18);
}
.meta-divider { width: 3px; height: 3px; border-radius: 50%; background: var(--text-3); }
.meta-item {
  display: flex; align-items: center; gap: 5px;
  font-size: 12px; color: var(--text-2);
}

.defaults-panel {
  max-width: 1120px;
  margin-bottom: 24px;
  padding: 18px;
  border: 1px solid var(--border);
  border-radius: 18px;
  background: rgba(255,255,255,0.82);
  box-shadow: var(--shadow-xs);
}
.auto-panel {
  max-width: 1120px;
  margin-bottom: 24px;
  padding: 18px;
  border: 1px solid var(--border);
  border-radius: 18px;
  background: rgba(248,251,255,0.9);
  box-shadow: var(--shadow-xs);
}
.auto-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}
.auto-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  justify-content: flex-end;
}
.auto-range-field {
  min-height: 40px;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 0 10px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: rgba(255,255,255,0.76);
  color: var(--text-2);
  font-size: 12px;
  font-weight: 600;
}
.auto-range-input {
  width: 72px;
  height: 30px;
  min-height: 30px;
  padding: 4px 8px;
  border-radius: 8px;
  text-align: center;
}
.auto-status {
  margin-top: 14px;
  padding: 14px;
  border: 1px solid rgba(27, 41, 64, 0.08);
  border-radius: 14px;
  background: rgba(255,255,255,0.68);
}
.auto-job-list { display: flex; flex-direction: column; gap: 10px; }
.auto-progress-head,
.auto-status-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  color: var(--text-2);
  font-size: 12px;
}
.auto-job-title {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  font-weight: 700;
  color: var(--text-1);
}
.job-status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--text-3);
}
.job-status-dot.is-running,
.dot-running {
  background: var(--accent);
  animation: pulseDot 1.2s ease-in-out infinite;
}
.job-status-dot.is-paused { background: #d89a2b; }
.job-status-dot.is-completed { background: var(--success); }
.job-status-dot.is-failed,
.job-status-dot.is-cancelled { background: var(--danger); }
.auto-progress-bar {
  height: 8px;
  margin: 10px 0;
  overflow: hidden;
  border-radius: 999px;
  background: rgba(27, 41, 64, 0.08);
}
.auto-progress-bar.active { position: relative; }
.auto-progress-bar.active::after {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(90deg, transparent, rgba(255,255,255,0.54), transparent);
  animation: progressSweep 1.4s linear infinite;
}
.auto-range-note {
  margin-top: 8px;
  font-size: 12px;
  color: var(--text-3);
}
.auto-detail {
  margin-top: 6px;
  color: var(--text-2);
  font-size: 12px;
}
.auto-episode-picker {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 14px;
  padding-top: 14px;
  border-top: 1px solid rgba(27, 41, 64, 0.08);
}
.episode-toggle {
  min-width: 46px;
  height: 34px;
  padding: 0 10px;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: rgba(255,255,255,0.82);
  color: var(--text-2);
  font-family: var(--font-mono);
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;
  transition: all 0.18s var(--ease-out);
}
.episode-toggle:hover {
  border-color: var(--accent);
  color: var(--accent);
}
.episode-toggle.is-selected {
  background: var(--accent);
  border-color: var(--accent);
  color: white;
  box-shadow: 0 8px 18px rgba(76,125,255,0.22);
}
.auto-progress-bar span {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: var(--accent);
  transition: width 0.2s ease;
}
.auto-error {
  color: var(--danger);
  font-weight: 600;
}
.job-actions { display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
.job-log { margin-top: 10px; color: var(--text-2); font-size: 12px; }
.job-log summary { cursor: pointer; font-weight: 700; }
.job-log-line {
  display: grid;
  grid-template-columns: 76px minmax(0, 1fr);
  gap: 8px;
  padding: 5px 0;
  border-bottom: 1px solid rgba(27, 41, 64, 0.06);
}
.btn-count {
  min-width: 20px;
  height: 20px;
  padding: 0 6px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
  background: rgba(76,125,255,0.12);
  color: var(--accent);
  font-size: 11px;
  font-weight: 800;
}
.task-log-dialog {
  width: min(920px, 100%);
}
.task-log-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-height: min(620px, calc(100vh - 260px));
  overflow-y: auto;
  padding-right: 4px;
}
.task-log-card {
  padding: 14px;
  border-radius: 14px;
  border: 1px solid rgba(27, 41, 64, 0.08);
  background: rgba(255,255,255,0.72);
}
.task-log-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  color: var(--text-2);
  font-size: 12px;
}
.task-log-actions {
  display: flex;
  justify-content: flex-end;
  margin-top: 8px;
}
.auto-confirm-dialog {
  width: min(820px, 100%);
}
.auto-existing-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.auto-existing-item {
  min-height: 30px;
  display: inline-flex;
  align-items: center;
  padding: 0 10px;
  border-radius: 999px;
  background: rgba(216,154,43,0.12);
  border: 1px solid rgba(216,154,43,0.18);
  color: #8a5a12;
  font-size: 12px;
  font-weight: 700;
}
.danger-btn {
  color: var(--danger);
}
.library-panel {
  max-width: 1120px;
  margin-bottom: 24px;
  padding: 18px;
  border: 1px solid var(--border);
  border-radius: 18px;
  background: rgba(255,255,255,0.86);
  box-shadow: var(--shadow-xs);
}
.library-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 14px;
}
.character-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
}
.character-card {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: start;
  gap: 10px;
  min-width: 0;
  padding: 12px;
  border-radius: 12px;
  border: 1px solid rgba(27, 41, 64, 0.1);
  background: rgba(248,251,255,0.88);
}
.character-avatar {
  width: 58px;
  height: 58px;
  overflow: hidden;
  border-radius: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-2);
  color: var(--accent);
  font-size: 20px;
  font-weight: 800;
}
.character-avatar.is-tall {
  width: 58px;
  height: 82px;
}
.character-avatar.is-wide {
  width: 86px;
  height: 54px;
}
.character-avatar.is-square,
.character-avatar.is-empty {
  width: 58px;
  height: 58px;
}
.character-avatar img {
  width: 100%;
  height: 100%;
  object-fit: contain;
  display: block;
}
.character-copy {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.character-title-row {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.character-name {
  font-size: 14px;
  font-weight: 700;
  color: var(--text-0);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.character-role,
.character-meta {
  color: var(--text-2);
  font-size: 11px;
}
.character-role {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.character-meta {
  display: flex;
  gap: 7px;
  flex-wrap: wrap;
}
.character-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin-top: 2px;
}
.btn-xs {
  min-height: 26px;
  padding: 4px 8px;
  border-radius: 8px;
  font-size: 11px;
}
.mini-status {
  flex: 0 0 auto;
  height: 20px;
  padding: 0 7px;
  border-radius: 999px;
  display: inline-flex;
  align-items: center;
  background: rgba(76,125,255,0.12);
  color: var(--accent);
  font-size: 10px;
  font-weight: 700;
}
.library-more {
  margin-top: 12px;
}
.defaults-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 14px;
}
.defaults-label { margin-bottom: 6px; }
.defaults-copy {
  color: var(--text-2);
  font-size: 13px;
  line-height: 1.6;
}
.defaults-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
  gap: 10px;
}
.default-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  padding: 14px;
  border-radius: 12px;
  border: 1px solid rgba(27, 41, 64, 0.1);
  background: rgba(248,251,255,0.88);
}

/* Section label */
.section-label {
  display: flex; align-items: center; gap: 7px;
  font-size: 11px; font-weight: 700;
  color: var(--text-3); letter-spacing: 0.08em;
  text-transform: uppercase;
  margin-bottom: 12px;
}

/* Episode Grid */
.ep-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
  max-width: 1120px;
}

.ep-card {
  display: grid;
  grid-template-columns: 42px minmax(0, 1fr) 18px;
  align-items: center;
  gap: 10px;
  min-height: 92px;
  padding: 14px;
  cursor: pointer;
  animation: fadeUp 0.35s var(--ease-out) both;
  transition: transform 0.18s var(--ease-out), box-shadow 0.18s var(--ease-out), border-color 0.18s;
}
.ep-card:hover {
  border-color: var(--accent);
  box-shadow: var(--shadow);
  transform: translateY(-2px);
}

.ep-number {
  width: 42px; height: 42px; flex-shrink: 0;
  border-radius: var(--radius);
  background: var(--bg-2);
  border: 1px solid var(--border);
  display: flex; align-items: center; justify-content: center;
  font-family: var(--font-mono);
  font-size: 12px; font-weight: 700;
  color: var(--text-2);
  transition: all 0.18s;
}
.ep-card:hover .ep-number {
  background: var(--accent-bg);
  border-color: rgba(184,120,20,0.2);
  color: var(--accent);
}

.ep-body { min-width: 0; display: flex; flex-direction: column; gap: 7px; }
.ep-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-0);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ep-status { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.status-dot {
  width: 6px; height: 6px; border-radius: 50%;
}
.dot-ready { background: var(--success); }
.dot-pending { background: var(--text-3); }
.dot-running { background: var(--accent); }
.status-text { font-size: 11px; color: var(--text-3); }
.ep-duration { font-size: 11px; color: var(--text-3); font-family: var(--font-mono); margin-left: 4px; }

.ep-arrow { color: var(--text-3); flex-shrink: 0; transition: transform 0.18s; justify-self: end; }
.ep-card:hover .ep-arrow { transform: translateX(2px); color: var(--accent); }

/* Empty */
.ep-empty {
  grid-column: 1 / -1;
  display: flex; flex-direction: column; align-items: center; gap: 10px;
  padding: 48px; text-align: center; color: var(--text-3); font-size: 13px;
  border-style: dashed;
}
.ep-empty-icon {
  width: 48px; height: 48px; border-radius: 50%;
  background: var(--bg-2); display: flex; align-items: center; justify-content: center;
}

.dialog-mask {
  position: fixed;
  inset: 0;
  z-index: 1000;
  background: rgba(15, 23, 38, 0.18);
  backdrop-filter: blur(8px);
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: 24px;
  overflow-y: auto;
}
.dialog {
  width: min(760px, 100%);
  max-height: min(860px, calc(100dvh - 48px));
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 26px 26px 22px;
  border-radius: 28px;
  background:
    radial-gradient(circle at top left, rgba(122,167,255,0.14), transparent 34%),
    radial-gradient(circle at top right, rgba(76,125,255,0.08), transparent 26%),
    linear-gradient(180deg, rgba(255,255,255,0.98), rgba(242,247,255,0.92));
  overflow: hidden;
  border: 1px solid rgba(27, 41, 64, 0.08);
  box-shadow: 0 22px 52px rgba(32, 48, 77, 0.14), 0 8px 18px rgba(32, 48, 77, 0.08);
}
.dialog-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.dialog-head-copy { display: flex; flex-direction: column; gap: 8px; max-width: 520px; }
.dialog-kicker {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--text-3);
}
.dialog-title-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.dialog-title { font-size: 28px; font-weight: 800; color: var(--text-0); letter-spacing: -0.03em; }
.dialog-badge {
  display: inline-flex;
  align-items: center;
  height: 28px;
  padding: 0 12px;
  border-radius: 999px;
  background: rgba(76,125,255,0.1);
  color: var(--accent-text);
  font-size: 12px;
  font-weight: 700;
}
.dialog-sub { font-size: 14px; line-height: 1.7; color: var(--text-2); }
.dialog-summary {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.summary-chip {
  display: inline-flex;
  align-items: center;
  height: 30px;
  padding: 0 12px;
  border-radius: 999px;
  background: rgba(255,255,255,0.78);
  border: 1px solid rgba(27, 41, 64, 0.08);
  font-size: 12px;
  color: var(--text-2);
}
.dialog-body {
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 14px;
  overflow-y: auto;
  padding-right: 4px;
}
.dialog-section {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px 18px;
  border-radius: 22px;
  background: rgba(255,255,255,0.72);
  border: 1px solid rgba(27, 41, 64, 0.08);
}
.dialog-section-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
}
.dialog-section-title { font-size: 14px; font-weight: 700; color: var(--text-0); }
.dialog-section-copy { font-size: 12px; color: var(--text-3); }
.config-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
}
.config-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 14px;
  border-radius: 18px;
  background: linear-gradient(180deg, rgba(244,248,255,0.96), rgba(255,255,255,0.78));
  border: 1px solid rgba(27, 41, 64, 0.08);
}
.config-card-kicker {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--text-3);
}
.dialog-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding-top: 2px;
}
.dialog-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  justify-content: flex-end;
}
.dialog-foot-copy {
  flex: 1;
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-3);
}
.field { display: flex; flex-direction: column; gap: 6px; }
.field-label { font-size: 12px; font-weight: 600; color: var(--text-1); }
.field-hint { font-size: 12px; color: var(--text-3); }
.textarea {
  resize: vertical;
  min-height: 78px;
  padding: 10px 12px;
  border-radius: 12px;
  border: 1px solid var(--border);
  background: var(--bg-0);
  color: var(--text-0);
  font: inherit;
  line-height: 1.6;
  outline: none;
}
.textarea:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px rgba(76,125,255,0.12);
}
.character-dialog {
  width: min(820px, 100%);
}
.character-form-grid {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

@keyframes pulseDot {
  0%, 100% { opacity: 0.55; transform: scale(0.92); }
  50% { opacity: 1; transform: scale(1.18); }
}

@keyframes progressSweep {
  from { transform: translateX(-100%); }
  to { transform: translateX(100%); }
}

@media (max-width: 860px) {
  .page {
    padding: 18px;
  }

  .defaults-head {
    flex-direction: column;
    align-items: stretch;
  }

  .auto-head {
    flex-direction: column;
  }

  .library-head {
    flex-direction: column;
  }

  .auto-actions {
    justify-content: stretch;
  }

  .defaults-grid {
    grid-template-columns: 1fr;
  }

  .character-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .ep-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .dialog {
    width: 100%;
    max-height: calc(100vh - 24px);
    padding: 18px;
    border-radius: 22px;
  }

  .dialog-title {
    font-size: 24px;
  }

  .config-grid {
    grid-template-columns: 1fr;
  }

  .dialog-foot {
    flex-direction: column;
    align-items: stretch;
  }
}

@media (max-width: 560px) {
  .ep-grid {
    grid-template-columns: 1fr;
  }

  .character-grid {
    grid-template-columns: 1fr;
  }
}
</style>
