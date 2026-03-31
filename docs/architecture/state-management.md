# Claude Code 状态管理

## 概述

Claude Code 采用多层状态管理架构，每层有不同的生命周期、可见范围和持久化策略：

```
┌──────────────────────────────────────────────────────────┐
│  Bootstrap State (bootstrap/state.ts)                    │
│  全局运行时状态 | 进程级生命周期 | 200+ 字段             │
├──────────────────────────────────────────────────────────┤
│  AppState (state/AppState.tsx)                           │
│  React UI 状态 | Zustand-like Store | 响应式更新         │
├──────────────────────────────────────────────────────────┤
│  QueryEngine State (QueryEngine.ts)                      │
│  查询会话状态 | 会话级生命周期 | 跨轮次持久              │
├──────────────────────────────────────────────────────────┤
│  History State (history.ts)                              │
│  命令历史 | 磁盘持久化 | JSONL 格式                      │
├──────────────────────────────────────────────────────────┤
│  Cost Tracking State (cost-tracker.ts)                   │
│  费用跟踪 | 会话级 + 项目级持久化                        │
└──────────────────────────────────────────────────────────┘
```

---

## 1. Bootstrap State (bootstrap/state.ts)

**文件**: `src/bootstrap/state.ts`

Bootstrap State 是整个应用的全局运行时状态，包含 200+ 字段。它是一个纯 TypeScript 模块，不依赖 React，可以被任何模块直接导入。

### 状态类型定义

```typescript
type State = {
  // ===== 项目与路径 =====
  originalCwd: string                    // 原始工作目录
  projectRoot: string                    // 稳定项目根路径 (启动时设定，不变)
  cwd: string                            // 当前工作目录

  // ===== 成本与性能计量 =====
  totalCostUSD: number                   // 会话总费用 (USD)
  totalAPIDuration: number               // API 总耗时
  totalAPIDurationWithoutRetries: number  // 不含重试的 API 耗时
  totalToolDuration: number              // 工具总执行时间
  turnHookDurationMs: number             // 当前轮次 hook 耗时
  turnToolDurationMs: number             // 当前轮次工具耗时
  turnClassifierDurationMs: number       // 当前轮次分类器耗时
  turnToolCount: number                  // 当前轮次工具调用数
  turnHookCount: number                  // 当前轮次 hook 调用数
  turnClassifierCount: number            // 当前轮次分类器调用数

  // ===== 时间与活动追踪 =====
  startTime: number                      // 会话开始时间
  lastInteractionTime: number            // 最后交互时间

  // ===== 代码变更统计 =====
  totalLinesAdded: number                // 添加的代码行数
  totalLinesRemoved: number              // 删除的代码行数

  // ===== 模型与设置 =====
  modelUsage: { [modelName: string]: ModelUsage }  // 按模型的使用量
  mainLoopModelOverride: ModelSetting | undefined   // 运行时模型覆盖
  initialMainLoopModel: ModelSetting                // 初始主循环模型
  modelStrings: ModelStrings | null                 // 模型名称映射
  hasUnknownModelCost: boolean                      // 是否有未知成本模型

  // ===== 会话配置 =====
  isInteractive: boolean                 // 是否交互模式
  kairosActive: boolean                  // Kairos (assistant mode) 是否活跃
  strictToolResultPairing: boolean       // 严格工具结果配对 (HFI 模式)
  sdkAgentProgressSummariesEnabled: boolean
  userMsgOptIn: boolean                  // 用户消息 opt-in
  clientType: string                     // 客户端类型
  sessionSource: string | undefined      // 会话来源

  // ===== 安全与认证 =====
  sessionIngressToken: string | null | undefined
  oauthTokenFromFd: string | null | undefined
  apiKeyFromFd: string | null | undefined
  flagSettingsPath: string | undefined
  flagSettingsInline: Record<string, unknown> | null
  allowedSettingSources: SettingSource[]

  // ===== OpenTelemetry 遥测 =====
  meter: Meter | null
  sessionCounter: AttributedCounter | null
  locCounter: AttributedCounter | null
  prCounter: AttributedCounter | null
  commitCounter: AttributedCounter | null
  costCounter: AttributedCounter | null
  tokenCounter: AttributedCounter | null
  codeEditToolDecisionCounter: AttributedCounter | null
  activeTimeCounter: AttributedCounter | null
  statsStore: { observe(name: string, value: number): void } | null
  loggerProvider: LoggerProvider | null
  eventLogger: ReturnType<typeof logs.getLogger> | null
  meterProvider: MeterProvider | null
  tracerProvider: BasicTracerProvider | null

  // ===== 会话标识 =====
  sessionId: SessionId                   // 会话唯一 ID
  parentSessionId: SessionId | undefined // 父会话 ID (plan mode 链接)

  // ===== Agent 颜色管理 =====
  agentColorMap: Map<string, AgentColorName>
  agentColorIndex: number

  // ===== 调试与诊断 =====
  lastAPIRequest: Omit<BetaMessageStreamParams, 'messages'> | null
  lastAPIRequestMessages: BetaMessageStreamParams['messages'] | null
  lastClassifierRequests: unknown[] | null
  cachedClaudeMdContent: string | null
  inMemoryErrorLog: Array<{ error: string; timestamp: string }>

  // ===== 插件与扩展 =====
  inlinePlugins: Array<string>
  chromeFlagOverride: boolean | undefined
  useCoworkPlugins: boolean

  // ===== 会话控制标志 =====
  sessionBypassPermissionsMode: boolean
  scheduledTasksEnabled: boolean
  sessionCronTasks: SessionCronTask[]
  sessionCreatedTeams: Set<string>
  sessionTrustAccepted: boolean
  sessionPersistenceDisabled: boolean

  // ===== Plan Mode 追踪 =====
  hasExitedPlanMode: boolean
  needsPlanModeExitAttachment: boolean
  needsAutoModeExitAttachment: boolean

  // ===== 技能与缓存 =====
  invokedSkills: Map<string, {
    skillName: string
    skillPath: string
    content: string
    invokedAt: number
    agentId: string | null
  }>
  planSlugCache: Map<string, string>
  systemPromptSectionCache: Map<string, string | null>

  // ===== SDK 配置 =====
  sdkBetas: string[] | undefined
  initJsonSchema: Record<string, unknown> | null
  registeredHooks: Partial<Record<HookEvent, RegisteredHookMatcher[]>> | null

  // ===== 远程与连接 =====
  isRemoteMode: boolean
  directConnectServerUrl: string | undefined
  teleportedSessionInfo: { ... } | null
  sessionProjectDir: string | null

  // ===== 缓存控制 =====
  promptCache1hAllowlist: string[] | null
  promptCache1hEligible: boolean | null
  afkModeHeaderLatched: boolean | null
  fastModeHeaderLatched: boolean | null
  cacheEditingHeaderLatched: boolean | null
  thinkingClearLatched: boolean | null

  // ===== API 追踪 =====
  promptId: string | null
  lastMainRequestId: string | undefined
  lastApiCompletionTimestamp: number | null
  pendingPostCompaction: boolean

  // ===== Channel 配置 =====
  allowedChannels: ChannelEntry[]
  hasDevChannels: boolean
  additionalDirectoriesForClaudeMd: string[]
}
```

### 访问模式

Bootstrap State 通过导出的 getter/setter 函数对进行访问，不直接暴露 state 对象：

```typescript
// 导出示例
export function getSessionId(): SessionId { return state.sessionId }
export function getTotalCostUSD(): number { return state.totalCostUSD }
export function getCwd(): string { return state.cwd }
export function getModelUsage(): { [k: string]: ModelUsage } { return state.modelUsage }

// Setter 示例
export function setOriginalCwd(cwd: string): void { state.originalCwd = cwd }
export function setProjectRoot(root: string): void { state.projectRoot = root }
export function switchSession(id: SessionId): void { state.sessionId = id }
export function addToTotalCostState(cost: number): void { state.totalCostUSD += cost }
```

### 设计原则

文件顶部有明确的警告注释：

```typescript
// DO NOT ADD MORE STATE HERE - BE JUDICIOUS WITH GLOBAL STATE
// ALSO HERE - THINK THRICE BEFORE MODIFYING
```

---

## 2. AppState (state/AppState.tsx)

**文件**: `src/state/AppState.tsx`, `src/state/AppStateStore.ts`, `src/state/store.ts`

AppState 是 React UI 层的状态管理，使用自定义的轻量级 Store 实现（类似 Zustand），通过 React Context 分发到组件树。

### Store 实现

```typescript
// src/state/store.ts - 最小化的响应式 Store
type Listener = () => void
type OnChange<T> = (args: { newState: T; oldState: T }) => void

export type Store<T> = {
  getState: () => T
  setState: (updater: (prev: T) => T) => void
  subscribe: (listener: Listener) => () => void
}

export function createStore<T>(
  initialState: T,
  onChange?: OnChange<T>,
): Store<T> {
  let state = initialState
  const listeners = new Set<Listener>()

  return {
    getState: () => state,
    setState: (updater) => {
      const prev = state
      const next = updater(prev)
      if (Object.is(next, prev)) return    // 引用相等时跳过更新
      state = next
      onChange?.({ newState: next, oldState: prev })
      for (const listener of listeners) listener()
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
```

### AppState 类型

```typescript
// src/state/AppStateStore.ts
export type AppState = DeepImmutable<{
  // ===== 设置 =====
  settings: SettingsJson
  verbose: boolean

  // ===== 模型配置 =====
  mainLoopModel: ModelSetting              // 当前模型
  mainLoopModelForSession: ModelSetting    // 会话级模型设置

  // ===== UI 状态 =====
  statusLineText: string | undefined
  expandedView: 'none' | 'tasks' | 'teammates'
  isBriefOnly: boolean
  showTeammateMessagePreview?: boolean
  selectedIPAgentIndex: number
  coordinatorTaskIndex: number
  viewSelectionMode: 'none' | 'selecting-agent' | 'viewing-agent'
  footerSelection: FooterItem | null       // 'tasks' | 'tmux' | 'bagel' | ...
  spinnerTip?: string

  // ===== 权限 =====
  toolPermissionContext: ToolPermissionContext

  // ===== Agent 配置 =====
  agent: string | undefined
  kairosEnabled: boolean                   // Assistant mode 完全启用

  // ===== 远程状态 =====
  remoteSessionUrl: string | undefined
  remoteSessionWsState?: 'connected' | 'reconnecting'

  // ===== MCP 状态 =====
  mcp: {
    tools: Tool[]
    commands: Command[]
    resources: ServerResource[]
    clients: MCPServerConnection[]
    elicitationRequests: ElicitationRequestEvent[]
  }

  // ===== 插件 =====
  plugins: {
    loaded: LoadedPlugin[]
    errors: PluginError[]
    lastRefreshed: number
  }

  // ===== 任务 =====
  tasks: {
    list: TaskState[]
    lastUpdated: number
  }

  // ===== Agent 注册表 =====
  agentDefinitions: AgentDefinitionsResult
  agentRegistry: Map<AgentId, {
    name: string
    color: AgentColorName
    active: boolean
  }>

  // ===== 对话状态 =====
  messages: Message[]
  isMessageLoading: boolean
  forkPoint: number | null

  // ===== 投机执行 =====
  speculation: SpeculationState

  // ===== 通知 =====
  notifications: Notification[]

  // ===== 权限追踪 =====
  permissionMode: PermissionMode
  denialTracking: DenialTrackingState

  // ===== 功能开关 =====
  fastMode?: { enabled: boolean }
  effortValue?: EffortValue
  advisorModel?: string
  thinkingConfig: ThinkingConfig

  // ===== 文件历史 =====
  fileHistory?: FileHistoryState
  attribution: AttributionState

  // ===== Prompt Suggestion =====
  promptSuggestionEnabled: boolean

  // ===== Session Hooks =====
  sessionHooks?: SessionHooksState

  // ===== Todo =====
  todo?: TodoList
}>
```

### AppState Provider

```typescript
// src/state/AppState.tsx
export const AppStoreContext = React.createContext<AppStateStore | null>(null)

export function AppStateProvider({ children, initialState, onChangeAppState }) {
  const [store] = useState(
    () => createStore(initialState ?? getDefaultAppState(), onChangeAppState)
  )

  // 挂载时检查是否需要禁用 bypass permissions
  useEffect(() => {
    const { toolPermissionContext } = store.getState()
    if (toolPermissionContext.isBypassPermissionsModeAvailable &&
        isBypassPermissionsModeDisabled()) {
      store.setState(prev => ({
        ...prev,
        toolPermissionContext: createDisabledBypassPermissionsContext(prev.toolPermissionContext)
      }))
    }
  }, [])

  // 监听设置变更
  const onSettingsChange = useEffectEvent(
    source => applySettingsChange(source, store.setState)
  )
  useSettingsChange(onSettingsChange)

  return (
    <HasAppStateContext.Provider value={true}>
      <AppStoreContext.Provider value={store}>
        <MailboxProvider>
          <VoiceProvider>
            {children}
          </VoiceProvider>
        </MailboxProvider>
      </AppStoreContext.Provider>
    </HasAppStateContext.Provider>
  )
}
```

### Speculation State

AppState 中的 `SpeculationState` 管理推测执行：

```typescript
export type SpeculationState =
  | { status: 'idle' }
  | {
      status: 'active'
      id: string
      abort: () => void
      startTime: number
      messagesRef: { current: Message[] }        // 可变引用，避免每消息 spread
      writtenPathsRef: { current: Set<string> }  // 写入 overlay 的路径
      boundary: CompletionBoundary | null
      suggestionLength: number
      toolUseCount: number
      isPipelined: boolean
      contextRef: { current: REPLHookContext }
      pipelinedSuggestion?: { ... } | null
    }

export type CompletionBoundary =
  | { type: 'complete'; completedAt: number; outputTokens: number }
  | { type: 'bash'; command: string; completedAt: number }
  | { type: 'edit'; toolName: string; filePath: string; completedAt: number }
  | { type: 'denied_tool'; toolName: string; detail: string; completedAt: number }
```

### onChangeAppState 回调

```typescript
// src/state/onChangeAppState.ts
// 当 AppState 变化时触发的副作用回调
// 用于同步 UI 状态到其他系统
export function onChangeAppState({ newState, oldState }) {
  // 检测各种状态变化并执行副作用
}
```

---

## 3. QueryEngine State (QueryEngine.ts)

**文件**: `src/QueryEngine.ts`

QueryEngine 管理单个会话的查询生命周期状态，在多个 `submitMessage()` 调用之间持久保持。

```typescript
export class QueryEngine {
  // ===== 核心可变状态 =====
  private mutableMessages: Message[]           // 可变消息存储 (跨轮次保持)
  private totalUsage: NonNullableUsage         // 累计 token 使用量
  private readFileState: FileStateCache        // 文件读取状态缓存

  // ===== 权限追踪 =====
  private permissionDenials: SDKPermissionDenial[]  // 权限拒绝记录

  // ===== 技能发现 =====
  private discoveredSkillNames = new Set<string>()  // 本轮发现的技能名
  private loadedNestedMemoryPaths = new Set<string>() // 已加载的嵌套记忆路径

  // ===== 控制 =====
  private abortController: AbortController     // 中止控制器
  private hasHandledOrphanedPermission = false  // 孤儿权限是否已处理

  constructor(config: QueryEngineConfig) {
    this.mutableMessages = config.initialMessages ?? []
    this.abortController = config.abortController ?? createAbortController()
    this.permissionDenials = []
    this.readFileState = config.readFileCache
    this.totalUsage = EMPTY_USAGE
  }
}
```

### QueryEngineConfig

```typescript
export type QueryEngineConfig = {
  cwd: string
  tools: Tools
  commands: Command[]
  mcpClients: MCPServerConnection[]
  agents: AgentDefinition[]
  canUseTool: CanUseToolFn
  getAppState: () => AppState
  setAppState: (f: (prev: AppState) => AppState) => void
  initialMessages?: Message[]
  readFileCache: FileStateCache
  customSystemPrompt?: string
  appendSystemPrompt?: string
  userSpecifiedModel?: string
  fallbackModel?: string
  thinkingConfig?: ThinkingConfig
  maxTurns?: number
  maxBudgetUsd?: number
  taskBudget?: { total: number }
  jsonSchema?: Record<string, unknown>
  verbose?: boolean
  replayUserMessages?: boolean
  handleElicitation?: ToolUseContext['handleElicitation']
  includePartialMessages?: boolean
  setSDKStatus?: (status: SDKStatus) => void
  abortController?: AbortController
  orphanedPermission?: OrphanedPermission
  snipReplay?: (yieldedSystemMsg: Message, store: Message[]) => { ... } | undefined
}
```

### 状态生命周期

```
QueryEngine 创建 (config)
  │
  ├── mutableMessages = []        ← 初始空或从 resume 恢复
  ├── totalUsage = EMPTY_USAGE    ← 初始零使用量
  ├── readFileState = cache       ← 文件状态缓存
  │
  ▼
submitMessage("用户输入")         ← 每次调用是一个新"轮次"
  │
  ├── discoveredSkillNames.clear()  ← 每轮重置
  ├── 构建 system prompt + context
  ├── query() async generator
  │     ├── 流式事件 → mutableMessages.push()
  │     ├── totalUsage 累加
  │     └── readFileState 更新
  │
  ▼
submitMessage("下一个输入")       ← 状态跨轮次保持
  │ mutableMessages 继续增长
  │ totalUsage 继续累加
  │ readFileState 保持缓存
  │
  ▼
会话结束
```

---

## 4. History State (history.ts)

**文件**: `src/history.ts`

History 模块管理命令历史记录，支持跨会话持久化和按项目过滤。

### 数据格式

使用 JSONL (JSON Lines) 格式存储在 `~/.claude/history.jsonl`:

```typescript
type LogEntry = {
  display: string                              // 显示文本
  pastedContents: Record<number, StoredPastedContent>  // 粘贴内容
  timestamp: number                            // 时间戳
  project: string                              // 项目路径
  sessionId?: string                           // 会话 ID
}

type StoredPastedContent = {
  id: number
  type: 'text' | 'image'
  content?: string        // 内联内容 (小型粘贴)
  contentHash?: string    // 外部存储的 hash 引用 (大型粘贴)
  mediaType?: string
  filename?: string
}
```

### Flush 策略

```typescript
const pendingEntries: LogEntry[] = []  // 待写入的条目

// 写入策略:
// 1. 新条目先进入 pendingEntries
// 2. 周期性或退出时 flush 到 history.jsonl
// 3. 使用文件锁防止并发写入冲突

registerCleanup(async () => {
  await flushPendingEntries()  // 进程退出时确保写入
})
```

### 粘贴内容管理

大型粘贴内容使用 hash 引用机制，避免在 JSONL 中存储过多数据：

```typescript
const MAX_PASTED_CONTENT_LENGTH = 1024

// 小型粘贴: 内联存储 (content 字段)
// 大型粘贴: hash 存储 (contentHash 字段 → paste store)

// 存储到 paste store
const hash = await storePastedText(content)
// 从 paste store 检索
const content = await retrievePastedText(hash)
```

### 历史读取

使用 async generator 支持惰性加载和反向读取：

```typescript
// 按项目获取历史，当前会话优先
export async function* getHistory(): AsyncGenerator<HistoryEntry> {
  const currentProject = getProjectRoot()
  const currentSession = getSessionId()
  const otherSessionEntries: LogEntry[] = []

  for await (const entry of makeLogEntryReader()) {
    if (entry.project !== currentProject) continue

    if (entry.sessionId === currentSession) {
      yield await logEntryToHistoryEntry(entry)  // 当前会话立即 yield
    } else {
      otherSessionEntries.push(entry)             // 其他会话延后
    }
  }

  // 当前会话条目全部输出后，再输出其他会话
  for (const entry of otherSessionEntries) {
    yield await logEntryToHistoryEntry(entry)
  }
}

// 带时间戳的历史 (ctrl+r 搜索用)
export async function* getTimestampedHistory(): AsyncGenerator<TimestampedHistoryEntry> {
  // 去重、最新优先、惰性粘贴内容解析
}
```

### 引用系统

```typescript
// 粘贴文本引用: [Pasted text #1 +10 lines]
// 图片引用: [Image #2]

export function formatPastedTextRef(id: number, numLines: number): string {
  return numLines === 0
    ? `[Pasted text #${id}]`
    : `[Pasted text #${id} +${numLines} lines]`
}

// 解析引用
export function parseReferences(input: string): Array<{ id: number; match: string; index: number }> {
  const referencePattern = /\[(Pasted text|Image|\.\.\.Truncated text) #(\d+)(?: \+\d+ lines)?(\.)*\]/g
  // ...
}

// 展开引用为实际内容
export function expandPastedTextRefs(input: string, pastedContents: Record<number, PastedContent>): string {
  // 反向遍历引用，用实际内容替换占位符
}
```

---

## 5. Cost Tracking State (cost-tracker.ts)

**文件**: `src/cost-tracker.ts`

Cost Tracking 管理 API 调用的费用追踪，支持会话级持久化和恢复。

### 存储结构

```typescript
type StoredCostState = {
  totalCostUSD: number                            // 总费用 (USD)
  totalAPIDuration: number                         // API 总耗时
  totalAPIDurationWithoutRetries: number            // 不含重试的耗时
  totalToolDuration: number                         // 工具总耗时
  totalLinesAdded: number                           // 添加行数
  totalLinesRemoved: number                         // 删除行数
  lastDuration: number | undefined                  // 上次持续时间
  modelUsage: { [modelName: string]: ModelUsage }  // 按模型使用量
}

// ModelUsage 结构
type ModelUsage = {
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
  webSearchRequests: number
  costUSD: number
  contextWindow: number
  maxOutputTokens: number
}
```

### 实际数据存储位置

费用状态存储在两层：

1. **运行时**: `bootstrap/state.ts` 中的 `totalCostUSD`, `modelUsage` 等字段
2. **持久化**: 项目配置文件 (`.claude/settings.local.json`) 中的 `lastCost`, `lastModelUsage` 等字段

### 会话持久化

```typescript
// 保存当前会话费用到项目配置
export function saveCurrentSessionCosts(fpsMetrics?: FpsMetrics): void {
  saveCurrentProjectConfig(current => ({
    ...current,
    lastCost: getTotalCostUSD(),
    lastAPIDuration: getTotalAPIDuration(),
    lastAPIDurationWithoutRetries: getTotalAPIDurationWithoutRetries(),
    lastToolDuration: getTotalToolDuration(),
    lastDuration: getTotalDuration(),
    lastLinesAdded: getTotalLinesAdded(),
    lastLinesRemoved: getTotalLinesRemoved(),
    lastTotalInputTokens: getTotalInputTokens(),
    lastTotalOutputTokens: getTotalOutputTokens(),
    lastTotalCacheCreationInputTokens: getTotalCacheCreationInputTokens(),
    lastTotalCacheReadInputTokens: getTotalCacheReadInputTokens(),
    lastTotalWebSearchRequests: getTotalWebSearchRequests(),
    lastFpsAverage: fpsMetrics?.averageFps,
    lastFpsLow1Pct: fpsMetrics?.low1PctFps,
    lastModelUsage: Object.fromEntries(
      Object.entries(getModelUsage()).map(([model, usage]) => [model, {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadInputTokens: usage.cacheReadInputTokens,
        cacheCreationInputTokens: usage.cacheCreationInputTokens,
        webSearchRequests: usage.webSearchRequests,
        costUSD: usage.costUSD,
      }]),
    ),
    lastSessionId: getSessionId(),
  }))
}
```

### 会话恢复

```typescript
// 从项目配置恢复费用状态 (仅匹配同一会话 ID)
export function restoreCostStateForSession(sessionId: string): boolean {
  const data = getStoredSessionCosts(sessionId)
  if (!data) return false
  setCostStateForRestore(data)
  return true
}

// 读取存储的费用 (在覆盖前读取)
export function getStoredSessionCosts(sessionId: string): StoredCostState | undefined {
  const projectConfig = getCurrentProjectConfig()
  // 只在会话 ID 匹配时返回
  if (projectConfig.lastSessionId !== sessionId) return undefined
  return {
    totalCostUSD: projectConfig.lastCost ?? 0,
    totalAPIDuration: projectConfig.lastAPIDuration ?? 0,
    // ...
    modelUsage: projectConfig.lastModelUsage ? /* 加上 contextWindow */ : undefined,
  }
}
```

### 费用计算

```typescript
// 使用 bootstrap/state.ts 中的累加器
export function addToTotalSessionCost(usage: Usage, model: string): void {
  const cost = calculateUSDCost(usage, model)
  addToTotalCostState(cost)

  // 更新按模型的使用量
  const existing = getUsageForModel(model)
  updateModelUsage(model, {
    inputTokens: existing.inputTokens + usage.input_tokens,
    outputTokens: existing.outputTokens + usage.output_tokens,
    // ...
    costUSD: existing.costUSD + cost,
  })

  // 发送遥测计数器
  getCostCounter()?.add(cost)
  getTokenCounter()?.add(usage.input_tokens + usage.output_tokens)
}
```

### 格式化输出

```typescript
// 费用格式化 (大于 $0.50 显示两位小数，否则四位)
function formatCost(cost: number, maxDecimalPlaces: number = 4): string {
  return `$${cost > 0.5
    ? round(cost, 100).toFixed(2)
    : cost.toFixed(maxDecimalPlaces)}`
}

// 按模型聚合显示
function formatModelUsage(): string {
  // 按 canonical name 聚合 (如 claude-3-5-sonnet-20241022 → Sonnet 3.5)
  const usageByShortName: { [shortName: string]: ModelUsage } = {}
  for (const [model, usage] of Object.entries(getModelUsage())) {
    const shortName = getCanonicalName(model)
    // 累加到 shortName
  }
  // 格式化输出每个模型的 token 使用量
}
```

---

## 状态层级交互关系

```
┌─────────────────────────────────────────────────────┐
│  Bootstrap State (进程级)                            │
│  ┌───────────────┐  ┌────────────────┐              │
│  │ sessionId     │  │ totalCostUSD   │              │
│  │ projectRoot   │  │ modelUsage     │              │
│  │ cwd           │  │ totalLines*    │              │
│  └──────┬────────┘  └────────┬───────┘              │
│         │ 读取                │ 写入                 │
│         ▼                    ▼                       │
│  ┌──────────────────────────────────────┐           │
│  │  AppState (React 组件层)              │           │
│  │  - 读取 bootstrap state 初始化       │           │
│  │  - 管理 UI 专属状态                  │           │
│  │  - 通过 Store 分发到组件树           │           │
│  └──────────────┬───────────────────────┘           │
│                 │ 传递 getAppState/setAppState       │
│                 ▼                                    │
│  ┌──────────────────────────────────────┐           │
│  │  QueryEngine (会话层)                 │           │
│  │  - 持有 mutableMessages              │           │
│  │  - 调用 query() 传递 toolUseContext  │           │
│  │  - 累计 totalUsage                   │           │
│  └──────────────┬───────────────────────┘           │
│                 │                                    │
│                 ▼                                    │
│  ┌──────────────────────────────────────┐           │
│  │  query() loop (轮次层)                │           │
│  │  - 管理 State (messages, turnCount)  │           │
│  │  - 驱动压缩、API 调用、工具执行      │           │
│  └──────────────────────────────────────┘           │
│                                                      │
│  ┌──────────────┐  ┌────────────────────┐           │
│  │ History      │  │ Cost Tracker       │           │
│  │ (JSONL 持久) │  │ (项目配置持久)     │           │
│  └──────────────┘  └────────────────────┘           │
└─────────────────────────────────────────────────────┘
```
