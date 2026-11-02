# Mile Warp

Windows 本机桌面应用，集中管理和运行终端类 AI agent：Claude Code、Codex CLI、Kimi Code、Pi，以及 PowerShell。

把「项目目录 + agent + 启动参数」保存成**工作区**，按分组归类；点一下就在内嵌终端里启动 agent。控制台支持单格、左右两格、四宫格，可以让几个 agent 并行跑不同的任务。关掉应用后再打开，可以一键恢复上次的会话，并续接各 agent 自己的对话。

## 功能

- **会话栏**：分组 > 工作区 > 会话。分组可折叠、改名、拖拽排序；工作区卡片显示运行状态、git 分支（只读 `.git/HEAD`）、所在格号；同一工作区可以开多个会话。顶部可以按名称、备注、目录、agent 筛选。
- **目录栏**：当前工作区目录的只读文件树，懒加载。已展开的目录有变化时头部提示「有更新」，点刷新才重读。右键可复制相对 / 绝对路径、插入到当前终端（Claude 用 `@相对路径`），也可以把文件直接拖到终端格。只能浏览工作区目录之内，符号链接跳出目录时不展开。
- **宫格控制台**：1 / 2 / 4 格切换，分隔条可拖，每格不小于 360×240。会话可以拖到任意格，格头拖到另一格即两格互换。切到少格时，隐藏的会话在后台继续运行。
- **终端**：基于 ConPTY 的真实伪终端，agent 直接作为进程启动（不先开 shell），能拿到准确的退出码。npm 生成的 `.cmd` 壳会还原成 `node + js` 或 exe 再启动，避免 `Terminate batch job (Y/N)?`。支持选中即复制、终端内搜索、可点击链接、字号调整。
- **关闭与托盘**：有会话在运行时关窗口会询问「最小化到托盘」还是「全部结束并退出」，可以记住选择。最小化到托盘后会话继续运行。
- **一键恢复与续接**：会话快照随会话生命周期即时写盘。下次启动时，控制台出现「恢复上次的 N 个会话」，按原格位重新启动并续接对话：Claude 用 `--resume <uuid>`，Codex 用 `resume <id>`，Kimi 用 `--session <id>`。拿不到会话 ID、又有可能把两个会话串到同一段对话上时，标为「新开」，不静默续接。
- **命令面板**：搜索工作区、会话与动作（切换布局、主题、打开设置等），支持拼音首字母（`khd` 搜到「客户端」），不输入时最近用过的排最前，「在第 N 格打开…」可以再选工作区。
- **多 agent 并行**：会话跑完一轮安静下来时，会话卡片和格头出现强调色小点（只看有没有输出与时间，不解析内容）；后台会话会发 Windows 通知、任务栏闪烁，任务栏图标角标显示「等你处理」的会话数。可在设置 → 通知里关掉或设免打扰时段。
- **布局预设与分组**：把当前宫格和每格的工作区存成预设，一键开工；分组可以「全部启动 / 全部结束」，可设颜色，格头顶部显示同色细带。
- **自定义 agent**：设置 → Agent 里添加命令、默认参数、徽章颜色（前景对比度不足 4.5:1 时拒绝）和续接模板（`{id}` 占位）。
- **广播输入**：标题栏开关，聚焦格里的键入同时发给其他可见格，可逐格排除；每次打开都要确认，重载界面后自动关闭。
- **终端细节**：路径（`src/foo.ts:42`、工作区内的绝对路径）可点击，装了 VS Code 就打开到对应行；往上翻看历史时有新输出，右下角出现「新输出」；长文本输入框（`Ctrl+Shift+I`，`Ctrl+Enter` 发送）；导出终端内容为 `.txt`；行高与光标样式可调。
- **稳定性**：主进程日志在 `%APPDATA%\mile-warp\logs\`（按天，保留 7 天，不记终端内容与环境变量值）；渲染进程崩溃自动重载，会话不受影响；上次退出时没结束的 agent 进程会在启动时提示，确认后才结束。
- **设置**：主题（跟随系统 / 浅色 / 深色）、终端字体字号行高光标、滚动行数、选中即复制、默认 Shell、自定义 agent、通知与免打扰、关闭窗口时的行为、启动时自动恢复、恢复时是否续接对话、导入导出配置（不含环境变量的值）。
- **新建工作区**：把文件夹从资源管理器拖到会话栏，或在会话栏里 `Ctrl+V` 粘贴一个目录路径，弹窗会预填目录和名称。

## 快捷键

| 组合 | 作用 |
| --- | --- |
| `Ctrl+Shift+K` | 命令面板 |
| `Ctrl+/` | 快捷键速查 |
| `Ctrl+Shift+I` | 长文本输入框 |
| `Ctrl+,` | 设置 |
| `Ctrl+Shift+B` / `Ctrl+Shift+E` | 显隐会话栏 / 目录栏 |
| `Ctrl+Shift+D` | 宫格 1 → 2 → 4 循环 |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` / `Ctrl+Shift+1–4` | 切换聚焦格 |
| `Ctrl+Shift+F` | 终端内搜索 |
| `Ctrl+Shift+C` / `Ctrl+Shift+V` | 复制 / 粘贴 |
| `Ctrl+C` | 有选区时复制，无选区时照常发中断 |
| `Ctrl+=` / `Ctrl+-` / `Ctrl+0` | 终端字号 |

焦点在终端里时，应用只拦截上表里的组合，其余按键（`Ctrl+R`、`Ctrl+W`、`Ctrl+K`、`Esc` 等）全部交给 agent。

## 系统要求

- Windows 10 1809+ 或 Windows 11，x64（ConPTY）
- 要用的 agent 已安装并在 PATH 中。应用只检测、不安装：设置 → Agent 里能看到解析到的路径与版本。

## 数据与安全

- 配置：`%APPDATA%\mile-warp\config.json`（分组、工作区、设置、最近 50 条会话快照）。原子写，保留上一份良好版本 `config.json.bak`；主文件损坏时另存为 `config.json.corrupt` 再从 `.bak` 恢复。
- 界面布局：`%APPDATA%\mile-warp\window-state.json`（窗口尺寸、栏宽、宫格与格位）。
- 工作区环境变量的值用 Windows DPAPI（Electron `safeStorage`）加密落盘，界面上只显示变量名。
- 渲染进程没有 Node 能力（上下文隔离 + 沙箱），只能通过白名单 IPC 调用主进程。启动会话只传工作区 id，可执行文件、参数、目录全部由主进程从配置读取；默认 Shell 只能从本机探测到的几项里选。
- 外部链接只放行 http / https，交给系统浏览器打开。
- 应用不联网同步，不读取、不保存任何 agent 的密钥。续接对话只读 `~/.codex/sessions` 与 `~/.kimi-code/session_index.jsonl` 里的会话 ID。

## 开发

技术栈：Electron 43 + electron-vite 5 + React 19 + TypeScript 5.9 + Tailwind CSS 4 + zustand 5 + node-pty 1.1 + xterm.js 6。

```powershell
npm install
npm run dev          # 开发模式
npm run typecheck    # 主进程与渲染层两套 tsconfig
npm run build        # typecheck + 构建到 out/，要求零警告
npm run build:win    # 出 NSIS 安装包到 release/（需要 Node 22 LTS）
npm run icon         # 由 resources/智能代理管理面板图标.png 重新生成全部图标（exe、安装包、窗口、托盘、应用内 logo）
```

开发期在应用里按 `F12` 打开开发者工具。

### 验证

不用单元测试框架。`scripts/verify-*.cjs` 启动真实的 Electron、加载 `out/` 产物、在渲染层里驱动真实交互并断言 DOM 与 IPC 回执，都在临时目录里跑，不碰真实配置。跑之前先 `npm run build`。

```powershell
npm run verify:ui                              # UI 硬规则源码扫描（不需要 build）
npx electron scripts/verify-m1-session.cjs     # 单格终端、中文、进程树清理
npx electron scripts/verify-m2-rail.cjs        # 会话栏、目录栏、.bak 恢复
npx electron scripts/verify-fs-guard.cjs       # 目录栏路径越界防护
npx electron scripts/verify-m3-grid.cjs        # 宫格、换格、后台保活、分隔条
npx electron scripts/verify-m4-restore.cjs     # 关闭确认、托盘、一键恢复与续接（3 次真实启动）
npx electron scripts/verify-m5-settings.cjs    # 设置、主题、快捷键、命令面板、终端搜索
npx electron scripts/verify-upgrade.cjs        # 升级建议：迁移、活动指示、自定义 agent、路径、预设、广播、有更新、崩溃重载
npm run verify:all                             # 依次跑全部 harness，日志存 %TEMP%\warp-verify\
```

发版前过一遍 `docs/发版冒烟清单.md`（真实 agent 续接、安装卸载、高 DPI 托盘）。

在 Windows PowerShell 5.1 里把输出存成文件时，先 `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)`，再 `2>&1 | Out-File <log> -Encoding utf8`，否则中文会乱码。

### 文档

- `docs/PRD.md`：功能清单与优先级
- `docs/技术设计.md`：架构、数据模型、IPC 契约、安全模型、验证方式
- `docs/UI设计约束.md`：设计令牌、布局、组件规范
- `docs/decisions.md`：偏离文档的决策与理由
- `docs/踩坑记录.md`：按里程碑记录的现象、原因、对策
