# Skills 管理 — 可行性分析与开发计划

> 状态：v1.0（2026-11-04）
> 姊妹文档：`docs/Skills管理-PRD.md`（功能清单 / 数据模型 / IPC 契约 / 里程碑在此不重复）
> 本文回答两个问题：**能不能做**（可行性）和**怎么排期**（计划）。

---

## 一、可行性分析

### 1.1 参考 projectskillkit 给出的三个已验证前提

skillkit（robotbird/skillkit，MIT）是一个功能几乎重合的 Electron 桌面应用，代码级调研（clone 后通读 `tools.ts` / `scan.ts` / `skill-md.ts` / `installer.ts`）确认：

| 前提 | 证据 | 对 Mile Warp 的意义 |
| --- | --- | --- |
| skill 目录约定稳定 | 20 个工具的映射表集中在 `tools.ts`，全部是 `~/.<tool>/skills` 形态；cline/warp/kimi 共享 `~/.agents/skills`（对齐 vercel-labs/skills CLI） | 不需要发明约定，抄映射表 + 本机实测 |
| SKILL.md frontmatter 极简 | `skill-md.ts` 60 行无依赖解析器：`---` 起始 + `\n---` 闭合 + 扁平 `key: value`（支持续行与引号剥离） | 直接照抄解析语义， Mile Warp 侧 ~60 行 |
| 「文件系统是真相，DB 是缓存」 | `scan.ts`：每次 install/uninstall 后 `scanAll()` 重建；内容字段覆盖写、来源字段 COALESCE 保留 | Mile Warp 可以不引入 SQLite——本机 skill 数 < 200，JSON 配置 + 即扫即用足够 |

skillkit 用 better-sqlite3 + pnpm monorepo，比 Mile Warp 重得多；它的 20 工具全家桶里 Mile Warp 只需要 4 个内置 agent + 全局仓，**裁剪后复杂度大约是 skillkit 的 1/5**。

### 1.2 与 Mile Warp 现有架构的契合度（逐项核对过代码）

| 需要的能力 | Mile Warp 现状 | 缺口 |
| --- | --- | --- |
| 居中大弹窗 + lazy chunk | `HistoryDialog.tsx`（24.5KB 独立 chunk，`React.lazy` 按需加载） | 无，照抄模式 |
| SKILL.md 渲染 | 1.3.0 预览栏：`marked` + DOMParser 白名单 sanitizer + 相对图片换 data URL（`components/preview/`） | 无，**直接 import 复用**；skill 目录相对图片要走新的校验路径（见 1.4 风险 3） |
| 路径越界校验 | `FileTreeService.locate()`（realpath + 大小写不敏感 `inside()`） | 需要新形式的「agent 根目录」校验（不是 workspaceId），但 `inside()` 判定逻辑可提取共用 |
| 确认弹窗 / 三按钮 | `ConfirmDialog.confirm()` / `choose()` | 无 |
| 配置加字段 | `ConfigStore.migrate` 有显式版本分支惯例（v2 迁移先例） | 加 `skillMeta` 可选字段 + 一个 migrate 分支 |
| pinyin 搜索 | `lib/pinyin.ts`（会话栏在用） | 无 |
| 主进程下载 | 无（项目至今无网络出站代码） | **新增**：codeload 下载 + 超时；zip/tar 解压 + 逐条目路径校验（全项目第一个解压面，风险见 1.4） |

结论：**P0（扫描/详情/卸载/跨 agent 复制）不引入任何新依赖**；P1（GitHub/zip）只引入 `adm-zip`（纯 JS，无 node-pty 式 ABI 重编问题）。

### 1.3 本机实测数据（2026-11-04）

- `~/.claude/skills`：49 个 skill，标准布局 `<name>/SKILL.md`
- `~/.codex/skills`：31 个
- `~/.agents/skills`：100 个（全局仓，实际在用）
- `~/.kimi-code/`：**未发现 skills 目录**（待 M0 探针确认 Kimi Code CLI 的约定或判定不支持）
- 实测 `diagnose/SKILL.md`：标准 frontmatter（name + description），描述含中文

扫描性能估算：3 个根目录 × ~180 个子目录，每个 readdir + stat + 读一次 SKILL.md（< 8KB），Node 同步 IO 实测量级 < 100ms——**即扫即用成立，不需要缓存层**。

### 1.4 风险清单（按严重度排序）

| # | 风险 | 等级 | 对策 | 落点 |
| --- | --- | --- | --- | --- |
| 1 | **解压路径穿越**（zip-slip / tar `../` 条目）——这是全项目第一个「把不受信压缩包解到磁盘」的代码面 | 高 | 逐条目 resolve 后必须落在解压临时目录内，越界条目跳过 + 记日志；解压到**临时目录**而非直接进目标，确认布局合法（含 SKILL.md）后才复制 | `lib/extractGuard.ts` + M3 harness 用恶意 zip 用例（本地构造 `../evil.txt` 条目） |
| 2 | agent 目录约定漂移（kimi 已经历过共享仓变更） | 中 | 路径表集中 `skills/tools.ts` 一处；扫描按 agent 独立容错（某目录不存在 → `errors[]` 上报，不阻塞其他 agent）；UI 显示「未发现 skill 目录」而非报错弹窗 | M0 探针 + SkillsService 结构 |
| 3 | skill 内相对图片路径越出 skill 目录（`../../secret.png`） | 中 | 详情渲染的图片只允许 skill 目录内相对路径，`resolve` 后必须 `inside(skillDir)`；越界换占位文字。**不能直接复用预览栏的 `fs:readImage`**（那套按 workspaceId 校验），需要 skill 专用的受限读取频道或干脆首版禁图 | M1 定稿（推荐首版禁图，P1 再放开） |
| 4 | 覆盖同名丢手写 skill | 中 | 覆盖前旧目录改名 `<name>.bak-<ts>` 保留（对齐项目 `.bak` 惯例）；确认弹窗列明「将覆盖」 | M2 |
| 5 | GitHub 网络不通（本机到 codeload） | 中 | 6s 首字节超时 + 明确报错；M3 harness 用本地 http 服务给假 tar.gz，不依赖真 GitHub；真机连通性作为 M4 人工确认项 | M3/M4 |
| 6 | 中文 / 特殊字符 skill 名进 IPC 与配置键 | 低 | 键用目录名原样（不 normalize），Windows 中文路径只经 Node `fs` 不进 shell（项目既有铁律）；`skillMeta` 键 `agent:name` 形态含中文时 JSON 无碍 | M1 |
| 7 | 首屏包体超预算（950KB） | 低 | SkillsDialog 走 lazy chunk（HistoryDialog 先例 24.5KB 不进首屏）；预计首屏增量 < 5KB（入口按钮 + IPC 类型） | M4 verify-perf 断言 |

### 1.5 结论

**可行，建议立项。** P0 部分无新依赖、无新安全面、复用三套既有基建（弹窗模式 / markdown 管线 / 确认框），是纯增量模块。唯一要严肃对待的是 P1 的解压面（风险 1），方案已明确且可测。skillkit 在同技术栈上把整件事跑通了，裁剪版风险更低。

**不建议做的部分**：skills.sh 市场抓取（SK-11）依赖第三方页面结构 + 需要内容审查策略，投入产出比低，留在 P2 观望；分享短链需要服务端，与 Mile Warp「本机工具」定位不符，明确不做。

---

## 二、开发计划

### 2.0 前置：需要米乐拍板的 4 个问题（PRD §11）

1. kimi / pi 的 skill 目录实测后不存在 → 是否接受「不列该 agent」？
2. `~/.agents/skills` 全局仓独立一行展示（推荐）还是折进 kimi？
3. skill 详情**首版禁图**（推荐，P1 放开）还是直接做受限读取？
4. 自定义 agent 本期不扫（推荐），OK？

> 未回复时按括号内推荐项执行。

### 2.1 排期总览

| 里程碑 | 内容 | 预估 | 依赖 |
| --- | --- | --- | --- |
| M0 | 目录探针 + IPC 契约定稿 | 0.5 天 | 拍板 §2.0 |
| M1 | 扫描 + SkillsDialog（列表 / 搜索 / 筛选）+ 详情渲染 + 打开目录（SK-01/02/03/08） | 1 天 | M0 |
| M2 | 卸载 + 跨 agent 安装 + 冲突三选 + `.bak`（SK-04/05） | 1 天 | M1 |
| M3 | GitHub / zip 安装 + extractGuard + 回滚（SK-06/07） | 1–1.5 天 | M2 |
| M4 | 打磨：性能预算、文档、打包 | 0.5 天 | M3 |

合计 **4–5 个工作日**；若只做 P0（M0–M2 + 收尾），**2.5–3 天**。

### 2.2 各里程碑明细

#### M0 — 探针与契约（0.5 天）

- 写 `scripts/probe-skills.cjs`（非 harness，探针）：扫本机各候选目录，输出存在性 / skill 数 / 3 个样例 frontmatter。
- 实测 kimi / pi 目录约定（查官方文档 + 本机）。
- 定稿 PRD §5 目录映射表 + §7 IPC 契约（字段名、错误码文案）。
- **产出**：映射表定稿 + 探针输出存档。

#### M1 — 扫描与浏览（1 天）

文件清单：
- `src/main/services/SkillsService.ts`：`scanAll()`（两级扫描：根下一级有 SKILL.md 即 skill，无则下沉一层，对齐 skillkit 兼容分类目录）、`detail()`、`reveal()`。
- `src/shared/channels.ts` + `types.ts`：`SK_` 频道 + `SkillInfo`。
- `src/main/index.ts`：handle 注册 + 校形。
- `src/preload/index.ts` + `index.d.ts`：`window.warp.skills.*`。
- `src/renderer/src/components/SkillsDialog.tsx`：lazy chunk；列表（agent 筛选 + 搜索 + 卡片网格）+ 详情（复用 `components/preview/markdown.ts`，**首版禁图**）。
- `App.tsx`：入口按钮 + `Ctrl+Shift+S` + 命令面板项。
- `scripts/verify-skills.cjs`：沙箱造 3 个 agent 目录 + 假 skill（正常 frontmatter / 中文描述 / 无 frontmatter / 空目录 / 恶意 `../` 链接），断言扫描数、搜索、详情渲染 `.md-body h1`、越界 detail 拒绝。

#### M2 — 卸载与跨 agent 安装（1 天）

- SkillsService 加 `uninstall()` / `installTo()`：目标 `inside(declaredRoot)` 校验；覆盖走 `.bak-<ts>`；conflict 参数 `skip | overwrite`。
- UI：卡片菜单「安装到其他 agent」（多选弹窗）+「卸载」（ConfirmDialog 全路径确认）。
- `config.json` 加 `skillMeta` 字段 + `ConfigStore.migrate` 分支（记录 source / installedAt；扫描对账清孤儿）。
- harness 增补：卸载后目录消失、builtin 拒绝、复制字节一致、skip/overwrite 行为、`.bak` 存在、越界拒绝。

#### M3 — GitHub / zip 安装（1–1.5 天）

- `src/main/lib/extractGuard.ts`：zip / tar.gz 逐条目路径校验 + 安全解压到临时目录。
- `src/main/lib/githubInstall.ts`：URL 解析矩阵（`owner/repo`、`tree/<branch>/<subpath>`、`git@`、`.git` 后缀）、codeload 下载（6s 首字节超时）、在临时目录找 SKILL.md、复制进目标 + 失败回滚。
- 依赖：`adm-zip`（纯 JS）；tar.gz 用系统 `tar`（Windows 10+ 自带 bsdtar，`child_process` 调用，参数数组不拼串）。
- UI：「安装 Skill」页签：URL 输入 → 解析预览 → 选目标 agent → 执行；zip 拖入。
- harness 增补：本地 http 服务给假 tar.gz / zip；zip-slip 条目跳过断言；回滚断言；URL 解析矩阵。
- **注意**：本机到 codeload 的真实连通性留到 M4 人工确认，harness 不依赖外网。

#### M4 — 打磨与打包（0.5 天）

- `verify-skills` 进 `verify:all` 自动扫描清单；`npm run verify:all` 全绿。
- `verify-perf` 首屏预算断言仍过（SkillsDialog 必须 lazy）。
- `CLAUDE.md` 常用命令 + 里程碑节更新；`README.md` 功能列表；PRD 状态改「已实现」。
- 版本 bump（1.4.0）+ `npm run build:win` + `verify-package` 冒烟。
- 人工确认项：真实 GitHub 下载连通性；真实 Claude Code / Codex 识别新装的 skill（装一个假 skill 看 agent 会话里是否被发现）。

### 2.3 验收标准（Definition of Done）

1. `npm run verify:all` 全绿，其中 `verify-skills` ≥ 30 项断言。
2. 首屏 JS ≤ 950KB（SkillsDialog 在独立 chunk）。
3. 安全用例全部有断言：越界拒绝 × 3 处（detail / uninstall / install 目标）、zip-slip 跳过、builtin 不可删。
4. 本机真实环境手工冒烟：扫描出 49+31+100 个 skill、跨 agent 复制一个 skill 后在对应 agent 会话可用、GitHub 装一个真 skill。

### 2.4 决策记录待写项（做完记得进 `decisions.md`）

- 为何不引入 SQLite（文件系统即真相 + 量级小）。
- 为何首版禁 skill 详情图片。
- 为何 tar.gz 走系统 tar 而非引入原生解压库。
- 目录映射表以 skillkit 为基线的取舍（裁剪到 4 agent + 全局仓）。
