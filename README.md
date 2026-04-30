# Huobao Drama 自定义版

这是基于 `chatfire-AI/huobao-drama` 二次改造的 AI 短剧生产工具，用于从剧本导入、AI 改写、角色/场景提取、分镜、图片、视频到合成的一体化制作。

本仓库只建议保存代码和配置模板，不保存 API Key、数据库、上传文件、生成图片、生成视频等运行数据。

## 主要改造

- AI 服务配置开放化：文本、图片、视频、音频服务都可以在 Web 设置页自定义 provider、Base URL、模型、端点和高级 JSON。
- 支持 OpenAI 兼容接口、自定义任务式 API、ComfyUI 工作流 API。
- ComfyUI 支持多个 Base URL，可按轮询方式分发任务到多台后端。
- 支持全局默认模型和项目默认模型，剧集工作台可选择语言模型。
- 支持跳过 TTS，适合没有音色库或暂不需要配音的流程。
- 支持导入 PDF、Word、TXT、MD 创建项目，并按计划集数自动分配内容。
- 角色库跨集复用：同名角色在后续集会继承已制作的人物参考图。
- 角色库支持编辑和重新生成。
- 分镜、场景图、视频提示词改为中文优先。
- 自动生成支持全剧、前 N 集、指定集数，并可选择目标阶段：分镜、镜头图片、视频生成、最终合成。
- 自动生成有任务条、暂停、继续、终止、重新开始和任务日志。
- 自动生成开始前会检测已有资产，默认“继续补缺”，只有明确选择后才会重置并重新生成。

## 技术栈

```text
frontend/   Nuxt 3 + Vue 3
backend/    Hono + Drizzle ORM + Mastra Agents + better-sqlite3
configs/    配置模板
data/       本地数据库和生成资产，默认不提交
skills/     Agent 技能提示词
```

## 环境要求

| 软件 | 用途 |
|---|---|
| Node.js 20+ | 前后端运行 |
| npm 9+ | 依赖安装 |
| FFmpeg | 视频合成、拼接 |
| poppler-utils | PDF 文本解析，提供 `pdftotext` |
| unzip | DOCX 文本解析 |

Ubuntu / Debian 示例：

```bash
sudo apt update
sudo apt install -y ffmpeg poppler-utils unzip
```

验证：

```bash
node -v
npm -v
ffmpeg -version
pdftotext -v
unzip -v
```

## 安装

```bash
git clone <your-repo-url>
cd huobao-drama

cd backend
npm install

cd ../frontend
npm install
```

## 配置

复制配置模板：

```bash
cp configs/config.example.yaml configs/config.yaml
```

`configs/config.yaml` 是本地配置文件，默认不会提交到 Git。

AI 服务 API Key 不建议写入仓库文件。请在 Web 设置页中配置：

- 文本模型
- 图片模型
- 视频模型
- TTS / 音频模型
- ComfyUI 工作流
- 自定义 OpenAI 兼容接口
- 自定义任务式接口

## 开发运行

后端：

```bash
cd backend
npm run dev
```

前端：

```bash
cd frontend
npm run dev --host 0.0.0.0
```

默认地址：

- 前端：`http://localhost:3013`
- 后端：`http://localhost:5679/api/v1`

## 后台运行

如果希望关掉终端后仍然运行，可以用 systemd。

示例服务名：

```bash
huobao-backend.service
huobao-frontend.service
```

常用命令：

```bash
sudo systemctl start huobao-backend.service huobao-frontend.service
sudo systemctl restart huobao-backend.service huobao-frontend.service
sudo systemctl status huobao-backend.service huobao-frontend.service
```

## 文件导入

创建短剧项目时支持导入：

- `.pdf`
- `.docx`
- `.doc`
- `.txt`
- `.md`

说明：

- PDF 解析依赖系统命令 `pdftotext`，需要安装 `poppler-utils`。
- DOCX 解析依赖 `unzip`，读取 `word/document.xml`。
- TXT / MD 直接按 UTF-8 文本读取。
- 旧版 `.doc` 使用保底文本提取，复杂文档可能需要先转成 DOCX/TXT。

## 自动生成策略

自动生成支持三类范围：

- 全剧
- 前 N 集
- 指定集数

支持生成到：

- 分镜
- 镜头图片
- 视频生成
- 最终合成

如果检测到已有资产，系统会弹窗确认：

- 默认：继续补缺，只生成缺失部分。
- 可选：重置并重新生成，只影响本次选择范围内的资产。

角色库属于跨集复用资产，不会因为某一集重新生成而自动清空。

## 不应提交的内容

`.gitignore` 已忽略：

- `node_modules/`
- `.venv/`
- `frontend/.nuxt/`
- `frontend/.output/`
- `configs/config.yaml`
- `data/huobao_drama.db`
- `data/static/`
- `data/storage/`
- `.env`
- 私钥、证书、本地备份文件

提交前建议检查：

```bash
git status --short
git status --short --ignored
```

不要提交：

- API Key
- 数据库
- 用户上传文件
- 生成图片/视频/音频
- ComfyUI 私有工作流中包含的密钥

## GitHub 备份建议

建议在自己的 GitHub 创建一个私有仓库，然后把远端地址加为 `backup`：

```bash
git remote add backup git@github.com:<your-name>/<your-repo>.git
git push -u backup master
```

如果使用 HTTPS：

```bash
git remote add backup https://github.com/<your-name>/<your-repo>.git
git push -u backup master
```

首次推送前建议先检查将要提交的文件：

```bash
git status --short
git diff --stat
```

## 许可证

请以原项目许可证为准。本仓库为个人自定义备份版本。
