# Mile Warp v1.5.0

Windows 本机桌面应用，集中管理和运行终端类 AI agent（Claude Code、Codex CLI、Kimi Code、Pi、PowerShell）。

把「项目目录 + agent + 启动参数」保存成工作区，按分组归类，点一下就在内嵌终端里启动。控制台支持单格、左右两格、四宫格，几个 agent 可以并行跑不同任务；关掉应用后再打开，一键恢复上次会话并续接各 agent 自己的对话。

## 主要功能

- **多 agent 并行**：1 / 2 / 4 宫格控制台，会话可拖拽换格，后台会话保活；会话安静下来时卡片和格头出现提示点，配合 Windows 通知与任务栏角标。
- **一键恢复与续接**：会话快照即时写盘，重启后按原格位恢复，并续接 Claude / Codex / Kimi 的对话。
- **Git 管理**（默认关，设置里开启）：改动列表、暂存 / 丢弃、diff、提交、分支切换、fetch / pull / push（带进度与取消）、提交历史工作台；目录栏显示改动标记。
- **文件预览**：目录栏单击文件即预览，Markdown 渲染、图片缩略、代码等宽显示。
- **Skills 管理**：跨 agent 扫描本机 skill，一键互装，支持从 GitHub 仓库或本地 zip 安装（带路径穿越防护）。
- **会话历史**：按目录浏览各 agent 的历史会话，预览、导出、一键续接。
- **效率细节**：命令面板（支持拼音首字母）、布局预设、分组批量启动、广播输入、终端内路径可点击跳 VS Code、长文本输入框。

## 安装

1. 下载 `Mile.Warp.Setup.1.5.0.exe` 运行即可（NSIS 安装包，约 99 MB）。
2. 系统要求：Windows 10 1809+ 或 Windows 11，x64。
3. 要用的 agent（Claude Code、Codex CLI 等）需自行安装并在 PATH 中；应用只检测、不代装。

安装包未签名，首次运行 Windows SmartScreen 可能提示「未知发布者」，选择「仍要运行」即可。

SHA256：`d668815f0e0d266e9f81363c7ffc5819c5d8f10cb60e790bf21ed21f552b9040`

## 安全说明

- 应用不联网同步，不读取、不保存任何 agent 的密钥。
- 工作区环境变量的值用 Windows DPAPI 加密落盘。
- 渲染进程沙箱 + 上下文隔离，所有文件与 Git 操作经主进程白名单校验，越出工作区 / 仓库的路径一律拒绝。

## 技术栈

Electron 43 + React 19 + TypeScript 5.9 + Tailwind CSS 4 + zustand 5 + node-pty（ConPTY）+ xterm.js 6。