# Claude Code 工具系统架构

本文档详细描述 Claude Code 的工具系统核心架构，包括 Tool 接口定义、上下文传递、注册机制、
预设过滤和延迟加载等关键设计。

---

## 1. Tool 接口 (`src/Tool.ts`)

`Tool` 是所有工具的核心类型定义，采用泛型设计：

```typescript
type Tool<
  Input extends AnyObject = AnyObject,
  Output = unknown,
  P extends ToolProgressData = ToolProgressData,
> = {
  readonly name: string
  aliases?: string[]                        // 向后兼容的别名
  searchHint?: string                       // ToolSearch 关键词匹配短语（3-10 词）
  readonly inputSchema: Input               // Zod schema 定义输入
  readonly inputJSONSchema?: ToolInputJSONSchema  // MCP 工具可直接提供 JSON Schema
  outputSchema?: z.ZodType<unknown>         // 输出 schema（可选）
  maxResultSizeChars: number                // 工具结果最大字符数限制

  // 核心方法
  call(args, context, canUseTool, parentMessage, onProgress?): Promise<ToolResult<Output>>
  description(input, options): Promise<string>
  prompt(options): Promise<string>

  // 权限与验证
  validateInput?(input, context): Promise<ValidationResult>
  checkPermissions(input, context): Promise<PermissionResult>
  preparePermissionMatcher?(input): Promise<(pattern: string) => boolean>

  // 工具特性标识
  isReadOnly(input): boolean                // 是否只读操作
  isDestructive?(input): boolean            // 是否不可逆操作（删除/覆盖/发送）
  isConcurrencySafe(input): boolean         // 是否支持并发执行
  isEnabled(): boolean                      // 是否启用
  isOpenWorld?(input): boolean              // 是否开放世界操作
  isMcp?: boolean                           // 是否 MCP 工具
  isLsp?: boolean                           // 是否 LSP 工具

  // 延迟加载
  readonly shouldDefer?: boolean            // 是否延迟加载（需 ToolSearch 发现）
  readonly alwaysLoad?: boolean             // 是否始终加载（不延迟）

  // MCP 信息
  mcpInfo?: { serverName: string; toolName: string }

  // UI 渲染方法
  userFacingName(input): string
  renderToolUseMessage(input, options): React.ReactNode
  renderToolResultMessage?(content, progressMessages, options): React.ReactNode
  renderToolUseProgressMessage?(progressMessages, options): React.ReactNode
  renderToolUseRejectedMessage?(input, options): React.ReactNode
  renderToolUseErrorMessage?(result, options): React.ReactNode
  renderGroupedToolUse?(toolUses, options): React.ReactNode | null

  // 辅助方法
  mapToolResultToToolResultBlockParam(content, toolUseID): ToolResultBlockParam
  toAutoClassifierInput(input): unknown     // auto-mode 安全分类器输入
  getPath?(input): string                   // 获取文件路径（如适用）
  interruptBehavior?(): 'cancel' | 'block'  // 用户中断行为
  isSearchOrReadCommand?(input): { isSearch: boolean; isRead: boolean; isList?: boolean }
  backfillObservableInput?(input): void     // 为 hook 补充派生字段
  extractSearchText?(out): string           // 转录搜索索引文本
}
```

### Tools 集合类型

```typescript
type Tools = readonly Tool[]
```

全系统使用 `Tools` 类型替代 `Tool[]`，便于追踪工具集的组装和传递。

---

## 2. ValidationResult 类型

```typescript
type ValidationResult =
  | { result: true }
  | { result: false; message: string; errorCode: number }
```

`validateInput()` 在 `checkPermissions()` 之前调用，用于验证输入合法性（如文件存在性、
old_string 匹配唯一性等）。返回 `false` 时，错误消息会反馈给模型。

---

## 3. ToolUseContext

`ToolUseContext` 是工具执行时的上下文对象，贯穿整个工具调用生命周期：

```typescript
type ToolUseContext = {
  // 配置选项
  options: {
    commands: Command[]
    debug: boolean
    mainLoopModel: string
    tools: Tools
    verbose: boolean
    thinkingConfig: ThinkingConfig
    mcpClients: MCPServerConnection[]
    mcpResources: Record<string, ServerResource[]>
    isNonInteractiveSession: boolean
    agentDefinitions: AgentDefinitionsResult
    maxBudgetUsd?: number
    customSystemPrompt?: string
    appendSystemPrompt?: string
    querySource?: QuerySource
    refreshTools?: () => Tools
  }

  // 核心控制
  abortController: AbortController          // 终止控制器
  readFileState: FileStateCache             // 文件读取状态缓存
  messages: Message[]                       // 当前消息历史

  // 状态管理
  getAppState(): AppState
  setAppState(f: (prev: AppState) => AppState): void
  setAppStateForTasks?: (f: (prev: AppState) => AppState) => void

  // UI 交互
  setToolJSX?: SetToolJSXFn                 // 设置工具 JSX 渲染
  requestPrompt?: (sourceName, toolInputSummary?) =>
    (request: PromptRequest) => Promise<PromptResponse>
  addNotification?: (notif: Notification) => void
  sendOSNotification?: (opts) => void

  // 限制配置
  fileReadingLimits?: { maxTokens?: number; maxSizeBytes?: number }
  globLimits?: { maxResults?: number }

  // Agent 相关
  agentId?: AgentId                         // 子 agent ID
  agentType?: string                        // 子 agent 类型
  toolUseId?: string
  localDenialTracking?: DenialTrackingState

  // 文件历史与归因
  updateFileHistoryState: (updater) => void
  updateAttributionState: (updater) => void
  contentReplacementState?: ContentReplacementState

  // 其他
  toolDecisions?: Map<string, { source; decision; timestamp }>
  queryTracking?: QueryChainTracking
  renderedSystemPrompt?: SystemPrompt
}
```

### 关键字段说明

| 字段 | 用途 |
|------|------|
| `readFileState` | LRU 缓存，记录文件读取时间戳和内容，用于过时检测 |
| `abortController` | 支持用户中断工具执行 |
| `requestPrompt` | 交互式上下文中向用户请求输入的回调工厂 |
| `contentReplacementState` | 工具结果超限持久化时的内容替换状态 |
| `agentId` | 仅子 agent 设置；主线程使用 `getSessionId()` |

---

## 4. ToolDef 和 buildTool() 模式

### ToolDef 类型

`ToolDef` 是 `Tool` 的偏类型，允许省略具有默认值的方法：

```typescript
type DefaultableToolKeys =
  | 'isEnabled'          // 默认: () => true
  | 'isConcurrencySafe'  // 默认: () => false（假设不安全）
  | 'isReadOnly'         // 默认: () => false（假设写操作）
  | 'isDestructive'      // 默认: () => false
  | 'checkPermissions'   // 默认: { behavior: 'allow', updatedInput }
  | 'toAutoClassifierInput' // 默认: ''（跳过分类器）
  | 'userFacingName'     // 默认: tool.name

type ToolDef<Input, Output, P> =
  Omit<Tool<Input, Output, P>, DefaultableToolKeys>
  & Partial<Pick<Tool<Input, Output, P>, DefaultableToolKeys>>
```

### buildTool() 函数

所有工具定义必须通过 `buildTool()` 构建，确保默认值统一：

```typescript
function buildTool<D extends AnyToolDef>(def: D): BuiltTool<D> {
  return {
    ...TOOL_DEFAULTS,
    userFacingName: () => def.name,
    ...def,
  } as BuiltTool<D>
}

// 默认值（安全优先）
const TOOL_DEFAULTS = {
  isEnabled: () => true,
  isConcurrencySafe: () => false,          // 假设非并发安全
  isReadOnly: () => false,                  // 假设写操作
  isDestructive: () => false,
  checkPermissions: (input) => Promise.resolve({
    behavior: 'allow',
    updatedInput: input,
  }),
  toAutoClassifierInput: () => '',          // 跳过分类器
  userFacingName: () => '',
}
```

### 使用示例

```typescript
export const MyTool = buildTool({
  name: 'MyTool',
  maxResultSizeChars: 100_000,
  get inputSchema() { return myInputSchema() },
  async prompt() { return '...' },
  async call(input, context) { /* ... */ },
  // isEnabled, isConcurrencySafe 等使用默认值
} satisfies ToolDef<InputSchema, Output>)
```

---

## 5. 工具注册机制 (`src/tools.ts`)

### getAllBaseTools()

获取当前环境中所有可用的基础工具列表。这是工具的**唯一数据源**：

```typescript
function getAllBaseTools(): Tools {
  return [
    AgentTool,           // Agent 子代理
    TaskOutputTool,      // 任务输出
    BashTool,            // Shell 命令
    GlobTool, GrepTool,  // 文件搜索（有嵌入式搜索时跳过）
    ExitPlanModeV2Tool,  // 退出计划模式
    FileReadTool,        // 文件读取
    FileEditTool,        // 文件编辑
    FileWriteTool,       // 文件写入
    NotebookEditTool,    // Jupyter 编辑
    WebFetchTool,        // 网页抓取
    TodoWriteTool,       // 待办事项
    WebSearchTool,       // 网页搜索
    TaskStopTool,        // 停止任务
    AskUserQuestionTool, // 询问用户
    SkillTool,           // 技能系统
    EnterPlanModeTool,   // 进入计划模式
    // 条件性工具...
    SendMessageTool,     // 消息发送
    ListMcpResourcesTool, ReadMcpResourceTool,  // MCP 资源
    ToolSearchTool,      // 工具搜索（延迟加载入口）
  ]
}
```

### getTools()

根据权限上下文过滤工具：

```typescript
function getTools(permissionContext: ToolPermissionContext): Tools {
  // 简单模式（CLAUDE_CODE_SIMPLE）: 仅 Bash + Read + Edit
  // REPL 模式: REPL 包装器替代原始工具
  // 正常模式: 全量工具，过滤特殊工具和 deny 规则
}
```

### assembleToolPool()

组合内置工具和 MCP 工具的**单一入口**：

```typescript
function assembleToolPool(
  permissionContext: ToolPermissionContext,
  mcpTools: Tools,
): Tools {
  const builtInTools = getTools(permissionContext)
  // 1. 按 deny 规则过滤 MCP 工具
  // 2. 合并内置工具和 MCP 工具
  // 3. 按名称去重（内置工具优先）
}
```

### filterToolsByDenyRules()

根据权限上下文中的 deny 规则过滤工具：

```typescript
function filterToolsByDenyRules<T>(
  tools: readonly T[],
  permissionContext: ToolPermissionContext,
): T[] {
  return tools.filter(tool => !getDenyRuleForTool(permissionContext, tool))
}
```

支持 MCP server 前缀规则（如 `mcp__server`）在模型看到工具之前就将其移除。

---

## 6. 工具预设和模式过滤

### SIMPLE 模式

设置 `CLAUDE_CODE_SIMPLE=true` 时，仅启用三个核心工具：

- BashTool
- FileReadTool
- FileEditTool

### REPL 模式

启用 REPL 时，原始工具（Bash/Read/Edit 等）被隐藏，由 `REPLTool` 包装在 VM 上下文中提供。

### COORDINATOR 模式

协调器模式下，额外添加 `AgentTool`、`TaskStopTool`、`SendMessageTool`，使协调器能管理多 agent。

---

## 7. Deferred Tools（延迟工具）与 ToolSearch

### 延迟加载概念

工具可标记 `shouldDefer: true`，表示该工具在初始 prompt 中仅发送名称（`defer_loading: true`），
而非完整 schema。模型需通过 `ToolSearch` 工具发现并加载延迟工具的完整定义后才能调用。

```typescript
// 延迟工具示例
export const WebFetchTool = buildTool({
  shouldDefer: true,   // 需要 ToolSearch 加载
  // ...
})

// 始终加载工具
export const FileReadTool = buildTool({
  alwaysLoad: true,    // MCP 工具可设置 _meta['anthropic/alwaysLoad']
  // ...
})
```

### 延迟与始终加载的区别

| 属性 | 行为 |
|------|------|
| `shouldDefer: true` | 初始仅发送名称；需 ToolSearch 发现后调用 |
| `alwaysLoad: true` | 即使启用 ToolSearch，schema 也始终出现在初始 prompt 中 |
| 两者均未设置 | 根据 ToolSearch 启用状态决定 |

---

## 8. MCP 工具集成

MCP (Model Context Protocol) 工具通过以下模式集成：

1. **MCPTool 基础模板** (`src/tools/MCPTool/MCPTool.ts`): 提供通用 MCP 工具包装器
2. **mcpClient.ts 覆盖**: 实际创建时，MCPTool 的 `name`、`description`、`prompt`、`call` 等方法被覆盖
3. **命名约定**: MCP 工具名称格式为 `mcp__<serverName>__<toolName>`
4. **Schema 传递**: `inputJSONSchema` 允许 MCP 工具直接提供 JSON Schema，而非 Zod 转换
5. **权限**: MCPTool 默认 `checkPermissions` 返回 `passthrough`，交由通用权限系统处理
6. **`alwaysLoad` 元数据**: MCP 服务器可通过 `_meta['anthropic/alwaysLoad']` 标记关键工具

```typescript
// MCP 工具基础结构
export const MCPTool = buildTool({
  isMcp: true,
  name: 'mcp',                    // 运行时被覆盖
  maxResultSizeChars: 100_000,
  async checkPermissions(): Promise<PermissionResult> {
    return { behavior: 'passthrough', message: 'MCPTool requires permission.' }
  },
})
```

---

## 9. 工具结果大小限制与持久化

### maxResultSizeChars

每个工具定义 `maxResultSizeChars` 限制结果字符数：

| 工具 | 限制 |
|------|------|
| FileReadTool | `Infinity`（永不持久化，自行限制） |
| GrepTool | 20,000 字符 |
| 其他工具 | 通常 100,000 字符 |

### 持久化机制

当工具结果超过 `maxResultSizeChars` 时：
1. 结果保存到磁盘文件
2. Claude 收到预览内容 + 文件路径，而非完整内容
3. `ContentReplacementState` 跟踪替换状态

`FileReadTool` 设为 `Infinity` 是因为持久化会创建循环 Read -> file -> Read 的读取循环。

---

## 10. ToolResult 类型

```typescript
type ToolResult<T> = {
  data: T                          // 工具输出数据
  newMessages?: Message[]          // 附加消息（注入到对话中）
  contextModifier?: (ctx) => ctx   // 上下文修改器（仅非并发安全工具生效）
  mcpMeta?: {                      // MCP 协议元数据透传
    _meta?: Record<string, unknown>
    structuredContent?: Record<string, unknown>
  }
}
```

---

## 11. 工具查找辅助函数

```typescript
// 按名称或别名匹配工具
function toolMatchesName(tool: { name: string; aliases?: string[] }, name: string): boolean

// 从列表中按名称查找工具
function findToolByName(tools: Tools, name: string): Tool | undefined
```

---

## 12. ToolProgress 系统

工具执行过程中可通过 `onProgress` 回调报告进度：

```typescript
type ToolProgress<P extends ToolProgressData> = {
  toolUseID: string
  data: P
}

// 各工具特定的进度类型
type ToolProgressData =
  | BashProgress
  | AgentToolProgress
  | MCPProgress
  | WebSearchProgress
  | SkillToolProgress
  | TaskOutputProgress
  | REPLToolProgress
```

---

## 相关文件路径

- 工具核心类型: `/src/Tool.ts`
- 工具注册: `/src/tools.ts`
- 工具执行编排: `/src/services/tools/toolOrchestration.ts`
- 工具执行: `/src/services/tools/toolExecution.ts`
- 流式执行器: `/src/services/tools/StreamingToolExecutor.ts`
- 工具 Hook: `/src/services/tools/toolHooks.ts`
- 各工具实现: `/src/tools/<ToolName>/`
