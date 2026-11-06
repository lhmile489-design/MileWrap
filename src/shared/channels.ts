/** IPC 频道名：主进程与渲染层共用，避免两边写错字符串。契约见技术设计 §7 */
export const CH = {
  appInfo: 'app:info',
  themeGet: 'theme:get',
  themeChanged: 'theme:changed',

  configGet: 'config:get',
  groupCreate: 'group:create',
  groupRename: 'group:rename',
  groupRemove: 'group:remove',
  groupReorder: 'group:reorder',
  groupToggle: 'group:toggle',
  workspaceCreate: 'workspace:create',
  workspaceEdit: 'workspace:edit',
  workspaceRemove: 'workspace:remove',
  workspaceDuplicate: 'workspace:duplicate',
  /** 移到某分组的某个位置；同时承担组内排序（PRD W-08） */
  workspaceMove: 'workspace:move',
  /** 自定义图标：主进程弹文件对话框并处理图片，返回 token + 预览 */
  workspacePickIcon: 'workspace:pickIcon',
  /** 取某个工作区的图标（data URL） */
  workspaceIcon: 'workspace:icon',

  fsListDir: 'fs:listDir',
  fsReveal: 'fs:reveal',
  gitBranch: 'git:branch',
  /** Git 管理（Git管理-PRD §7）：渲染层只传 workspaceId，仓库目录由主进程从配置求；gitEnabled 为 false 时一律拒绝 */
  gitProbe: 'git:probe',
  gitStatus: 'git:status',
  gitStage: 'git:stage',
  gitUnstage: 'git:unstage',
  /** 丢弃两步走：prepare 返回要确认的文件与一次性 token，discard 只收 token */
  gitDiscardPrepare: 'git:discardPrepare',
  gitDiscard: 'git:discard',
  gitDiff: 'git:diff',
  gitCommit: 'git:commit',
  /** G2：分支与远端 */
  gitBranches: 'git:branches',
  gitCheckout: 'git:checkout',
  gitCreateBranch: 'git:createBranch',
  gitFetch: 'git:fetch',
  gitPull: 'git:pull',
  gitPush: 'git:push',
  gitCancel: 'git:cancel',
  /** 主进程推送：远端操作进度 */
  gitProgress: 'git:progress',
  /** G3：历史与提交详情 */
  gitLog: 'git:log',
  gitCommitDetail: 'git:commitDetail',
  gitCommitFileDiff: 'git:commitFileDiff',
  /** 仓库里会执行命令的配置 / 钩子：先查，用户确认后按指纹记住 */
  gitRisk: 'git:risk',
  gitTrust: 'git:trust',
  shellOpenPath: 'shell:openPath',
  shellOpenExternalTerminal: 'shell:openExternalTerminal',

  agentList: 'agent:list',
  agentRedetect: 'agent:redetect',
  /** 设置页「默认 Shell」的可选项 */
  agentShells: 'agent:shells',

  sessionStart: 'session:start',
  sessionOpenShell: 'session:openShell',
  sessionList: 'session:list',
  sessionBuffer: 'session:buffer',
  sessionWrite: 'session:write',
  sessionResize: 'session:resize',
  sessionKill: 'session:kill',
  sessionRestart: 'session:restart',
  sessionClose: 'session:close',
  sessionRename: 'session:rename',
  sessionData: 'session:data',
  sessionExit: 'session:exit',
  sessionChanged: 'session:changed',

  /** 界面布局（宫格、栏宽、栏位显隐），存 window-state.json */
  layoutGet: 'layout:get',
  layoutUpdate: 'layout:update',
  settingsUpdate: 'settings:update',

  /** 一键恢复与续接（技术设计 §5.7 / §5.8） */
  sessionRestoreCandidates: 'session:restoreCandidates',
  sessionRestore: 'session:restore',
  sessionDismissCandidates: 'session:dismissCandidates',
  sessionResumeWorkspace: 'session:resumeWorkspace',
  sessionResumable: 'session:resumable',

  /** 关闭与托盘（技术设计 §5.7） */
  appQuitRequested: 'app:quitRequested',
  appMinimizeToTray: 'app:minimizeToTray',
  appQuitAll: 'app:quitAll',
  traySessionShow: 'tray:showSession',

  dialogPickDirectory: 'dialog:pickDirectory',
  shellOpenUrl: 'shell:openUrl',
  clipboardRead: 'clipboard:read',
  clipboardWrite: 'clipboard:write',

  /** 活动指示与通知（升级建议 2.1 / 2.2 / 2.3） */
  sessionActivity: 'session:activity',
  sessionActivityList: 'session:activityList',
  sessionMarkSeen: 'session:markSeen',

  /** 上次没结束的 agent 进程（升级建议 1.1） */
  appOrphans: 'app:orphans',
  appKillOrphans: 'app:killOrphans',
  appDismissOrphans: 'app:dismissOrphans',
  appOpenLogDir: 'app:openLogDir',

  /** 目录栏与终端里的路径（升级建议 2.4 / 2.6 / 3.7） */
  fsResolve: 'fs:resolve',
  fsOpenInEditor: 'fs:openInEditor',
  fsEditorAvailable: 'fs:editorAvailable',
  fsWatch: 'fs:watch',
  fsChanged: 'fs:changed',
  /** 文件预览（目录栏单击文件）：文本按 UTF-8 读，图片转缩放后的 data URL */
  fsReadText: 'fs:readText',
  fsReadImage: 'fs:readImage',

  /** 自定义 agent（PRD A-03）与布局预设（升级建议 3.1） */
  agentSaveCustom: 'agent:saveCustom',
  agentRemoveCustom: 'agent:removeCustom',
  agentPickCommand: 'agent:pickCommand',
  presetSave: 'preset:save',
  presetRemove: 'preset:remove',

  /** 导出终端内容（升级建议 4.3）：主进程弹保存对话框 */
  dialogSaveText: 'dialog:saveText',

  /** 分组色点（W-13）与配置导入导出（S-04） */
  groupSetColor: 'group:setColor',
  configExport: 'config:export',
  configImport: 'config:import',

  /** 本机 agent 的历史会话（会话管理升级计划）：渲染层只传 historyId，路径不出主进程 */
  historyList: 'history:list',
  historyDetail: 'history:detail',
  historyExport: 'history:export',
  historyReveal: 'history:reveal',
  historyResume: 'history:resume',

  /** Skills 管理（Skills管理-PRD）：渲染层只传 agentId + skillName，路径不出主进程 */
  skillsScan: 'skills:scan',
  skillsDetail: 'skills:detail',
  skillsInstallTo: 'skills:installTo',
  skillsUninstall: 'skills:uninstall',
  skillsReveal: 'skills:reveal',
  skillsParseGithubUrl: 'skills:parseGithubUrl',
  skillsInstallGithub: 'skills:installGithub',
  /** 主进程弹文件对话框选 zip，渲染层拿不到路径 */
  skillsPickZip: 'skills:pickZip',
  skillsInstallZip: 'skills:installZip',

  windowMinimize: 'window:minimize',
  windowMaximize: 'window:maximize',
  windowClose: 'window:close'
} as const

export type Channel = (typeof CH)[keyof typeof CH]
