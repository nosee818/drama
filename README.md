# VeryAI 短剧平台

VeryAI 短剧平台是一套面向短剧内容生产的 AI 工作台，覆盖从剧本导入、剧集拆分、AI 改写、角色与场景设定、分镜拆解、图片生成、视频生成到视频与语音合成的完整流程。

平台适合需要批量制作短剧、测试多模型工作流、管理跨集角色资产和自动化生成素材的团队或个人使用。

## 核心能力

- **项目创建**：支持手动输入剧本，也支持导入 PDF、Word、TXT、MD 文件，并按计划集数自动分配内容。
- **AI 剧本处理**：支持 AI 改写、角色场景提取、音色设计和分镜拆解。
- **角色库**：跨集复用角色设定、人物参考图和音色样本，同名角色可在后续剧集中继承。
- **场景库**：为地点、时间、环境氛围生成独立场景资产，便于后续镜头合成。
- **镜头图片**：支持文生图、图生图和多参考图工作流，可引用角色与场景资产生成镜头首帧。
- **镜头工作台**：在分镜详情中直接编辑首帧提示词、视频提示词、上传/下载首帧、生成或重新生成首帧与视频。
- **视频生成**：支持本地或远程视频模型，支持横屏、竖屏项目和 1080P / 720P 等可配置分辨率、帧率与时长占位符。
- **视频与语音合成**：支持将镜头视频与角色台词配音合成，同一镜头可挂载多段配音；当配音长于视频时会自动补黑屏延长到配音结束。
- **音色设计**：支持在音色界面新增或删除角色声音设计，配音生成页基于已有角色声音进行克隆。
- **自动生成**：可选择生成范围和目标阶段，例如生成到分镜、镜头图片、视频或最终合成。
- **任务日志**：记录自动生成进度、失败原因和历史任务，刷新页面后仍可查看当前状态。
- **自定义模型**：文本、图片、视频、音频服务均可在设置页配置 OpenAI 兼容接口、通用任务 API 或 ComfyUI 工作流。
- **可扩展 Skill**：内置剧本改写、表格分镜导入、高张力短剧分镜脚本生成等技能，可按制作流程扩展。

## 适用场景

- 批量短剧生产
- 小说或剧本转短剧
- 多模型 A/B 测试
- 本地 ComfyUI 工作流集成
- 角色、场景、镜头资产管理
- AI 视频生产流程验证

## 技术栈

```text
frontend/   Nuxt 3 + Vue 3
backend/    Hono + Drizzle ORM + Mastra Agents + better-sqlite3
skills/     Agent 技能与提示词
configs/    配置模板
data/       本地数据库与运行资产，默认不提交
```

## 环境要求

| 软件 | 用途 |
| --- | --- |
| Node.js 20+ | 前后端运行 |
| npm 9+ | 依赖安装 |
| FFmpeg | 视频合成与拼接 |
| poppler-utils | PDF 文本解析，提供 `pdftotext` |
| unzip | DOCX 文本解析 |

Ubuntu / Debian 安装示例：

```bash
sudo apt update
sudo apt install -y ffmpeg poppler-utils unzip
```

## 安装

```bash
git clone git@github.com:nosee818/drama.git
cd drama

cd backend
npm install

cd ../frontend
npm install
```

## 配置

复制本地配置模板：

```bash
cp configs/config.example.yaml configs/config.yaml
```

API Key、数据库、上传文件和生成资产不应提交到仓库。建议在 Web 设置页配置模型服务：

- 文本模型
- 图片模型
- 视频模型
- 音频 / TTS 模型
- ComfyUI 工作流
- 自定义 OpenAI 兼容接口
- 自定义任务式接口

多服务地址可以在 Base URL 中按行填写。平台会根据服务类型和配置策略进行轮询或任务分发。

视频 ComfyUI 配置支持在高级 JSON 中使用占位符，例如 `{{prompt}}`、`{{first_frame}}`、`{{width}}`、`{{height}}`、`{{fps}}`、`{{duration}}`。设置页可以选择 1080P / 720P 等默认分辨率，并根据项目横竖屏自动传入对应宽高。

## 运行

启动后端：

```bash
cd backend
npm run dev
```

启动前端：

```bash
cd frontend
npm run dev --host 0.0.0.0
```

默认地址：

- 前端：`http://localhost:3013`
- 后端：`http://localhost:5679/api/v1`

## 后台运行

生产或长期测试环境建议使用 `systemd`、`pm2`、`screen` 或 `tmux` 托管进程。

systemd 服务名示例：

```text
veryai-backend.service
veryai-frontend.service
```

常用命令：

```bash
sudo systemctl start veryai-backend.service veryai-frontend.service
sudo systemctl restart veryai-backend.service veryai-frontend.service
sudo systemctl status veryai-backend.service veryai-frontend.service
```

## 文件导入

创建项目时支持：

- `.pdf`
- `.docx`
- `.doc`
- `.txt`
- `.md`

说明：

- PDF 解析依赖 `pdftotext`。
- DOCX 解析依赖 `unzip`。
- TXT / MD 按 UTF-8 文本读取。
- 旧版 DOC 使用保底文本提取，复杂文档建议先转换为 DOCX 或 TXT。

## 自动生成

自动生成可以选择：

- 全剧
- 前 N 集
- 指定集数

目标阶段可以选择：

- 分镜
- 镜头图片
- 视频生成
- 视频与语音合成

当系统检测到已有资产时，会先弹窗确认：

- 默认选择继续补缺，只生成缺失内容。
- 只有明确选择重新生成时，才会重置本次范围内的相关资产。

角色库属于跨集复用资产，不会因为某一集重新生成而被自动清空。

## 分镜与配音

分镜页面支持在当前镜头后插入子镜头，例如 `#03-01`、`#03-02`，也支持删除镜头。分镜详情中可直接维护首帧图片提示词和视频提示词，提示词保存采用确认/取消机制，避免误改后立即生效。

配音页面会读取音色界面中已经设计好的角色声音。同一镜头可以有多段配音，合成时按照镜头顺序和配音顺序依次拼接；如果某段配音时长超过对应视频，会用黑屏补足，不截断角色声音。

## Skills

当前内置技能包括：

- `script_rewriter`：剧本改写。
- `script_rewriter/high_tension_short_drama_storyboard`：高张力短剧分镜脚本生成器。
- `storyboard_breaker/表格分镜导入`：从 Markdown 分镜表格读取镜头号、景别、时长、画面描述和台词，直接生成结构化分镜。

## 数据与安全

仓库只保存源码、配置模板和提示词模板。以下内容不应提交：

- API Key
- 数据库文件
- 用户上传文件
- 生成图片、音频、视频
- 本地 `.env`
- 私钥、证书、本地备份文件

提交前建议检查：

```bash
git status --short
git diff --stat
```

## 常用命令

后端类型检查：

```bash
cd backend
npm run typecheck
```

前端构建：

```bash
cd frontend
npm run build
```

查看当前 Git 状态：

```bash
git status --short
```

## 许可证

请根据实际使用场景补充许可证信息。
