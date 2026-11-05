# CLAUDE.md

Mile Warp：Windows 本机桌面应用，集中管理和运行终端类 AI agent（Claude Code、Codex CLI、Kimi Code、Shell）。工作区 = 项目目录 + agent + 启动参数；左侧会话栏（分组 > 工作区 > 会话）+ 目录栏（只读文件树），中间控制台支持 1 / 2 / 4 宫格。

技术栈与视觉语言对齐参照项目 `E:\WebApp\Mile-Terminal-Management\mile-terminal-management`（Mile Terminal 2.3.0），遇到不确定的实现先去那里找同类做法。

## 文档（改代码前先读对应章节）

| 文档 | 内容 |
| --- | --- |
| `docs/PRD.md` | 功能清单（W-/D-/S-/T- 编号与优先级）、用户流程、待确认问题（§9.2） |
| `docs/技术设计.md` | 架构、数据模型（§4）、会话与进程（§5）、终端渲染（§6）、IPC 契约（§7）、安全模型（§8）、验证方式（§10）、里程碑（§11） |
| `docs/UI设计约束.md` | 设计令牌、布局、组件规范。代码落地后以 `src/renderer/src/styles/tokens.css` 为准，冲突时回改文档 |
| `docs/decisions.md` | 决策记录，格式 `日期 · 决策 · 理由`，只记「为什么不那样做」 |
| `docs/踩坑记录.md` | 按里程碑记录现象、原因、对策 |
| `docs/升级建议.md` | M5 之后的交互与功能升级建议（分档、成本、实现要点、推进顺序） |
| `docs/Git管理-PRD.md` | Git 管理（G-）：总开关、右栏 Git 页签、工作台弹窗、安全规则、IPC 草案、G0–G4 里程碑 |

偏离文档的设计变更要写进 `decisions.md`；踩到的坑写进 `踩坑记录.md`。

## 常用命令

```bash
npm run dev            # electron-vite 开发模式
npm run typecheck      # node + web 两套 tsconfig，必须都过
npm run build          # typecheck + electron-vite build，要求零警告
npm run rebuild        # 换 Electron 版本后重编 node-pty
npm run probe          # M0 PTY 探针（electron scripts/verify-m0-pty.cjs）
npx electron scripts/verify-m1-session.cjs   # 先 npm run build，harness 跑的是 out/ 产物
npx electron scripts/verify-m2-rail.cjs      # 会话栏 / 目录栏 / .bak 恢复 / 快捷键
npx electron scripts/verify-fs-guard.cjs     # 目录栏路径越界防护
npx electron scripts/verify-m3-grid.cjs      # 宫格 / 换格 / 后台保活 / 分隔条 / 自动收栏 / 重载回放
npx electron scripts/verify-m4-restore.cjs   # 关闭确认 / 托盘 / 快照 / 一键恢复与续接（编排 3 次启动，约 1 分钟）
npx electron scripts/verify-m5-settings.cjs  # 设置 / 主题 / 快捷键 / 命令面板 / 终端搜索
npx electron scripts/verify-upgrade.cjs      # 升级建议各项（迁移 / 活动 / 自定义 agent / 路径 / 预设 / 广播 / 有更新 / 崩溃重载）
npx electron scripts/verify-preview.cjs      # 目录栏文件预览（IPC 上限与越界 / md sanitizer / 相对图片 / Esc / 切工作区）
npx electron scripts/verify-skills.cjs       # Skills 管理（扫描 / 详情 / 卸载 / 跨 agent 安装 / 冲突 .bak / 弹窗与搜索）
npx electron scripts/verify-git.cjs          # Git 管理（总开关 / probe / status / 中文路径 / 恶意 fsmonitor 不执行）
node scripts/probe-skills.cjs                # 本机 agent skill 目录探针（只读，M0 定稿目录映射表用）
npm run verify:all                           # 依次跑全部 harness，日志存 %TEMP%\warp-verify\（M1 需要 PATH 里有 codex）
npx electron scripts/verify-layout.cjs       # 控件文字不折行、不溢出（多种宽度与格数、各弹窗菜单）
npx electron scripts/verify-icons.cjs        # 工作区自定义图标（MILE_WARP_TEST_ICON 跳过系统对话框；含配置写失败回滚）
npx electron scripts/verify-cmd-wrap.cjs     # cmd-wrap 兜底路径：& | % ^ 引号等参数经 node-pty / execFile 原样到达
node scripts/verify-launch-args.cjs          # 启动参数开头误写命令名（claude --xxx）被去掉
node scripts/verify-archive-stale.cjs        # 退出时归档旧批次恢复候选（打包 SessionRecords，不起 Electron）
npx electron scripts/verify-perf.cjs         # 性能基准与预算：包体、启动、计时器、空闲 CPU、大目录
npm run verify:ui                            # UI 硬规则源码扫描（node 直接跑，不需要 build）
npm run icon                                 # 由 resources/icon.svg 重新生成全部图标（electron 离屏渲染 SVG + nativeImage）
node scripts/verify-package.cjs              # 安装包冒烟：先 npm run build:win，需要 Node 22
```

harness 输出在 Windows PowerShell 5.1 下要这样落文件，否则中文乱码：

```powershell
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
npx electron scripts/verify-m2-rail.cjs 2>&1 | Out-File "$env:TEMP\warp-m2.log" -Encoding utf8
```

- 开发与构建用 Node 20.19；`npm run build:win`（electron-builder NSIS）需要切 Node 22 LTS。
- `codex` 只装在 nvm 的 v20.19 全局包里。nvm 切在 22 时 PATH 里没有 codex，M1 harness 的「codex 可用」会失败；临时在当前会话前置 `C:\Users\LHmile\AppData\Local\nvm\v20.19.0` 到 PATH 即可。
- 本目录不是 git 仓库。

## 目录结构

```
src/main/        主进程：index.ts（窗口、IPC 注册、sanitize* 校形）
  services/      ConfigStore / WorkspaceService / WorkspaceIcons / AgentService / SessionService / FileTreeService / GitInfoService
  lib/           argTokenizer / shimParser / commandResolver / atomicWrite
  platform/win32 平台适配（taskkill、外部终端）
src/preload/     contextBridge 暴露 window.warp.*（index.d.ts 为类型）
src/shared/      channels.ts（IPC 频道常量 CH）、types.ts
src/renderer/src components/ store/（zustand）terminal/TerminalRegistry.ts styles/tokens.css
scripts/         verify-*.cjs 真实进程验证脚本；make-icon.cjs 由 resources/icon.svg 生成全部图标（1.1.0 起换成玻璃终端窗 + 节点徽章，备选稿在 docs/图标方案2/）
build/           icon.ico / icon.png（exe 与 NSIS 图标）
resources/       icon.png（窗口图标与托盘；打包时经 extraResources 放进 resources 目录）
src/renderer/src/assets/logo.png  标题栏与「关于」页的图标
README.md        面向使用者的说明（功能、快捷键、数据位置、开发与验证命令）
```

## 硬性规则

**安全（技术设计 §8）**
- 渲染层没有任何特权。新增能力 = `shared/channels.ts` 加频道 + 主进程 `sanitize*` 校形 + preload 白名单 + `index.d.ts` 类型，四处同时改。
- `session:start` 等只收 `workspaceId`，命令、参数、目录一律从配置取；永不把渲染层入参直接交给 `spawn`。
- 参数一律用数组，不拼 shell 字符串。
- 文件路径只接受 `workspaceId` + 相对路径，主进程拼绝对路径并 `realpath` 校验仍在工作区目录内，越界一律拒绝。
- env 值不出主进程，渲染层只拿 `envKeys`；落盘用 `safeStorage` 加密。
- 推送渲染层一律走 `sendToRenderer()`，不直接 `mainWindow.webContents.send`。
- 目录栏只读；GitInfoService 只读 `.git/HEAD`，不执行 `git`。

**进程**
- agent 直接作为 PTY 进程启动（不先开 shell）；npm 生成的 `.cmd` 壳由 shimParser 还原成 `node.exe + js`（§5.2）。
- 结束会话：先 `taskkill /T /F`，等 `onExit`，进程仍在才 `pty.kill()`。

**UI（UI设计约束 §6、§7）**
- 文字色不加透明度；字号 ≥ 12px；不用任意值圆角（只用 `--radius-card/control/pill`）。
- 图标用 Phosphor，尺寸只用 16 / 20 / 24；纯图标按钮必须有 `aria-label`。
- 状态不只靠颜色：颜色 + 图标 + 文字。
- zustand 选择器只返回 store 原引用，不在选择器里写 `?? []`（会触发 React #185 无限重渲染），兜底放组件里或用模块级常量。
- 控件文字不折行：全局 `nowrap` 在 `tokens.css` 的 `@layer base`；放不下时让外层布局换行或收起（「⋯」菜单），不要压缩按钮。元素级默认样式必须放进 `@layer base`，不分层的规则会压过 Tailwind 工具类。
- 工作区图标用 `WorkspaceIcon` / `SessionIcon`（`components/ui.tsx`），不要直接放 `AgentBadge`。

**依赖与测试**
- 版本对齐 Mile Terminal（技术设计 §2），不引入拖拽库、组件库、单元测试框架。
- 验证用 `scripts/verify-*.cjs`：启动真实 Electron、加载 `out/`、`executeJavaScript` 驱动渲染层，断言读 DOM / IPC 回执，不靠截图。
- harness 必须在 `require` 主进程包之前 `app.setPath('appData', tmpdir)`，否则会写真实配置。
- harness 输出重定向到文件，不用 `| tail`；脚本自带总超时；清理残留 electron 进程前先按命令行确认是本项目的进程。
- 往源码写转义序列或换行时用独立脚本文件改，改完 `node --check` / `od -c` 检查。

## 里程碑与当前进度

| 里程碑 | 内容 | 状态 |
| --- | --- | --- |
| M0 | 骨架 + PTY 探针 | 完成（`verify-m0-pty.cjs`、`scripts/m0-report.json`） |
| M1 | 单格终端 | 完成（`verify-m1-session.cjs`） |
| M2 | 会话栏与持久化：分组 / 工作区 / 会话三层 CRUD、拖拽排序、搜索、目录栏只读浏览、`.bak` 恢复 | 完成（`verify-m2-rail.cjs` 79 项、`verify-fs-guard.cjs` 32 项） |
| M3 | 宫格与后台会话：1/2/4 切换、拖拽换格、保活回放、分隔条 | 完成（`verify-m3-grid.cjs` 72 项） |
| M4 | 关闭确认、托盘、会话快照、一键恢复 | 完成（`verify-m4-restore.cjs` 61 项，3 次真实启动） |
| M5 | 设置、主题、快捷键、命令面板、NSIS 打包、README | 完成（`verify-m5-settings.cjs` 49 项、`verify-package.cjs` 7 项、`verify-ui.cjs`） |
| 升级 | `docs/升级建议.md` 第一到第三批 + 稳定性 + 工程项 | 完成（`verify-upgrade.cjs` 50 项；未做项见升级建议 §7） |

### M2 完成情况（2026-11-01）

渲染层结构：
- `components/SessionRail.tsx` + `components/rail/`（`GroupLabel` 分组标签行、`WorkspaceCard` 卡片 / 会话子行 / 56px 折叠态、`drag.ts` HTML5 拖拽）。
- `components/actions.tsx`：会话栏、格头、目录栏共用的动作与右键菜单（从 `store.getState()` 取最新状态）。
- `components/FileRail.tsx` + `lib/fileIcons.tsx`：只读懒加载目录树，方向键导航，右键「在资源管理器中显示」。
- `components/ConfirmDialog.tsx`（`confirm()` / `notifyError()`）替代 `window.confirm` / `alert`；`PromptDialog`、`InlineEdit` 做单行输入。
- `WorkspaceDialog` 支持新建 / 编辑、所属分组、环境变量补丁；启动参数用 `lib/args.ts` 的 `formatArgs` 还原成文本。
- 标题栏有会话栏 / 目录栏显隐按钮，`Ctrl+Shift+B` / `Ctrl+Shift+E` 在窗口捕获阶段处理，焦点在终端里也生效且不进 PTY。

### M3 完成情况（2026-11-01）

- 主进程 `services/LayoutStore.ts`：`window-state.json`（原子写、400ms 去抖、`will-quit` 立即落盘），`layout:get` / `layout:update` 逐字段校形；窗口尺寸位置与最大化只由主进程记录，渲染层改不了。
- 渲染层 `store/layout.ts` 是「哪个会话在哪一格」的唯一来源：`gridMode`、`cells`、`focused`（不持久化）、比例、栏宽、栏位偏好。`sessions` store 不再有 `activeId`。
  - `railsOf()`：多格且控制台不足 744px 时临时收目录栏，仍不够再收会话栏；只影响显示，不改偏好；窄窗口里手动展开优先。
  - `place()`：放进某格，已在另一可见格则互换，原占用者转后台；`prune()` 只在会话列表和布局都读回后才清格位（渲染层重载时不误清）。
- `components/Grid.tsx`（宫格 + 分隔条，窗口变窄时按尺寸夹取比例保证每格 ≥ 360×240）、`Splitter.tsx`（`Splitter` / `RailResizer`，指针捕获 + 方向键）、`TerminalPane({ index })`（聚焦框、格头拖拽换格、最大化、空格、整格拖放目标）。
- 动作都在 `components/actions.tsx`：`openWorkspace(w, cell?)`、`newSession`、`placeSession`、`showSession`、`focusCell`；菜单多格时出现「在第 N 格打开」「移到第 N 格」。
- 快捷键（`App.tsx` 捕获阶段）：`Ctrl+Shift+B / E / D / 1–4`、`Ctrl+Tab` / `Ctrl+Shift+Tab`。

### M4 完成情况（2026-11-01）

- 快照：`services/SessionRecords.ts` 管 `config.sessionRecords`（最多 50 条）。记录随会话生命周期即时写盘；`open` = 用户没手动关；退出应用期间（`SessionService.shutdown`）不写退出码。候选在启动时一次性确定。
- 续接：`lib/resume.ts`（各 agent 的续接参数、ID 校验）、`services/ResumeDiscovery.ts`（Codex 轮询 rollout 认领，同目录多个待认领就不写；Kimi 启动前后比对 session_index）。`SessionService.start` 改成 async：同目录的 Kimi 新开排队启动。重启（`restart`）总是新开对话。
- 关闭与托盘：`index.ts` 的窗口 `close` 按 `settings.closeAction` 分流，`ask` 时发 `app:quitRequested` 给渲染层；`quitAll` 先写快照再结束进程树；`window-all-closed` 不退出；单实例锁只在打包后启用。`services/TrayService.ts` 的图标由程序绘制。
- 渲染层：`store/restore.ts`、`components/RestoreCard.tsx`（空格里的卡片；格子占满时收进标题栏入口 `RestorePill` / `RestoreDialog`）、`components/QuitDialog.tsx`、工作区菜单「续接上次对话启动」。启动时 `settings.restoreOnStartup` 为 true 就自动恢复上次没正常退出的会话。
- 新 IPC：`settings:update`（`sanitizeSettingsPatch` 逐项校形）、`session:restoreCandidates / restore / dismissCandidates / resumeWorkspace / resumable`、`app:minimizeToTray / quitAll / quitRequested`、`tray:showSession`。
- 开发期环境变量 `MILE_WARP_AGENT_HOME`：把 `~/.codex`、`~/.kimi-code` 指到别处，打包后不认。

### M5 完成情况（2026-11-01）

- 主进程：`Menu.setApplicationMenu(null)`（默认菜单的 `Ctrl+R` / `Ctrl+W` / 缩放会抢终端按键），开发期 F12 开发者工具；主题走 `nativeTheme.themeSource`；`agent:shells` + `settings:update` 只接受白名单里的 Shell；`MILE_WARP_DATA_DIR` 覆盖配置目录（打包后也认）。
- 渲染层：`components/SettingsDialog.tsx`（外观 / 终端 / Agent / 启动与恢复 / 关于，改动立即生效）、`components/CommandPalette.tsx`（`Ctrl+Shift+K` 或标题栏搜索框）、`components/TerminalSearch.tsx`（`Ctrl+Shift+F`）、标题栏主题菜单与设置按钮。`TerminalRegistry` 加了 SearchAddon，设置变化时同步到所有终端。
- 快捷键（`App.tsx` 捕获阶段）新增 `Ctrl+,`、`Ctrl+Shift+K`、`Ctrl+Shift+F`、`Ctrl+=` / `Ctrl+-` / `Ctrl+0`（写进 `settings.fontSize`）。
- 打包：`scripts/make-icon.cjs` 生成 `build/icon.ico`；`npm run build:win`（2026-11-01 在 Node 22.23 下）产出 `release/Mile Warp Setup 0.1.0.exe`（约 98MB，未签名）；`verify-package.cjs` 冒烟通过。2026-11-01 版本号升到 1.0.0，产出 `release/Mile Warp Setup 1.0.0.exe`（约 99MB，未签名），`verify-package.cjs` 8/8。
- `README.md`：功能、快捷键、数据位置与安全模型、开发与验证命令。

### 布局、工作区图标与性能（2026-11-01）

- 布局：控件文字一律不折行，窄格格头逐级收起，非首个空格改为一行提示；`verify-layout.cjs` 17 项。
- 工作区自定义图标：`workspace:pickIcon`（主进程选图、裁成 128×128，返回一次性 token）+ `workspace:icon`（读 data URL）；文件放在 `<appData>/mile-warp/icons/<workspaceId>.png`，`Workspace.icon` 存内容哈希；配置写失败时编辑还原图标文件、复制删掉副本图标，token 落盘成功才作废；`verify-icons.cjs` 48 项。
- cmd-wrap 兜底路径（非 npm 模板的 `.cmd` / `.bat`）：`commandResolver.spawnArgs()` 自己拼转义好的命令行，不再交给 node-pty 的数组转义；`verify-cmd-wrap.cjs` 10 项。
- 性能：渲染层产物压缩（首屏 JS 1607KB → 855KB）、WebGL 插件与三个大弹窗按需加载、共享 1 秒时钟、遮罩去掉模糊、目录栏每批渲染 300 项且主进程并发 stat；`verify-perf.cjs` 13 项。数字见 decisions。

未做 / 后续：
- 自定义 agent（A-03，P1）、`keepShellOnAgentExit`（决定不做）：见 decisions 2026-11-01。
- P2：分组色点（W-13）、目录栏「有更新」提示（D-06 可选部分）、广播输入（T-17）、任务完成通知（T-16）、托盘数字角标、自定义 agent 的续接模板、命令面板文件搜索。
- 需要人工确认：真实 Claude / Codex / Kimi 收到续接参数后能否接上对话（harness 用的是假 agent）；Codex `resume <id>` 后面再跟工作区参数的相容性；安装包在干净机器上的安装与卸载。

### 升级（2026-11-01，按 `docs/升级建议.md`）

- 配置 v2：`layoutPresets`、快照 `pid` / `exe`、自定义 agent 字段；`ConfigStore.migrate` 有显式分支。
- 主进程：`lib/log.ts`（按天日志）、`lib/badge.ts`（任务栏角标）、`lib/editor.ts`（找 `code.cmd` 背后的 Code.exe）；`SessionService` 管活动状态（`activity` / `attention` / `idle` 事件）与孤儿进程；`FileTreeService.watchDirs` 非递归 watch；`render-process-gone` 自动重载（1 分钟 3 次后停）。
- 渲染层：`store/activity.ts`、`components/fileActions.tsx`、`ShortcutsSheet.tsx`、`lib/pinyin.ts`、`lib/palette.ts`、`lib/shortcuts.ts`；`ConfirmDialog.choose()` 三按钮；`TerminalRegistry` 加路径链接、滚动状态、输入钩子（广播）。
- 未做：3.8 git 改动标记（待拍板）、5.1 签名（无证书）、5.3 检查新版本（无发布地址）、3.6 自定义快捷键。

### 会话历史（2026-11-01，按 `docs/会话管理升级计划.md` P0 到 P2，只读）

- 主进程 `services/SessionHistory.ts` + `services/history/`（Claude / Codex / Kimi / Pi 四个适配器）；`shared/path.ts` 做目录规范化。IPC：`history:list / detail / export / reveal / resume`，渲染层只传 `historyId`。
- 渲染层 `components/HistoryDialog.tsx`（按需加载），入口：标题栏、`Ctrl+Shift+H`、命令面板、工作区右键「历史会话…」。
- `npx electron scripts/verify-history.cjs`（63 项）；开发期变量 `MILE_WARP_TEST_SAVE` 跳过保存对话框。
- 未做：P3 改名与删除、P4 Codex 写库（等计划 §9 拍板）。
- 版本号 1.1.0 → 1.2.0（换新图标：玻璃终端窗 + 节点徽章，`resources/icon.svg` 为源文件），`npm run build:win`（Node 22.23）产出 `release/Mile Warp Setup 1.2.0.exe`（约 99MB，未签名），`verify-package.cjs` 8/8。
- 顺带修的既有问题：`verify-perf` 首屏 JS 超预算 → 渲染层 `assetsInlineLimit: 0`（agent 图标不再内联进主包）+ 标题栏/菜单复用已打包图标，回到 ≈900KB 内；`verify-m5` 的「Ctrl+W 窗口没关」断言改成 `!isDestroyed`（窗口被最小化时 `isVisible` 也是 false）；`verify-upgrade` 广播断言改成去换行再比（窄格里 'Q' 在末列 'Z' 折行，`includes('QZ')` 误判，广播功能本身没问题）；`SessionService.flush` 只在输出含可见文字时刷新 `lastOutputAt`（空闲 TUI 的纯转义重绘不再把会话顶成「对话中」）。`__warpDebug` 排障面：`layout()`（布局快照）、`inputHookActive()` / `hookStats()`（onData 计数、hook 拦截、apply 丢弃/切片记录）、`sessionStore()`。全量 `verify:all` 15/15、563/563。

### 文件预览（2026-11-03，技术设计 §6.4 预览栏）

- 目录栏第三根 rail（右侧）：`previewRailWidth`（280–640，默认 380）+ `previewRailVisible` 持久化到 `window-state.json`；预览目标永不持久化。
- IPC：`fs:readText`（`{workspaceId, relativePath}` → `{content, truncated, binary, size, mtime}`；>2MB 拒、>1MB 截、前 8KB 含 `\0` 标 binary）+ `fs:readImage`（扩展名白名单 png/jpg/jpeg/gif/webp/bmp/ico、>20MB 拒、最长边 >1600 由 nativeImage 缩放）。路径校验复用 `FileTreeService.locate`（realpath 越界拒绝）。
- 渲染层：`store/preview.ts`（target / loading / result / error，reqId 挡竞态）；`components/PreviewRail.tsx`（aside + RailResizer + 头部 + 三分支占位）；`components/preview/markdown.ts`（marked + DOMParser 白名单 sanitizer，项目唯一 `dangerouslySetInnerHTML` 用点）；`components/preview/MarkdownView.tsx`（React.lazy 分包 52KB，不进首屏）；`components/previewIcons.tsx`（本地 4 个 Phosphor path，省 6 字重 defs ≈16KB）。
- 交互：单击文件即预览（目录单击仍 toggle）；Esc 关预览（`dialog[open]` 时让位）；切工作区清空；md 相对图片拼 `dirname(rel)+src` 仍走 `fs:readImage`（越界主进程兜）换 data URL；外链 `a[target=_blank rel=noopener]` 点击拦 `shell.openUrl`；外链 `img` CSP 不放行，换成 `[外链图片 …]` 占位。
- `npx electron scripts/verify-preview.cjs`（35 项）：IPC 上限/越界、md 渲染、sanitizer 剥 script/onclick/onerror/iframe/非 http(s) href、相对图片换 data URL、Esc 关预览、切工作区清空、栏宽持久化、右键菜单。
- 首屏 JS 预算 900 → 950 KB：marked 是独立 lazy chunk（52KB）不进首屏；新增 ~30KB 是预览栏本身 + store + 布局字段 + md-body CSS + 4 个图标 path。决策记录 2026-11-03。
- 修了一处：preload 曾把参数发成 `{workspaceId, path}`，`FileTreeService.locate` 要 `relativePath`，改 preload 适配契约（IPC 主进程直接把 arg 透传给 `locate`）。

### Skills 管理（2026-11-04，按 `docs/Skills管理-PRD.md` M0-M4）

- 目录映射（M0 探针 `scripts/probe-skills.cjs` 本机定稿）：claude `~/.claude/skills`、codex `~/.codex/skills`、全局仓 `~/.agents/skills`（独立一行，trae/qoder 的 skills 是指向它的 symlink）；kimi / pi 无 skill 目录，不列；自定义 agent 不扫。
- 主进程：`services/SkillsService.ts`（两级扫描对齐 skillkit、无依赖 frontmatter 解析、name 只允许一层且越界拒绝、uninstall / installTo 同名 overwrite 先留 `.bak-<ts>`）；`lib/extractGuard.ts`（zip 逐条目校验 + tar.gz 走系统 bsdtar + 解压后终检）；`lib/githubInstall.ts`（URL 解析矩阵 owner/repo、tree/branch/subpath、git@、短格式；codeload 下载 30s 超时 50MB 上限；harness 用 `MILE_WARP_CODELOAD_OVERRIDE` 指本地 http 假源）。依赖新增 adm-zip（纯 JS）。
- IPC：`skills:scan / detail / installTo / uninstall / reveal / parseGithubUrl / installGithub / pickZip / installZip`；渲染层只传 agentId + name，zip 路径由主进程对话框选（渲染层拿不到）。
- 渲染层：`components/SkillsDialog.tsx`（lazy chunk；tab 切「我的 Skill / 安装 Skill」；左栏 agent 筛选带品牌图标（skillkit MIT 图标集，补 `global.svg`/`pi.svg`，pi.png 退役）；同名 skill 跨 agent 徽章对照；详情复用预览栏 markdown 管线，首版禁图）；入口标题栏 + `Ctrl+Shift+S` + 命令面板。
- `npx electron scripts/verify-skills.cjs`（52 项）：扫描（frontmatter / 中文名 / 两级布局 / 悬空 symlink）、detail 越界 ×3、installTo（skip / overwrite+.bak / 未知目标 / 自身）、卸载、URL 解析 ×7、GitHub 安装（本地假源）、zip 安装、**zip-slip 拒绝**（手写 entryName 含 `../` 的 zip 二进制——adm-zip 打包时会规范化路径，夹具必须手写）、渲染层（弹窗 / 搜索 native setter / 详情 / 安装页 / 目标选择）。
- 首屏 935KB < 950 预算；SkillsDialog chunk 12.4KB。
- 未做：P2 的同名对照批量安装、GitHub 来源更新检查、skills.sh 市场、skill 详情图片（首版禁图，P1 再议）。
- 待人工确认：真实 GitHub 连通性（harness 用本地假源）；真实 agent 是否识别新装的 skill。

### Git 管理（2026-11-05，`docs/Git管理-PRD.md` 定稿 v1.0）

- PRD 已定稿，§10 六个问题全部按草案默认拍板；decisions 同日条目放宽「不执行 git」（仅总开关打开后）。
- G0 完成：`Settings.gitEnabled`（默认 false）/ `gitDefaultRemote`（默认 origin，拒 `-` 开头）+ 设置页「Git」页签；主进程 `services/GitService.ts`（simple-git，`git.exe` 由 `whichCommand` 从 PATH 找，固定 `-c core.fsmonitor=false -c core.quotepath=false`、`GIT_OPTIONAL_LOCKS=0`、剥 `GIT_EDITOR` 等变量、本地命令 15 秒超时）；IPC `git:probe`（不返回绝对路径）/ `git:status`，开关关着时 probe 返回 disabled、其它一律拒绝。原 `GitInfoService` / `git:branch` 不动。
- `npx electron scripts/verify-git.cjs`（45 项）：默认关零 git、设置页开关落盘、远端名校形、probe（子目录 / 非仓库 / 越权 id）、status（中文空格路径、重命名带 oldPath、同文件暂存+未暂存两行、删除、detached、远端）、恶意 `core.fsmonitor` 不被执行。首屏 914KB。
- 下一步 G1：右栏页签、改动列表、暂存 / 取消 / 丢弃、diff、提交、自动刷新。

更新进度时改本节。
