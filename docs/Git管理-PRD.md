# Git 管理 PRD（G-）

> 状态：定稿 v1.0（2026-11-05），§10 的问题全部按草案默认拍板
> 关联：`docs/PRD.md`、`docs/技术设计.md`（§7 IPC 契约、§8 安全模型）、`docs/UI设计约束.md`、`docs/升级建议.md` §3.8
> 来源项目：`E:\WebApp\Mile-Project\Mile-Git-Management\Git-Management-electron`（Mile Git Management 2.3.0，以下简称「源项目」）

## 0. 一句话

把源项目的日常 git 操作（看改动、看 diff、暂存、提交、切分支、拉取推送、看历史）搬进 Mile Warp，作为一个可选的「Git 栏」：用户在看 agent 干活的同时，就地检查 agent 改了什么并提交。UI 完全按 Mile Warp 的令牌和组件重写，源项目只搬主进程的 git 能力层。

## 1. 背景

- Mile Warp 的用户在格子里跑 Claude Code / Codex，agent 改完文件后，要切到别的工具（源项目、VS Code、命令行）看 diff 和提交。
- 源项目已经把这些做完并踩过坑（中文路径 `-z`、`%b` 多行、`origin/HEAD` 伪分支、凭据弹窗卡死），主进程层可以直接移植。
- Mile Warp 现在对 git 只有 `GitInfoService`：读 `.git/HEAD` 显示分支名，**不执行 git**。这是 decisions.md 里的既有决策，本功能要放宽它（见 §6.1）。

## 2. 用户与场景

| 场景 | 现在 | 有了 Git 栏 |
| --- | --- | --- |
| agent 说「改完了」，想看改了哪些文件 | 切到别的工具 | `Ctrl+Shift+G` 打开 Git 栏，改动列表就在终端旁边 |
| 看某个文件具体改了什么 | 同上 | 点文件进 diff，看完返回列表 |
| 满意了提交 | 切到终端敲 git，或让 agent 提交 | 勾文件、写提交信息、`Ctrl+Enter` |
| 让 agent 在新分支上干活 | 手动 `git checkout -b` | 格头分支 pill 点开，新建并切换 |
| 推到远端 | 命令行 push | 栏顶「推送」按钮，显示阶段进度，可取消 |
| 回顾 agent 这一下午提交了什么 | `git log` | Git 工作台的「历史」页 |

## 3. 功能清单

优先级：P0 首期必做 / P1 首期应做 / P2 以后再说。编号 G-n。

### 3.1 开关与入口

| 编号 | 功能 | 优先级 | 说明 |
| --- | --- | --- | --- |
| G-01 | 设置「启用 Git 管理」总开关 | P0 | 设置页新增「Git」分区，默认关。关闭时应用不执行任何 `git` 命令，行为与现在完全一致；格头分支 pill 仍按现在的方式读 `.git/HEAD` |
| G-02 | Git 栏显隐 | P0 | 总开关打开后：标题栏出现 Git 按钮，`Ctrl+Shift+G` 切换显隐，命令面板有「打开 / 关闭 Git 栏」。显隐状态写进 `window-state.json`，与会话栏、目录栏同一套 |
| G-03 | Git 栏跟随工作区 | P0 | 显示「当前聚焦格的会话」所属工作区的仓库；聚焦格为空时保留上一个。栏头显示工作区图标 + 名称 + 仓库根相对路径（工作区目录可能是仓库的子目录） |
| G-04 | 非 git 目录 / 未装 git 的空态 | P0 | 工作区不在 git 仓库内：空态「这个工作区不是 git 仓库」；PATH 里找不到 `git.exe`：空态给出原因，不弹错误框 |
| G-05 | 格头分支 pill 可点击 | P1 | 总开关打开时，点 pill 打开分支菜单（G-20），同时把 Git 栏切到这个工作区 |
| G-06 | 工作区右键菜单「Git…」 | P1 | 打开 Git 栏并定位到该工作区 |

### 3.2 改动与提交（Git 栏主体）

| 编号 | 功能 | 优先级 | 说明 |
| --- | --- | --- | --- |
| G-10 | 改动列表 | P0 | 两组：「已暂存」「未暂存」（含未跟踪），各组可折叠、有数量；每行 = 状态徽标（文字 M / A / D / R / U，颜色 + 字母，不只靠颜色）+ 文件名 + 灰色目录；冲突文件单独标「冲突」 |
| G-11 | 暂存 / 取消暂存 | P0 | 行尾按钮（悬停出现，键盘聚焦也出现）+ 组头「全部暂存 / 全部取消」+ 勾选后批量 |
| G-12 | 丢弃改动 | P0 | 行尾「⋯」菜单里，确认框列出文件名；未跟踪文件是删除，确认框文案写明「会删除文件」 |
| G-13 | diff 查看 | P0 | 点文件，栏内切到 diff 视图（顶部「返回」+ 路径 + `+N −N`），逐行统一视图，双行号。二进制、超大（>1MB 或 >5000 行）给空态说明；未跟踪文件显示为全量新增 |
| G-14 | 提交 | P0 | 栏底提交框：摘要单行 + 描述多行（可收起）+ 主按钮「提交 N 个文件」。`Ctrl+Enter` 提交；暂存区为空时按钮禁用并说明原因 |
| G-15 | 提交草稿 | P1 | 按 workspaceId 记住未提交的信息，切走再回来还在；提交成功清掉 |
| G-16 | 自动刷新 | P0 | 打开 Git 栏、窗口获得焦点、切换工作区、会话从「对话中」转为「空闲」时静默刷新，节流 2 秒；栏头有手动刷新按钮。不做轮询 |
| G-17 | 改动文件跳目录栏 / 预览栏 | P1 | 行的右键菜单：「在目录栏中定位」「预览文件」「在资源管理器中显示」，复用 `fileActions.tsx` |
| G-18 | 目录栏改动标记 | P1 | 总开关打开时，目录栏给改过的文件标 M / A / D / ?（字母 + 信号色），复用 Git 栏同一次 `git status` 的结果，不另跑命令；对应升级建议 §3.8 |

### 3.3 分支与远端

| 编号 | 功能 | 优先级 | 说明 |
| --- | --- | --- | --- |
| G-20 | 分支菜单 | P0 | 栏头分支 pill（与格头同款）点开：本地分支列表，当前分支打勾，可搜索；底部「新建分支」输入行（Enter 创建并切换） |
| G-21 | 切换分支 | P0 | 有未提交改动导致切换失败时，把 git 的报错翻成「当前有未提交的改动，先提交或丢弃再切换」 |
| G-22 | fetch / pull / push 按钮组 | P0 | 栏头一组三个按钮；pull 显示落后数、push 显示领先数；没有远端时整组禁用并说明 |
| G-23 | 远端操作进度与取消 | P0 | 进行中按钮显示中文阶段 + 百分比（「接收对象 42%」），超过 1.5 秒出现「取消」；同一仓库同时只跑一个远端操作 |
| G-24 | 首次推送自动设上游 | P0 | 当前分支没有上游时，push 自动 `-u <defaultRemote> <当前分支>`，按钮提示「推送并设为上游」 |
| G-25 | pull 冲突提示 | P0 | pull 产生冲突时不报错，改动列表顶部出现冲突横条，冲突文件置顶；解决冲突本身让用户在编辑器或 agent 里做 |
| G-26 | 合并分支、删除分支 | P2 | 源项目主进程已有，UI 没做；首期不做 |
| G-27 | 强制推送 | P2 | 首期不提供入口 |

### 3.4 历史（Git 工作台）

| 编号 | 功能 | 优先级 | 说明 |
| --- | --- | --- | --- |
| G-30 | Git 工作台大弹窗 | P1 | Git 栏头「展开」按钮打开，形态同 `SkillsDialog`（lazy chunk）。两个页签：「改动」（左列表右 diff，宽屏看 diff 用）、「历史」 |
| G-31 | 提交历史 | P1 | 列表：单列时间线 + 提交摘要 + 短哈希 / 作者 / 相对时间，每页 50 条「加载更多」；当前分支 |
| G-32 | 提交详情 | P1 | 选中提交：完整信息 + 改动文件列表（增删行数），点文件看该提交里的 diff；复制哈希 |
| G-33 | 历史搜索、按文件看历史 | P2 | |

### 3.5 本期不做

stash、tag、amend、reset / revert / cherry-pick、rebase、冲突解决界面、按块（hunk）暂存、blame、init / clone、子模块、凭据管理界面、多 remote 选择界面、仓库登记表（源项目的 SQLite 仓库库）、源项目的工作区分组 / 别名 / 备注（Mile Warp 的工作区本身就是这些）。

## 4. 界面

### 4.1 位置：右侧栏与预览栏共用一个槽位

现在右侧是预览栏（280–640px）。Git 栏不新开第四根栏，而是和预览栏共用右侧槽位，顶部两个页签「预览 / Git」：

- 控制台宽度计算不变，`railsOf()` 的收让顺序不用加一级（窄窗口下右栏和现在的预览栏一样处理）。
- 单击目录栏文件仍打开「预览」页签；`Ctrl+Shift+G` 打开「Git」页签。
- 只开其中一个时只显示那个页签的标题，不显示切换条。
- 栏宽两个页签共用，默认 380，Git 页签下允许拖到 640 看 diff。

```
┌ 会话栏 ┬ 目录栏 ┬──────── 控制台（1/2/4 格）────────┬── 右栏 ──────────────┐
│        │        │ [格头 claude · main ▾ ]            │ 预览 | Git           │
│        │        │                                    │ [图标] Mile-Warp     │
│        │        │                                    │ main ▾   ↓2  ↑1  ⟳ ⤢ │
│        │        │                                    │ ── 已暂存 (2) ────── │
│        │        │                                    │ M  index.ts  src/... │
│        │        │                                    │ A  GitRail.tsx  ...  │
│        │        │                                    │ ── 未暂存 (3) ────── │
│        │        │                                    │ M  types.ts   ...    │
│        │        │                                    │ ?  new.md            │
│        │        │                                    │ ──────────────────── │
│        │        │                                    │ [提交摘要          ] │
│        │        │                                    │ [ 提交 2 个文件     ] │
└────────┴────────┴────────────────────────────────────┴──────────────────────┘
```

（上图箭头、刷新、展开都是 Phosphor 图标，图里用字符示意。）

### 4.2 视觉规则（全部按 Mile Warp，不搬源项目样式）

- 颜色、圆角、字体、阴影只用 `tokens.css` 的语义令牌；状态徽标用信号色：新增 `live`、修改 `warn`、删除 `fault`、未跟踪 `idle`、冲突 `fault` + 文字「冲突」。
- diff 区用 `bg-sunken` 凹陷面 + `font-mono`；新增 / 删除行用信号色的浅底，文字色不加透明度。
- 图标用 Phosphor（`GitBranch` / `GitCommit` / `GitDiff` / `ArrowDown` / `ArrowUp` / `ArrowsClockwise`），尺寸 16 / 20；纯图标按钮都有 `aria-label`。
- 按钮、菜单、确认框复用 `components/ui.tsx`、`openMenuAt`、`confirm()`、`notifyError()`；错误文案走 `lib/errors.ts`。
- 控件文字不折行；栏窄时 fetch / pull / push 收进「⋯」，不压缩按钮。
- 源项目里值得借的交互：阶段化中文进度、延迟出现的取消按钮、提交成功 600ms 成功态、空态「工作区很干净」。动效只用 `transform` / `opacity`，遵守「减少动效」。

## 5. 数据与状态

- **不新增持久化业务数据**。仓库 = 工作区目录所在的 git 仓库，用 `git rev-parse --show-toplevel` 实时求；git 状态、历史全部实时查，不缓存到配置。
- `Settings` 新增：`gitEnabled: boolean`（默认 false）、`gitDefaultRemote: string`（默认 `origin`，只允许 `[A-Za-z0-9._-]`）。
- `Layout` 新增：`rightRailTab: 'preview' | 'git'`、`gitRailVisible: boolean`；栏宽沿用 `previewRailWidth`（改名留到实现时决定，保持旧键兼容）。
- 提交草稿存渲染层 `localStorage`，键 `warp.commitDraft.<workspaceId>`，不进配置文件。

## 6. 安全模型（对齐技术设计 §8）

### 6.1 放宽「不执行 git」

现有决策「GitInfoService 只读 `.git/HEAD`，不执行 git」改为：**只有 `gitEnabled` 为 true 时**，主进程可以在工作区所在仓库执行 git。决策写进 `decisions.md`，同时关闭升级建议 §3.8 的待拍板状态。

### 6.2 规则

1. **渲染层只传 `workspaceId`**，主进程用 `workspaceDir()` 从配置取目录，再求仓库根。源项目是渲染层传 `repoPath` + 登记表闸门，这里不沿用。
2. **文件参数只收相对仓库根的路径**，主进程 `path.resolve` 后 `realpath` 校验仍在仓库根内，越界拒绝；丢弃永不删仓库根。
3. **分支名、远端名、提交哈希逐个校形**（移植源项目 `assertRefName` / `assertRemoteName` / `assertCommitHash`）：拒绝 `-` 开头，防止被当成参数。
4. **参数一律数组**，`execFile` 调 `git.exe`，不经 shell；`git.exe` 用 `commandResolver.whichCommand` 从 PATH 定位。
5. **环境变量清洗**（移植源项目）：剥掉 `GIT_EDITOR / EDITOR / VISUAL / GIT_SSH* / GIT_ASKPASS / SSH_ASKPASS / GIT_EXEC_PATH / GIT_PROXY_COMMAND`，注入 `GIT_TERMINAL_PROMPT=0`、`GCM_INTERACTIVE=never`、`GIT_MERGE_AUTOEDIT=no`。凭据完全交给系统 credential helper / SSH agent，缺凭据时远端操作直接失败并提示，不弹密码框，应用不存任何凭据。
6. **所有命令带超时**：本地命令 15 秒，远端命令 5 分钟（可取消）；`maxBuffer` 有上限，diff 超限走「文件太大」空态。
7. **破坏性操作**（丢弃）在渲染层确认；主进程侧另外只接受确认后带回的一次性 token（与 `workspace:pickIcon` 同模式），防止渲染层被注入后直接调用。
8. 推送渲染层只走 `sendToRenderer()`；新增 IPC 照例四处同改（`channels.ts` + `sanitize*` + preload 白名单 + `index.d.ts`）。

## 7. IPC 契约（G0 实现时按代码回写定稿）

入参都含 `workspaceId`，下表省略。返回沿用 Mile Warp 现有的抛错约定（不引入源项目的 `{code,msg,data}`）。

| 频道 | 入参 | 返回 |
| --- | --- | --- |
| `git:probe` | — | `{ available: true, repoName, relativeDir }` 或 `{ available: false, reason: 'disabled' \| 'no-git' \| 'not-repo' \| 'error', message? }`（G0 按代码回写：不返回仓库绝对路径） |
| `git:status` | — | `{ branch, detached, ahead, behind, upstream?, hasRemote, files: GitFile[] }` |
| `git:stage` / `git:unstage` | `paths: string[]`（空数组 = 全部） | `void` |
| `git:discardPrepare` | `paths: string[]` | `{ token, files }` |
| `git:discard` | `token` | `void` |
| `git:diff` | `path, staged` | `{ hunks, binary, tooLarge }` |
| `git:commit` | `summary, description?` | `{ hash }` |
| `git:branches` | — | `BranchInfo[]`（只本地） |
| `git:checkout` | `branch` | `void` |
| `git:createBranch` | `name` | `void`（创建并切换） |
| `git:fetch` / `git:pull` / `git:push` | — | `pull` 返回 `{ conflict }` |
| `git:cancel` | — | `void` |
| `git:progress`（主进程推送） | — | `{ workspaceId, op, stage, percent }` |
| `git:log` | `offset, limit≤100` | `{ commits, hasMore }` |
| `git:commitDetail` | `hash` | `CommitDetail` |
| `git:commitFileDiff` | `hash, path` | `DiffResult` |

现有 `git:branch`（读 `.git/HEAD`）保留不动。

## 8. 实现要点

- **主进程**：新建 `services/GitService.ts`；从源项目移植 `src/main/git/index.ts` 的命令与纯函数解析器（`parseDiff`、`parseCommitLog`、`parseNameStatusZ`、`parseNumstatZ`）及其坑位处理。主进程引入 `simple-git`（§10 Q5），git.exe 路径用 `whichCommand` 定位后传给它。
- **渲染层**：`store/git.ts`（当前工作区、状态、reqId 挡竞态，仿 `store/preview.ts`）；`components/GitRail.tsx` 首屏只放壳，改动列表 / diff / 提交框放 lazy chunk；`GitWorkbench.tsx`（工作台弹窗）整体 lazy。首屏 JS 预算 950KB 只剩约 15KB，Git 相关代码不进首屏。
- **验证**：`scripts/verify-git.cjs`，在临时目录 `git init` 出真实仓库（中文文件名、未跟踪、重命名、二进制、冲突），用本地裸仓库当远端测 fetch / pull / push；断言 IPC 回执与 DOM，覆盖越界路径、`-` 开头分支名、关闭总开关后零 git 调用。加进 `verify:all`。

## 9. 里程碑

| 里程碑 | 内容 | 验收 |
| --- | --- | --- |
| G0 | 总开关、`GitService` 骨架、`git:probe` / `git:status`、IPC 契约定稿 | 关开关零 git 进程；临时仓库状态正确 |
| G1 | 右栏页签、改动列表、暂存 / 取消 / 丢弃、diff、提交、自动刷新 | `verify-git` 改动与提交部分 |
| G2 | 分支菜单、切换 / 新建、fetch / pull / push、进度与取消 | 本地裸仓库远端用例 |
| G3 | Git 工作台（宽屏改动页 + 历史 + 提交详情）、格头 pill 联动、右键菜单 | 历史分页、详情 diff |
| G4 | 文档、README、`verify-layout` / `verify-perf` 回归、版本号 | 全量 `verify:all` 通过 |

## 10. 已拍板问题

2026-11-05 米乐确认：全部按草案默认。

| 编号 | 问题 | 结论 |
| --- | --- | --- |
| Q1 | Git 界面放哪：右栏页签（与预览共用）+ 工作台弹窗，还是只做全屏弹窗，还是放进格子里 | 右栏页签 + 工作台弹窗（不做格内面板） |
| Q2 | 「用户自行选择是否打开」指什么：设置总开关（默认关）+ 随时显隐，还是默认开、只是可以收起 | 设置总开关，默认关；打开后随时显隐 |
| Q3 | 首期范围：§3 的 P0 + P1，还是先做只读（状态 + diff + 历史） | P0 + P1（G0 到 G4） |
| Q4 | 是否顺带做升级建议 §3.8：目录栏给改动文件标 M / A / ? | 做，见 G-18 |
| Q5 | 主进程用 `simple-git`（源项目同款，移植快，多一个依赖）还是直接 `execFile` | `simple-git`，只在主进程用，不进渲染包 |
| Q6 | 提交时是否运行仓库自己的 git hooks（pre-commit 等）。不跑更安全，但用户的格式化 / lint 钩子会失效 | 跑（用户主动点提交，等同在命令行提交）；钩子失败时把输出原样显示给用户 |
