# Claude Code Query Loop 机制

## 概述

Query Loop 是 Claude Code 的核心执行引擎，由 `src/query.ts` 中的 `query()` async generator 函数实现。它协调多轮对话中的消息构建、上下文压缩、API 调用、流式响应处理和工具执行。

```
┌─────────────────────────────────────────────────────────────┐
│                     Query Loop 总览                         │
│                                                             │
│  用户输入 → QueryEngine.submitMessage()                      │
│         → query() async generator                           │
│         → while(true) {                                     │
│              压缩策略 → API 调用 → 流式响应 → 工具执行       │
│              if (无工具调用) break                           │
│              继续循环...                                     │
│           }                                                 │
│         → 返回终止原因                                       │
└─────────────────────────────────────────────────────────────┘
```

---

## QueryParams 结构

```typescript
// src/query.ts
export type QueryParams = {
  messages: Message[]                    // 对话消息历史
  systemPrompt: SystemPrompt            // 系统提示词
  userContext: { [k: string]: string }   // 用户上下文 (CLAUDE.md 等)
  systemContext: { [k: string]: string } // 系统上下文 (git status 等)
  canUseTool: CanUseToolFn              // 工具权限检查函数
  toolUseContext: ToolUseContext         // 工具使用上下文
  fallbackModel?: string                // 后备模型 (主模型失败时)
  querySource: QuerySource              // 查询来源标识
  maxOutputTokensOverride?: number      // 输出 token 上限覆盖
  maxTurns?: number                     // 最大循环轮次
  skipCacheWrite?: boolean              // 跳过缓存写入
  taskBudget?: { total: number }        // API task_budget (output_config)
  deps?: QueryDeps                      // 依赖注入 (测试用)
}
```

---

## 循环状态管理

每次循环迭代共享一个可变状态对象，在 continue 点整体替换：

```typescript
// src/query.ts - 跨迭代的可变状态
type State = {
  messages: Message[]                            // 当前消息列表
  toolUseContext: ToolUseContext                  // 工具执行上下文
  autoCompactTracking: AutoCompactTrackingState   // 自动压缩跟踪
  maxOutputTokensRecoveryCount: number            // max_output_tokens 恢复计数
  hasAttemptedReactiveCompact: boolean            // 是否已尝试 reactive compact
  maxOutputTokensOverride: number | undefined     // 输出 token 上限
  pendingToolUseSummary: Promise<...> | undefined // 待处理的工具使用摘要
  stopHookActive: boolean | undefined             // 停止 hook 是否活跃
  turnCount: number                               // 当前轮次计数
  transition: Continue | undefined                // 上一次迭代的继续原因
}

// 初始状态
let state: State = {
  messages: params.messages,
  toolUseContext: params.toolUseContext,
  maxOutputTokensOverride: params.maxOutputTokensOverride,
  autoCompactTracking: undefined,
  stopHookActive: undefined,
  maxOutputTokensRecoveryCount: 0,
  hasAttemptedReactiveCompact: false,
  turnCount: 1,
  pendingToolUseSummary: undefined,
  transition: undefined,
}
```

---

## 完整处理流程

每次循环迭代的处理流程如下：

```
┌─────────────────────────────────────────────────────────────┐
│                   单次迭代处理流程                           │
│                                                             │
│  1. Skill Discovery Prefetch (技能发现预取)                  │
│     ↓                                                       │
│  2. yield { type: 'stream_request_start' }                  │
│     ↓                                                       │
│  3. Query Tracking 初始化/递增                               │
│     ↓                                                       │
│  4. Tool Result Budget 裁剪                                  │
│     ↓                                                       │
│  5. Snip Compact (条件: HISTORY_SNIP feature)               │
│     ↓                                                       │
│  6. Microcompact (工具结果压缩)                              │
│     ↓                                                       │
│  7. Context Collapse (条件: CONTEXT_COLLAPSE feature)       │
│     ↓                                                       │
│  8. AutoCompact (自动上下文压缩)                             │
│     ↓                                                       │
│  9. Token Budget Check (阻塞限制检查)                        │
│     ↓                                                       │
│  10. API Streaming Call (调用 Claude API)                    │
│      ↓                                                      │
│  11. Stream Processing (流式响应处理)                        │
│      ↓                                                      │
│  12. Tool Execution (工具执行)                               │
│      ↓                                                      │
│  13. 决策: 继续循环 or 终止                                  │
└─────────────────────────────────────────────────────────────┘
```

### 步骤详解

#### 1. Skill Discovery Prefetch

在模型流式输出时并行执行技能发现，避免阻塞主流程：

```typescript
const pendingSkillPrefetch = skillPrefetch?.startSkillDiscoveryPrefetch(
  null,
  messages,
  toolUseContext,
)
```

#### 2-3. 请求开始与 Query Tracking

```typescript
yield { type: 'stream_request_start' }

// 初始化或递增查询链跟踪
const queryTracking = toolUseContext.queryTracking
  ? { chainId: toolUseContext.queryTracking.chainId, depth: depth + 1 }
  : { chainId: deps.uuid(), depth: 0 }
```

#### 4. Tool Result Budget

对聚合工具结果大小施加预算限制，运行在 microcompact 之前：

```typescript
messagesForQuery = await applyToolResultBudget(
  messagesForQuery,
  toolUseContext.contentReplacementState,
  persistReplacements ? records => void recordContentReplacement(records) : undefined,
  exemptToolNames,  // maxResultSizeChars 为 Infinity 的工具
)
```

#### 5-8. 压缩策略链

四种压缩策略按顺序依次应用，每种都可能减少上下文 token 数：

```
Snip → Microcompact → Context Collapse → AutoCompact
```

详见下方"压缩策略"章节。

#### 9. Token Budget 检查

在非 autocompact 场景下检查是否已达到阻塞限制：

```typescript
if (!compactionResult && querySource !== 'compact' && !reactiveCompactEnabled) {
  const { isAtBlockingLimit } = calculateTokenWarningState(
    tokenCountWithEstimation(messagesForQuery) - snipTokensFreed,
    toolUseContext.options.mainLoopModel,
  )
  if (isAtBlockingLimit) {
    yield createAssistantAPIErrorMessage({
      content: PROMPT_TOO_LONG_ERROR_MESSAGE,
      error: 'invalid_request',
    })
    return { reason: 'blocking_limit' }
  }
}
```

#### 10. API 调用

```typescript
for await (const message of deps.callModel({
  messages: prependUserContext(messagesForQuery, userContext),
  systemPrompt: fullSystemPrompt,
  thinkingConfig: toolUseContext.options.thinkingConfig,
  tools: toolUseContext.options.tools,
  signal: toolUseContext.abortController.signal,
  options: {
    model: currentModel,
    fallbackModel,
    fastMode: appState.fastMode,
    querySource,
    agents: toolUseContext.options.agentDefinitions.activeAgents,
    maxOutputTokensOverride,
    effortValue: appState.effortValue,
    advisorModel: appState.advisorModel,
    taskBudget: { total, remaining },
    // ... 更多选项
  },
})) {
  // 流式处理每个消息事件
}
```

#### 11. 流式响应处理

在 API 流式返回过程中：
- 收集 `AssistantMessage` 到 `assistantMessages[]`
- 检测 `tool_use` block 并设置 `needsFollowUp = true`
- 支持 **Streaming Tool Execution**：工具在流式过程中就开始执行
- 处理 fallback 到备用模型的场景
- 处理 tombstone 消息（清理孤儿消息）

```typescript
// StreamingToolExecutor: 在流式过程中并行执行工具
let streamingToolExecutor = useStreamingToolExecution
  ? new StreamingToolExecutor(
      toolUseContext.options.tools,
      canUseTool,
      toolUseContext,
    )
  : null
```

#### 12. 工具执行

```typescript
// 收集工具执行结果
const toolRunResults = await runTools(
  toolUseBlocks,
  canUseTool,
  toolUseContext,
  streamingToolExecutor,
)

// 将工具结果转为消息
for (const result of toolRunResults) {
  toolResults.push(createUserMessage({
    content: [{ type: 'tool_result', tool_use_id: result.id, content: result.output }],
    toolUseResult: result.output,
  }))
  yield result.message  // yield 到调用者
}
```

#### 13. 继续/终止决策

```typescript
if (!needsFollowUp) {
  // 无工具调用 → 检查 stop hooks
  const stopResult = await handleStopHooks(...)
  if (stopResult.shouldContinue) {
    // stop hook 要求继续
    state = { ...state, stopHookActive: true, ... }
    continue
  }
  return { reason: 'end_turn' }
}

// 有工具调用 → 检查 maxTurns 限制
if (maxTurns && turnCount >= maxTurns) {
  return { reason: 'max_turns' }
}

// 继续循环
state = {
  ...state,
  messages: [...messages, ...assistantMessages, ...toolResults],
  turnCount: turnCount + 1,
  transition: { reason: 'tool_use' },
}
```

---

## 压缩策略 (Compaction Strategies)

Claude Code 实现了四种上下文压缩策略，按阶段依次应用，以管理有限的 context window：

### 1. Snip Compact

**Feature Gate**: `HISTORY_SNIP`

最轻量的压缩。通过截断旧的对话历史来释放 token 空间，保留最近的对话上下文。

```typescript
if (feature('HISTORY_SNIP')) {
  const snipResult = snipModule!.snipCompactIfNeeded(messagesForQuery)
  messagesForQuery = snipResult.messages
  snipTokensFreed = snipResult.tokensFreed
  if (snipResult.boundaryMessage) {
    yield snipResult.boundaryMessage   // 向调用者通知 snip 边界
  }
}
```

**特点**:
- 运行在 microcompact 之前
- `snipTokensFreed` 传递给 autocompact 用于阈值计算
- 产生 boundary message 标记截断点

### 2. Microcompact

对工具结果（尤其是大型文件内容）进行压缩。支持缓存感知的 microcompact（`CACHED_MICROCOMPACT` feature）。

```typescript
const microcompactResult = await deps.microcompact(
  messagesForQuery,
  toolUseContext,
  querySource,
)
messagesForQuery = microcompactResult.messages

// 缓存编辑模式下，延迟 boundary message 到 API 响应后
const pendingCacheEdits = feature('CACHED_MICROCOMPACT')
  ? microcompactResult.compactionInfo?.pendingCacheEdits
  : undefined
```

**特点**:
- 压缩工具结果中的重复或冗长内容
- 可与 snip compact 同时运行（非互斥）
- 缓存编辑版本可利用 API 的 `cache_deleted_input_tokens` 优化

### 3. Context Collapse

**Feature Gate**: `CONTEXT_COLLAPSE`

一种基于读时投影（read-time projection）的压缩策略。不修改原始消息数组，而是在发送 API 请求时创建消息视图。

```typescript
if (feature('CONTEXT_COLLAPSE') && contextCollapse) {
  const collapseResult = await contextCollapse.applyCollapsesIfNeeded(
    messagesForQuery,
    toolUseContext,
    querySource,
  )
  messagesForQuery = collapseResult.messages
}
```

**特点**:
- 运行在 autocompact 之前
- 如果 collapse 将 token 降到 autocompact 阈值以下，autocompact 就是 no-op
- 保留细粒度上下文而非单一摘要
- Summary messages 存储在 collapse store 中，不在 REPL 消息数组中
- `projectView()` 在每次入口时重放 commit log
- 支持 `recoverFromOverflow`：在真实 API 413 错误时排空 staged collapses

### 4. AutoCompact

最重量级的压缩策略。使用一个独立的 API 调用来生成对话摘要。

```typescript
const { compactionResult, consecutiveFailures } = await deps.autocompact(
  messagesForQuery,
  toolUseContext,
  {
    systemPrompt,
    userContext,
    systemContext,
    toolUseContext,
    forkContextMessages: messagesForQuery,
  },
  querySource,
  tracking,
  snipTokensFreed,
)

if (compactionResult) {
  const postCompactMessages = buildPostCompactMessages(compactionResult)
  for (const message of postCompactMessages) {
    yield message  // yield 压缩后的消息
  }
  messagesForQuery = postCompactMessages
}
```

**特点**:
- 生成完整的对话摘要替换原始消息
- 跟踪 `AutoCompactTrackingState`（turnId, turnCounter, consecutiveFailures）
- 连续失败时有 circuit breaker 机制
- 压缩后更新 `taskBudgetRemaining`
- 压缩本身产生的 token 使用也会被记录

### 压缩策略对比

| 策略 | 触发条件 | 成本 | 效果 | Feature Gate |
|------|---------|------|------|-------------|
| Snip | token 接近限制 | 零 API 成本 | 截断旧历史 | `HISTORY_SNIP` |
| Microcompact | 工具结果过大 | 零 API 成本 | 压缩工具结果 | 默认开启 |
| Context Collapse | token 接近限制 | 零 API 成本 | 投影视图压缩 | `CONTEXT_COLLAPSE` |
| AutoCompact | token 超过阈值 | 额外 API 调用 | 全对话摘要 | 默认开启 |

---

## Token Budget 跟踪

```typescript
// 独立于 task_budget 的 token budget 系统
const budgetTracker = feature('TOKEN_BUDGET') ? createBudgetTracker() : null

// task_budget.remaining 跟踪 (跨压缩边界)
let taskBudgetRemaining: number | undefined = undefined

// 压缩后更新 remaining
if (params.taskBudget) {
  const preCompactContext = finalContextTokensFromLastResponse(messagesForQuery)
  taskBudgetRemaining = Math.max(
    0,
    (taskBudgetRemaining ?? params.taskBudget.total) - preCompactContext,
  )
}
```

**Budget continuation**: 当模型因 `max_output_tokens` 截断时，最多重试 `MAX_OUTPUT_TOKENS_RECOVERY_LIMIT = 3` 次。

---

## 错误处理与恢复机制

### Fallback 模型

当主模型流式传输失败时，自动切换到 fallback 模型：

```typescript
// 检测 streaming fallback
if (streamingFallbackOccured) {
  // 1. 发送 tombstone 消息清理孤儿消息
  for (const msg of assistantMessages) {
    yield { type: 'tombstone', message: msg }
  }
  // 2. 重置所有累积状态
  assistantMessages.length = 0
  toolResults.length = 0
  toolUseBlocks.length = 0
  needsFollowUp = false
  // 3. 重建 StreamingToolExecutor
  streamingToolExecutor?.discard()
  streamingToolExecutor = new StreamingToolExecutor(tools, canUseTool, toolUseContext)
}
```

### max_output_tokens 恢复

```typescript
// 当响应因 max_output_tokens 被截断时
function isWithheldMaxOutputTokens(msg: Message | StreamEvent | undefined): msg is AssistantMessage {
  return msg?.type === 'assistant' && msg.apiError === 'max_output_tokens'
}

// 恢复逻辑: 最多重试 MAX_OUTPUT_TOKENS_RECOVERY_LIMIT (3) 次
if (isWithheldMaxOutputTokens(lastMessage)) {
  if (maxOutputTokensRecoveryCount < MAX_OUTPUT_TOKENS_RECOVERY_LIMIT) {
    state = {
      ...state,
      maxOutputTokensRecoveryCount: maxOutputTokensRecoveryCount + 1,
      transition: { reason: 'max_output_tokens_recovery' },
    }
    continue  // 继续循环
  }
}
```

### Reactive Compact (响应式压缩)

**Feature Gate**: `REACTIVE_COMPACT`

在收到 `prompt_too_long` API 错误时触发压缩，而非预先阻止：

```typescript
// 当 reactive compact 启用时，不预先阻止
// 而是等待真实的 API 413 错误，然后执行压缩后重试
if (reactiveCompact?.isReactiveCompactEnabled() && isAutoCompactEnabled()) {
  // 跳过预先阻塞检查
}
```

### FallbackTriggeredError

```typescript
try {
  // ... API 调用
} catch (error) {
  if (error instanceof FallbackTriggeredError) {
    // 使用 fallback 模型重试
    attemptWithFallback = true
    currentModel = fallbackModel
  }
}
```

---

## Thinking Rules (思考规则)

query.ts 中记录了关于 thinking blocks 的三条关键规则：

```typescript
/**
 * 思考规则:
 * 1. 包含 thinking 或 redacted_thinking block 的消息
 *    必须属于 max_thinking_length > 0 的查询
 * 2. thinking block 不能是 block 中的最后一个消息
 * 3. thinking blocks 必须在 assistant trajectory 持续期间保留
 *    (单轮，或如果该轮包含 tool_use block 则延续到
 *     后续的 tool_result 和下一个 assistant message)
 */
```

---

## 与 QueryEngine 的关系

`QueryEngine` (`src/QueryEngine.ts`) 是 `query()` 函数的上层封装，管理会话生命周期：

```typescript
export class QueryEngine {
  private mutableMessages: Message[]          // 可变消息存储
  private totalUsage: NonNullableUsage        // 累计使用量
  private readFileState: FileStateCache       // 文件读取缓存
  private discoveredSkillNames = new Set()    // 发现的技能名

  async *submitMessage(prompt, options?): AsyncGenerator<SDKMessage> {
    // 1. 构建 system prompt + context
    const { defaultSystemPrompt, userContext, systemContext } =
      await fetchSystemPromptParts({ tools, mainLoopModel, ... })

    // 2. 处理用户输入 (斜杠命令、权限检查等)
    const processedInput = await processUserInput(prompt, ...)

    // 3. 调用 query() 并 yield 结果
    for await (const event of query({
      messages: this.mutableMessages,
      systemPrompt,
      userContext,
      systemContext,
      canUseTool: wrappedCanUseTool,
      toolUseContext,
      fallbackModel,
      querySource,
      maxTurns,
      taskBudget,
    })) {
      // 4. 处理事件、更新状态、yield 到调用者
      this.mutableMessages.push(event)
      yield normalizedEvent
    }
  }
}
```
