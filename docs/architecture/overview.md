# Claude Code 架构概览

## 项目简介

Claude Code 是一个基于终端的 AI 编码助手，由 Anthropic 开发。它运行在终端环境中，通过与 Claude API 交互来协助开发者完成代码编写、编辑、搜索和分析等任务。

### 技术栈

| 层级 | 技术选型 | 说明 |
|------|---------|------|
| 运行时 | Node.js / Bun | 主运行时环境，支持 Bun 单文件可执行模式 |
| UI 框架 | React + Ink | 终端 UI 渲染框架，使用 React 组件模型 |
| CLI 框架 | Commander.js (`@commander-js/extra-typings`) | 命令行参数解析，提供 50+ 选项 |
| 状态管理 | 自定义 Zustand-like Store | 轻量级响应式状态管理 |
| 构建工具 | Bun bundler (`bun:bundle`) | 支持 feature flag 的 dead code elimination |
| API 通信 | `@anthropic-ai/sdk` | Anthropic 官方 SDK |
| 遥测 | OpenTelemetry | 指标、日志和追踪 |
| 扩展协议 | MCP (Model Context Protocol) | 第三方工具集成协议 |

---

## 核心模块与关系

### 模块依赖图

```
┌─────────────────────────────────────────────────────────────────┐
│                        entrypoints/                             │
│  cli.tsx ──────────────────────────────────────────────────────┐ │
│    │ (快速路径: --version, --dump-system-prompt, --daemon)     │ │
│    ▼                                                           │ │
│  init.ts ──► 配置/TLS/OAuth/关机处理/JetBrains检测/Git检测     │ │
│    │                                                           │ │
│    ▼                                                           │ │
│  setup.ts ──► Worktree创建/Hook快照/UDS消息/后台预取/分析      │ │
└────┼───────────────────────────────────────────────────────────┘ │
     ▼                                                             │
┌────────────────────────────────────────────────────────────────┐ │
│  main.tsx                                                      │ │
│    │ Commander.js program 创建 (50+ 选项)                      │ │
│    │ preAction hook 序列:                                      │ │
│    │   MDM → keychain → init → settings → sinks → migrations  │ │
│    │   → remote settings                                       │ │
│    ├──► 交互模式: launchRepl() → REPL.tsx                      │ │
│    └──► 非交互模式 (-p flag): print mode execution             │ │
└────┼───────────────────────────────────────────────────────────┘ │
     ▼                                                             │
┌────────────────────────────────────────────────────────────────┐ │
│  QueryEngine.ts                                                │ │
│    │ 管理会话生命周期与状态                                     │ │
│    │ submitMessage() → 构建 system prompt + context             │ │
│    ▼                                                           │ │
│  query.ts                                                      │ │
│    │ async generator 函数，协调多轮对话                         │ │
│    │ 消息压缩 → API 调用 → 流式响应 → 工具执行 → 循环           │ │
│    ▼                                                           │ │
│  services/api/claude.ts                                        │ │
│    │ Anthropic API 调用与流式处理                               │ │
│    ▼                                                           │ │
│  tools.ts ──► tools/*                                          │ │
│    各类工具执行 (Bash, FileRead, FileEdit, Grep, etc.)          │ │
└────────────────────────────────────────────────────────────────┘ │
                                                                   │
┌────────────────────────────────────────────────────────────────┐ │
│  状态管理层                                                    │ │
│  ├── bootstrap/state.ts  (全局运行时状态, 200+ 字段)           │ │
│  ├── state/AppState.tsx  (React UI 状态, Zustand-like Store)   │ │
│  ├── cost-tracker.ts     (费用跟踪与持久化)                    │ │
│  └── history.ts          (命令历史, JSONL 格式)                │ │
└────────────────────────────────────────────────────────────────┘ │
                                                                   │
┌────────────────────────────────────────────────────────────────┐ │
│  服务层 (services/)                                            │ │
│  ├── mcp/         MCP 协议客户端与服务器管理                    │ │
│  ├── api/         API 调用、重试、错误处理                      │ │
│  ├── compact/     上下文压缩 (auto/micro/snip/reactive)        │ │
│  ├── analytics/   分析与遥测 (GrowthBook, Statsig)             │ │
│  ├── lsp/         LSP 服务器集成                                │ │
│  └── tools/       工具编排 (StreamingToolExecutor)              │ │
└────────────────────────────────────────────────────────────────┘ │
                                                                   │
┌────────────────────────────────────────────────────────────────┐ │
│  UI 组件层 (components/ + screens/)                            │ │
│  ├── App.tsx              应用根组件                            │ │
│  ├── screens/REPL.tsx     主 REPL 界面                         │ │
│  ├── PromptInput.tsx      输入处理组件                          │ │
│  └── MessageSelector.tsx  消息选择与过滤                        │ │
└────────────────────────────────────────────────────────────────┘ │
```

### 主调用链

```
entrypoints/cli.tsx
  → main.tsx (Commander.js program 构建与选项解析)
    → setup.ts (环境准备)
    → launchRepl() / print mode
      → QueryEngine.submitMessage()
        → query() async generator
          → services/api/claude.ts (API 流式调用)
          → tools.ts → tool.call() (工具执行)
          → 循环直到完成
```

---

## 关键设计模式

### 1. Memoization 性能优化

项目大量使用 `lodash-es/memoize` 来缓存昂贵的计算结果：

```typescript
// src/context.ts - 系统上下文获取被 memoize 缓存
export const getGitStatus = memoize(async (): Promise<string | null> => {
  // git status, branch, log 等并行执行
  const [branch, mainBranch, status, log, userName] = await Promise.all([
    getBranch(),
    getDefaultBranch(),
    execFileNoThrow(gitExe(), ['status', '--short']),
    execFileNoThrow(gitExe(), ['log', '--oneline', '-n', '5']),
    execFileNoThrow(gitExe(), ['config', 'user.name']),
  ])
  // ...
})

// src/entrypoints/init.ts - init 函数只执行一次
export const init = memoize(async (): Promise<void> => {
  enableConfigs()
  applySafeConfigEnvironmentVariables()
  setupGracefulShutdown()
  // ...
})
```

### 2. 懒加载与 Feature Gate (Dead Code Elimination)

使用 `feature()` 宏（来自 `bun:bundle`）实现编译时条件加载。未启用的功能在构建时被完全移除：

```typescript
// src/query.ts - 条件加载压缩模块
const reactiveCompact = feature('REACTIVE_COMPACT')
  ? (require('./services/compact/reactiveCompact.js') as typeof import('./services/compact/reactiveCompact.js'))
  : null

const contextCollapse = feature('CONTEXT_COLLAPSE')
  ? (require('./services/contextCollapse/index.js') as typeof import('./services/contextCollapse/index.js'))
  : null

// src/tools.ts - 条件加载工具
const SleepTool = feature('PROACTIVE') || feature('KAIROS')
  ? require('./tools/SleepTool/SleepTool.js').SleepTool
  : null
```

常用 feature flag 包括：`REACTIVE_COMPACT`, `CONTEXT_COLLAPSE`, `HISTORY_SNIP`, `COORDINATOR_MODE`, `KAIROS`, `DAEMON`, `BRIDGE_MODE`, `UDS_INBOX`, `AGENT_TRIGGERS`, `VOICE_MODE` 等。

### 3. Cleanup Registration (清理注册)

通过 `registerCleanup()` 注册退出时的清理回调，配合 `setupGracefulShutdown()` 确保进程退出时正确清理资源：

```typescript
// src/entrypoints/init.ts
import { registerCleanup } from '../utils/cleanupRegistry.js'
import { setupGracefulShutdown } from '../utils/gracefulShutdown.js'

// 注册清理操作
setupGracefulShutdown()  // 确保退出时 flush 所有数据
```

### 4. Hook-based Composition (基于 Hook 的组合)

遵循 React 模式，使用自定义 Hook 组合 UI 逻辑：

```typescript
// 状态管理 Hook
import { useSettingsChange } from '../hooks/useSettingsChange.js'
import { useCanUseTool } from './hooks/useCanUseTool.js'

// AppStateProvider 中组合多个 Hook
function AppStateProvider({ children, initialState, onChangeAppState }) {
  const [store] = useState(() => createStore(initialState ?? getDefaultAppState(), onChangeAppState))
  const onSettingsChange = useEffectEvent(source => applySettingsChange(source, store.setState))
  useSettingsChange(onSettingsChange)
  // ...
}
```

### 5. AppState Store 模式

使用自定义的轻量级 Store（类似 Zustand），通过 React Context 分发：

```typescript
// src/state/store.ts - 最小化 Store 实现
export type Store<T> = {
  getState: () => T
  setState: (updater: (prev: T) => T) => void
  subscribe: (listener: Listener) => () => void
}

export function createStore<T>(initialState: T, onChange?: OnChange<T>): Store<T> {
  let state = initialState
  const listeners = new Set<Listener>()
  return {
    getState: () => state,
    setState: (updater) => {
      const prev = state
      const next = updater(prev)
      if (Object.is(next, prev)) return   // 引用相等跳过
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

### 6. Async Generator 模式

query loop 使用 `async generator` (`async function*`) 作为核心协调机制，允许调用者通过 `for await...of` 逐步消费流式事件：

```typescript
// src/query.ts
export async function* query(params: QueryParams): AsyncGenerator<
  StreamEvent | RequestStartEvent | Message | TombstoneMessage | ToolUseSummaryMessage,
  Terminal
> {
  // 多轮对话循环
  while (true) {
    yield { type: 'stream_request_start' }
    // ... 消息构建 → API 调用 → 流式响应 → 工具执行
    for await (const message of deps.callModel({ ... })) {
      yield message  // 流式 yield 到调用者
    }
    // 工具执行与结果收集
    if (!needsFollowUp) return { reason: 'end_turn' }
    // 继续循环...
  }
}
```

### 7. 并行预取 (Parallel Prefetching)

启动阶段并行执行多个异步操作以减少延迟：

```typescript
// src/main.tsx - 启动时并行预取
startMdmRawRead()           // MDM 配置子进程
startKeychainPrefetch()     // macOS keychain 读取 (~65ms 节省)

// src/context.ts - Git 信息并行获取
const [branch, mainBranch, status, log, userName] = await Promise.all([
  getBranch(), getDefaultBranch(), ...
])
```

---

## 目录结构概览

```
src/
├── entrypoints/          # 入口点 (cli.tsx, init.ts, mcp.ts, sdk/)
├── bootstrap/            # 引导阶段状态 (state.ts)
├── state/                # UI 状态管理 (AppState, Store)
├── components/           # React/Ink UI 组件
├── screens/              # 页面级组件 (REPL.tsx)
├── tools/                # 所有工具实现 (30+ 工具)
│   ├── BashTool/
│   ├── FileReadTool/
│   ├── FileEditTool/
│   ├── FileWriteTool/
│   ├── GrepTool/
│   ├── GlobTool/
│   ├── AgentTool/
│   ├── WebFetchTool/
│   ├── WebSearchTool/
│   └── ...
├── services/             # 业务服务层
│   ├── api/              # API 调用与错误处理
│   ├── mcp/              # MCP 协议客户端
│   ├── compact/          # 上下文压缩策略
│   ├── analytics/        # 分析与遥测
│   ├── lsp/              # LSP 集成
│   └── tools/            # 工具编排
├── hooks/                # React Hook
├── utils/                # 工具函数
│   ├── model/            # 模型配置与能力
│   ├── permissions/      # 权限系统
│   ├── settings/         # 设置管理 (MDM, remote, local)
│   ├── hooks/            # 非 React Hook (SessionStart, PostSampling)
│   └── ...
├── types/                # TypeScript 类型定义
├── commands/             # 斜杠命令 (/compact, /clear, etc.)
├── skills/               # 技能系统
├── plugins/              # 插件系统
├── migrations/           # 配置迁移脚本
├── query/                # Query loop 辅助模块
│   ├── config.js
│   ├── deps.js
│   ├── transitions.js
│   └── tokenBudget.js
├── main.tsx              # 主程序入口
├── query.ts              # Query loop 核心
├── tools.ts              # 工具注册表
├── context.ts            # 上下文收集 (Git, CLAUDE.md)
├── cost-tracker.ts       # 费用跟踪
├── history.ts            # 命令历史
├── QueryEngine.ts        # 查询引擎 (SDK/headless 路径)
└── Tool.ts               # 工具基类型定义
```
