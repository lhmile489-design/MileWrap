# Skills 管理 PRD（SK-）

> 状态：草案 v1.0（2026-11-04）
> 作者：米乐 + Claude
> 关联：`docs/PRD.md`（现有功能清单）、`docs/技术设计.md`（§7 IPC 契约、§8 安全模型）
> 参考项目：[robotbird/skillkit](https://github.com/robotbird/skillkit)（MIT，Electron 桌面端，管 20 个 AI 工具的 skill 目录）

## 0. 一句话

在 Mile Warp 里集中管理本机所有 agent（Claude Code、Codex、Kimi、Pi、自定义 agent）的 skills：扫描已装、查看详情（渲染 SKILL.md）、跨 agent 安装 / 卸载 / 复制、从 GitHub / zip 导入。

## 1. 背景

米乐本机实测：`~/.claude/skills` 49 个、`~/.codex/skills` 31 个、`~/.agents/skills`（全局仓）100 个。多 agent 共享 skill 靠手工复制目录，装新 skill 要自己去 GitHub 下载解压，出了问题不知道装到哪去了。

skillkit 验证了三件事：

1. **skill 目录约定是稳定的**：各工具的用户级 skill 目录就是 `~/.<tool>/skills/<name>/SKILL.md`，Cline / Warp / Kimi 共享 `~/.agents/skills`（对齐 vercel-labs/skills CLI）。
2. **SKILL.md frontmatter 够用**：`name` + `description` 两个扁平 key，一个 60 行的无依赖 YAML 解析器就能读全。
3. **文件系统即真相，DB 只是缓存**：skill 内容字段（path/size/mtime/description）每次扫描覆盖写，来源字段（source/installed_at）扫描时保留——不需要引入 SQLite，Mile Warp 的 JSON 配置也能扛（本地 < 200 个 skill）。

Mile Warp 的优势：本身就是「agent 启动器」，skills 管理和会话/工作区天然长在一起——用户在看会话时就能顺手装个 skill。

## 2. 用户与场景

| 角色 | 场景 |
| --- | --- |
| 米乐（唯一用户，重度 agent 使用者） | 「给 Codex 也装上 Claude 里那个 diagnose」→ 跨 agent 复制 |
| | 「这个 skill 是干嘛的来着」→ 详情面板渲染 SKILL.md（复用预览栏的 markdown 渲染管线） |
| | 「GitHub 上看到个 skill」→ 粘 URL 安装到指定 agent |
| | 「这堆里哪些是重复的」→ 同名 skill 跨 agent 对照 |

## 3. 功能清单

优先级：P0 必做 / P1 应做 / P2 可选。编号 SK-n。

| 编号 | 功能 | 优先级 | 说明 |
| --- | --- | --- | --- |
| SK-01 | 扫描本机 agent 的 skill 目录，列出全部已装 skill（名称、描述、所属 agent、大小、修改时间） | P0 | 覆盖 claude / codex / kimi / pi + 全局仓 `~/.agents/skills` + 自定义 agent 的 skill 目录 |
| SK-02 | 按名称 / 描述搜索，按 agent 筛选 | P0 | 复用会话栏搜索的 pinyin 库 |
| SK-03 | 详情面板渲染 SKILL.md（含 frontmatter 剥离），复用 1.3.0 的 marked + sanitizer 管线 | P0 | `components/preview/` 整套直接复用；skill 目录里的相对图片经 `fs:readImage` 有越界校验的路径可走 |
| SK-04 | 卸载 skill（删目录，回收站语义不要求，直接删 + 确认弹窗） | P0 | builtin / 受保护目录不可删（见 §6 安全） |
| SK-05 | 跨 agent 安装：把 A agent 已装的 skill 复制到 B agent | P0 | 复制前同名已存在 → 二选一：跳过 / 覆盖（确认弹窗列明） |
| SK-06 | 从 GitHub URL 安装：解析 `owner/repo[/tree/<branch>/<subpath>]`，下载 tar.gz，定位含 SKILL.md 的目录，装入指定 agent | P1 | skillkit 的 codeload 方案 + 6s 首字节超时 + 失败回滚（先备份后覆盖） |
| SK-07 | 从本地 zip 导入 | P1 | 拖入或选文件，找最浅的含 SKILL.md 的目录 |
| SK-08 | 「打开目录」/「在编辑器中打开」单个 skill | P1 | 复用 `shell.revealPath` / `fs.openInEditor` |
| SK-09 | 同名 skill 跨 agent 对照视图（哪个 agent 有、哪个没有、mtime 是否一致） | P2 | 「给没有的 agent 全装上」一键批量 |
| SK-10 | skill 更新（GitHub 来源重新拉取覆盖） | P2 | 依赖 SK-06 记录 source 元数据 |
| SK-11 | 从 skills.sh 市场浏览安装 | P2 | 需要抓 sitemap + 详情页 JSON-LD，skillkit 有 24h TTL 缓存方案；**网络依赖市场站点，且要考虑 skill 内容审查**——放最后 |

本期不做：skill 内容编辑、项目级 skill 目录（`.claude/skills` 项目内）、agent 运行时热加载联动、账号 / 分享短链（skillkit.net 依赖，本地工具不需要）。

## 4. 用户流程

### 4.1 入口与界面

- 入口：标题栏「Skills」按钮 + `Ctrl+Shift+S` + 命令面板。
- 形态：居中大弹窗 `SkillsDialog.tsx`（对齐 `HistoryDialog` 的按需 lazy chunk 模式，不进首屏包）。
- 布局：左侧 agent 筛选栏（agent 图标 + 已装数量徽章），右侧 skill 网格（卡片：名称 / 一行描述 / agent 徽章组 / 「⋯」菜单）。顶栏搜索框。

### 4.2 核心流程

```
打开 SkillsDialog
  → 主进程 scanAll()（各 agent 目录 + 全局仓，读 SKILL.md frontmatter）
  → 渲染层列表
      ├── 点卡片 → 右侧详情（SKILL.md 渲染 + 元信息 + 打开目录 / 卸载 / 安装到…）
      ├── 搜索 / 筛选
      └── 「⋯」菜单：安装到其他 agent（多选弹窗）/ 卸载 / 打开目录
安装到其他 agent
  → 选目标 agent（已有同名 → 「跳过 / 覆盖 / 全部覆盖」三选）
  → 主进程复制目录 → 重新扫描 → 列表刷新
GitHub 安装
  → 粘 URL → 预览解析结果（repo / 子目录 / 发现的 skill）→ 选 agent → 下载解压装 → 回滚兜底
```

## 5. 数据模型

**不新增数据库**。扫描结果即扫即用（< 200 目录的 readdir + stat + 读 frontmatter，实测 < 100ms），内存态传渲染层；来源元数据（source / installedAt）存进 `config.json` 新字段 `skillMeta`（`Record<`${agent}:${name}`, { source: 'github'|'zip'|'copy'|'manual', installedAt: number, sourceUrl?: string }>`），扫描时对不上的条目清掉（文件系统是真相）。

```ts
export type SkillInfo = {
  agentId: string        // 'claude' | 'codex' | 'kimi' | 'pi' | 'agents'(全局仓) | 自定义 id
  name: string           // frontmatter name，缺省用目录名
  description: string | null
  rel: string            // 相对 skill 根目录的路径（供详情读取，走 workspaceId 式校验的特例，见 §7）
  sizeBytes: number
  mtime: number
  isBuiltin: boolean     // 内置 skill 不可卸载
  source: 'github' | 'zip' | 'copy' | 'manual' | 'builtin'
  installedAt: number | null
}
```

各 agent 的 skill 目录映射（2026-11-04 `scripts/probe-skills.cjs` 本机实测定稿）：

| agentId | 目录 | 实测结果 |
| --- | --- | --- |
| claude | `~/.claude/skills` | 49 个 skill，标准布局 |
| codex | `~/.codex/skills` | 31 个 |
| agents（全局仓） | `~/.agents/skills` | 100 个；**trae / qoder 的 skills 是指向它的符号链接**（实测 `brainstorming -> ~/.agents/skills/brainstorming/`）——扫描要跟随 symlink 并按 realpath 去重 |
| kimi | 无 skills 目录（`~/.kimi-code` 等候选均不存在） | **不列该 agent**（拍板问题 1 按推荐执行） |
| pi | 无 skills 目录（`~/.pi` 等候选均不存在） | **不列该 agent** |
| 本机发现的其他目录 | `.codebuddy/.qoder/.trae/.cursor/.gemini/.windsurf/.agent` 等 25 个 `skills` 目录 | **本期不扫**：Mile Warp 不管理这些 agent；全局仓 symlink 去重后自然覆盖 trae/qoder 的实体内容 |

> 拍板问题 2/3/4 按推荐执行：全局仓独立一行；详情首版禁图；自定义 agent 不扫。
> 具体路径写死进 `services/skills/tools.ts` 常量表，每个 agent 独立 roots 数组；扫描两级深（一级无 SKILL.md 下沉一层，对齐 skillkit）。

## 6. 安全模型（对齐技术设计 §8）

1. **扫描只读**：`scanAll` 只 readdir + stat + readFileSync(SKILL.md)，不执行任何东西。
2. **写操作白名单根**：卸载 / 安装只允许落在「扫描配置里声明的 skill 根目录」内；目标路径 `resolve` 后必须 `inside(declaredRoot, target)`（复用 `FileTreeService` 的 `inside()` 判定），`..` / 盘符 / 绝对路径一律拒绝。
3. **不碰 builtin**：声明为 builtinRoot 的目录（未来兼容）只读；卸载请求打到 builtin 一律拒绝。
4. **删除确认**：卸载必须走 `ConfirmDialog`（含名称与路径）；安装覆盖同名必须显式选择「覆盖」。
5. **下载不受信内容**：GitHub tar.gz / zip 解压时**逐条目校验**（zip-slip / tar 路径穿越）：每个 entry 的目标路径必须落在临时解压目录内，越界条目跳过并记日志；解压后只在临时目录里找 SKILL.md，**确认是合法 skill 布局后才复制进目标**。
6. **GitHub URL 白名单**：只接受 `github.com/owner/repo` 形态（含 `tree/<branch>/<subpath>`、`git@`、裸 `owner/repo`），下载走 `codeload.github.com`，6s 首字节超时。
7. **SKILL.md 渲染复用 1.3.0 的 sanitizer**（marked + DOMParser 白名单），skill 文件是不可信内容，与预览栏同一防线。
8. **IPC 四处同时改**：`shared/channels.ts` 频道 + 主进程 handler（校形）+ preload 白名单 + `index.d.ts`；渲染层只传 `agentId` + `skillName`（或 GitHub URL / zip 的主进程侧 token），不传裸路径。

## 7. IPC 契约（草案，M0 定稿）

| 频道 | 入参 | 出参 / 行为 |
| --- | --- | --- |
| `skills:scan` | `{}` | `{ skills: SkillInfo[], scannedAt: number, errors: {agentId, message}[] }` |
| `skills:detail` | `{ agentId, name }` | `{ filename, body }`（剥了 frontmatter 的 SKILL.md 正文，>1MB 拒） |
| `skills:installTo` | `{ agentId, name, targets: agentId[], onConflict: 'skip'\|'overwrite' }` | `{ installed: agentId[], skipped: agentId[], failed: {agentId, reason}[] }` |
| `skills:uninstall` | `{ agentId, name }` | `{ ok: true }`；builtin / 越界拒绝 |
| `skills:installGithub` | `{ url, targets, onConflict }` | `{ parsed, installed, skipped, failed }`（两步：`skills:parseGithubUrl` 先预览） |
| `skills:installZip` | `{ zipToken, targets, onConflict }` | 主进程 `dialog.showOpenDialog` 选文件返回一次性 token，同上 |
| `skills:reveal` | `{ agentId, name }` | 资源管理器定位 skill 目录 |

主进程新增 `services/SkillsService.ts`（扫描 / 解析 / 安装 / 卸载）+ `lib/extractGuard.ts`（zip / tar 逐条目路径校验）。解压依赖：**优先用 Node 内置**（Node 22 无内置 zip 解压；评估 `adm-zip`（skillkit 同款，纯 JS 无 ABI 风险）+ tar.gz 走 Node 内置 `child_process` 的系统 `tar`（Windows 10+ 自带 bsdtar）→ 零原生依赖）。

## 8. 可行性结论

| 维度 | 评估 |
| --- | --- |
| 技术可行性 | **高**。skillkit 已验证目录约定 / frontmatter 解析 / GitHub 下载三件套；Mile Warp 已有同构的 IPC 校形、ConfirmDialog、markdown 渲染（1.3.0）、大弹窗 lazy chunk 模式（HistoryDialog）。真正的新代码只有 SkillsService（约 300–400 行）+ extractGuard（约 100 行）+ SkillsDialog（约 400 行）。 |
| 安全可行性 | **可控**。写操作限定声明根 + 逐条目解压校验 + 渲染复用 sanitizer；比预览栏多出来的风险面只有「下载解压」一处，方案见 §6.5。 |
| 兼容性风险 | **低**。纯新增模块，不碰现有 SessionService / ConfigStore 结构（config 只加一个可选字段 `skillMeta`，`ConfigStore.migrate` 加显式分支）。 |
| 维护性风险 | **中低**。agent skill 目录路径会随工具版本漂移（skillkit 的 kimi 就经历了全局仓共享变更）→ 路径表集中一处 + 扫描错误逐 agent 上报（某 agent 目录不存在不阻塞其他 agent）。 |
| 工作量 | P0 全部 + P1（GitHub/zip 安装）：**约 3–4 个工作日**（含 harness）。P2 另计。 |
| 结论 | **建议做**。P0 先行（扫描 / 详情 / 卸载 / 跨 agent 复制）即可覆盖 80% 日常需求，P1 的 GitHub / zip 安装是第二波。 |

## 9. 风险与对策

| 风险 | 对策 |
| --- | --- |
| kimi / pi 的 skill 目录约定未实测 | M1 第一步先写探针脚本扫本机，目录映射实测确认后才写常量表 |
| skill 名含特殊字符 / 中文目录名 | `rel` 用目录名原样（不 normalize 成 frontmatter name），IPC 传参与落盘键用同一形态；Windows 中文路径只经 Node `fs`，不进 shell |
| GitHub 网络不通（本机环境） | 6s 首字节超时 + 明确报错文案；skillkit 有直连失败回退公共镜像的先例，P1 实测后决定是否引入 |
| 同名 skill 内容不同导致覆盖丢数据 | 覆盖前把旧目录改名 `<name>.bak-<ts>` 保留一份（对齐项目 `.bak` 恢复惯例） |
| 卸载误删手写 skill | 确认弹窗显示完整路径 + 「该目录将整体删除」文案；`source: 'manual'` 的卡片加强提示 |
| 扫描慢（全局仓 100+ 目录 × dirSize 递归） | dirSize 不进首扫（扫描只 stat 一层），size 按需算或后台补；列表渲染上限 + 「显示其余」 |

## 10. 里程碑

| 里程碑 | 内容 | 验收（harness 断言） |
| --- | --- | --- |
| **M0 探针与契约** | 实测各 agent skill 目录在本机的真实形态；定稿 §7 IPC 契约与目录映射表 | 探针脚本输出各 agent 目录存在性 / skill 数 / 样例 frontmatter；契约评审通过 |
| **M1 扫描与浏览（SK-01/02/03/08）** | SkillsService 扫描 + SkillsDialog 列表 / 搜索 / 详情（复用 markdown 管线）+ 打开目录 | `verify-skills.cjs`：沙箱造 3 个 agent 目录 + 假 skill（含 frontmatter、中文描述、无 frontmatter 目录），断言扫描数、搜索过滤、详情渲染出 `.md-body h1`、无 frontmatter 的目录仍列出（name 用目录名）、越界 detail 拒绝 |
| **M2 卸载与跨 agent 安装（SK-04/05）** | uninstall / installTo + 同名冲突三选 + `.bak` 保留 | harness：卸载后目录消失、builtin 拒绝、复制后目标目录 SKILL.md 字节一致、同名 skip/overwrite 行为、`.bak-<ts>` 存在、越界目标拒绝 |
| **M3 GitHub / zip 安装（SK-06/07）** | parseGithubUrl + codeload 下载 + extractGuard 逐条目校验 + zip 导入 | harness：本地起 http 服务给 tar.gz / zip（不起真 GitHub）；zip-slip 条目被跳过、合法 skill 装入、失败回滚恢复原目录、URL 形态解析矩阵 |
| **M4 打磨与打包** | 版本号 bump、`verify-skills` 进 `verify:all`、CLAUDE.md / README 更新、`build:win` | `verify:all` 全绿 + `verify-package` 冒烟 + 首屏 JS 预算内（SkillsDialog 必须 lazy chunk） |

## 11. 待确认问题

1. **kimi / pi 的 skill 目录**：本机 `~/.kimi-code` 下没看到 `skills/`，Kimi Code CLI 的 skill 目录约定需要实测（或它暂不支持 skill → 直接不列）。
2. **自定义 agent 是否纳入**：命令行工具的 skill 目录约定未知，本期默认不扫，M4 后按需加「手动指定目录」。
3. **`~/.agents/skills` 全局仓的展示方式**：独立一行（推荐，语义就是「跨工具共享仓」）还是折进 kimi？—— 推荐前者。
4. **要不要顺手支持「项目级 skill」**（`<项目>/.claude/skills`）：PRD 里未提，工作量 +30%，默认不做。

---

> 参考资料：`robotbird/skillkit`（MIT）：`tools.ts` 目录映射、`skill-md.ts` frontmatter 解析、`scan.ts` 两级扫描与「文件系统是真相」缓存策略、`installer.ts` codeload 下载 / 回滚、GitHub URL 解析矩阵。本 PRD 的映射表与安全约束以其为基线，按 Mile Warp 的安全模型（§8）与「无原生依赖」约束调整。
