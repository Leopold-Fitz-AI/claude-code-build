# Claude Code 启动流程

## 概述

Claude Code 的启动流程分为四个阶段：Bootstrap → Init → Setup → Main。每个阶段有明确的职责划分，并通过并行预取等优化手段减少启动延迟。

```
┌──────────────┐    ┌──────────────┐    ┌──────────────┐    ┌──────────────────┐
│  Bootstrap   │───►│     Init     │───►│    Setup     │───►│      Main        │
│  (cli.tsx)   │    │  (init.ts)   │    │  (setup.ts)  │    │   (main.tsx)     │
│              │    │              │    │              │    │                  │
│ 快速路径分发  │    │ 配置与环境    │    │ 项目环境     │    │ CLI选项解析      │
│ 零依赖检测   │    │ 初始化       │    │ 准备         │    │ REPL/Print 启动  │
└──────────────┘    └──────────────┘    └──────────────┘    └──────────────────┘
```

---

## 阶段一：Bootstrap (cli.tsx)

**文件**: `src/entrypoints/cli.tsx`

Bootstrap 阶段是整个启动流程的最前端，主要职责是在加载任何重量级模块之前处理快速路径（fast path），以最小化响应延迟。

### 启动前的全局副作用

```typescript
// 修复 corepack 自动 pin 的 bug
process.env.COREPACK_ENABLE_AUTO_PIN = '0'

// 远程容器环境设置堆大小 (16GB 容器)
if (process.env.CLAUDE_CODE_REMOTE === 'true') {
  process.env.NODE_OPTIONS = existing
    ? `${existing} --max-old-space-size=8192`
    : '--max-old-space-size=8192'
}

// 消融基线实验：禁用所有高级功能
if (feature('ABLATION_BASELINE') && process.env.CLAUDE_CODE_ABLATION_BASELINE) {
  // 设置 CLAUDE_CODE_SIMPLE, DISABLE_COMPACT 等环境变量
}
```

### 快速路径分发表

Bootstrap 阶段使用 `process.argv` 直接检查参数，按优先级分发到不同的快速路径。每个路径使用 dynamic `import()` 以避免不必要的模块加载：

| 条件 | 路径 | 说明 |
|------|------|------|
| `--version` / `-v` / `-V` | 直接输出版本号返回 | **零 import**，最快路径 |
| `--dump-system-prompt` | 输出 system prompt 后退出 | 仅加载 config + prompts |
| `--claude-in-chrome-mcp` | 启动 Chrome MCP 服务器 | 独立子系统 |
| `--chrome-native-host` | 启动 Chrome Native Host | 独立子系统 |
| `--computer-use-mcp` | 启动 Computer Use MCP 服务器 | feature(`CHICAGO_MCP`) 门控 |
| `--daemon-worker` | 启动 daemon worker 进程 | feature(`DAEMON`) 门控，无 config/analytics |
| `remote-control` / `rc` / `bridge` | Bridge 模式 | feature(`BRIDGE_MODE`) 门控 |
| `--background` 相关 | 后台会话管理 | feature(`BG_SESSIONS`) 门控 |
| `template` 子命令 | 模板管理 | feature(`TEMPLATES`) 门控 |
| 其他所有情况 | → `main.tsx` | 完整启动路径 |

### 快速路径实现示例

```typescript
async function main(): Promise<void> {
  const args = process.argv.slice(2)

  // 快速路径: --version，零模块加载
  if (args.length === 1 && (args[0] === '--version' || args[0] === '-v')) {
    console.log(`${MACRO.VERSION} (Claude Code)`)
    return
  }

  // 加载 startup profiler (其他所有路径需要)
  const { profileCheckpoint } = await import('../utils/startupProfiler.js')
  profileCheckpoint('cli_entry')

  // 快速路径: --dump-system-prompt (ant-only)
  if (feature('DUMP_SYSTEM_PROMPT') && args[0] === '--dump-system-prompt') {
    const { enableConfigs } = await import('../utils/config.js')
    enableConfigs()
    const { getSystemPrompt } = await import('../constants/prompts.js')
    const prompt = await getSystemPrompt([], model)
    console.log(prompt.join('\n'))
    return
  }

  // 快速路径: --daemon-worker (内部使用，性能敏感)
  if (feature('DAEMON') && args[0] === '--daemon-worker') {
    const { runDaemonWorker } = await import('../daemon/workerRegistry.js')
    await runDaemonWorker(args[1])
    return
  }

  // ... 其他快速路径 ...

  // 默认路径: 加载完整 main.tsx
  const { runMain } = await import('../main.js')
  await runMain()
}
```

---

## 阶段二：Init (init.ts)

**文件**: `src/entrypoints/init.ts`

Init 阶段负责初始化整个应用的基础设施，包括配置系统、安全证书、OAuth、遥测等。通过 `memoize` 确保只执行一次。

### 初始化流程

```typescript
export const init = memoize(async (): Promise<void> => {
  // 1. 启用配置系统
  enableConfigs()

  // 2. 应用安全的环境变量 (信任对话框之前)
  applySafeConfigEnvironmentVariables()

  // 3. TLS 证书配置 (必须在首次 TLS 握手前完成)
  applyExtraCACertsFromConfig()

  // 4. 注册优雅关闭处理
  setupGracefulShutdown()

  // 5. 初始化一方事件日志 (异步，不阻塞)
  void Promise.all([
    import('../services/analytics/firstPartyEventLogger.js'),
    import('../services/analytics/growthbook.js'),
  ]).then(([fp, gb]) => {
    fp.initialize1PEventLogging()
    gb.onGrowthBookRefresh(() => {
      void fp.reinitialize1PEventLoggingIfConfigChanged()
    })
  })

  // 6. 异步填充 OAuth 账号信息 (VSCode 扩展路径需要)
  void populateOAuthAccountInfoIfNeeded()

  // 7. JetBrains IDE 检测 (异步缓存)
  void initJetBrainsDetection()

  // 8. GitHub 仓库检测 (异步缓存)
  void detectCurrentRepository()

  // 9. 远程管理设置初始化
  if (isEligibleForRemoteManagedSettings()) {
    initializeRemoteManagedSettingsLoadingPromise()
  }

  // 10. 策略限制初始化
  if (isPolicyLimitsEligible()) {
    initializePolicyLimitsLoadingPromise()
  }

  // 11. mTLS 配置
  configureGlobalMTLS()

  // 12. 代理配置
  configureGlobalAgents()

  // 13. API 预连接 (TLS 握手预热)
  void preconnectAnthropicApi()

  // 14. Windows shell 检测
  setShellIfWindows()

  // 15. Scratchpad 目录初始化
  if (isScratchpadEnabled()) {
    void ensureScratchpadDir()
  }

  // 16. 记录首次启动时间 (仅第一次安装)
  recordFirstStartTime()
})
```

### Init 阶段的关键特性

**并行初始化**: 多个异步操作通过 `void` 前缀并行触发，不阻塞主流程：
- OAuth 账号信息填充
- JetBrains 检测
- GitHub 仓库检测
- API 预连接
- 事件日志初始化

**分层安全**: `applySafeConfigEnvironmentVariables()` 在信任对话框之前应用安全的配置。完整的 `applyConfigEnvironmentVariables()` 在信任确认后才执行。

### 遥测初始化 (延迟加载)

```typescript
// 遥测相关模块延迟加载以减少启动时间
// OpenTelemetry SDK (~400KB) + gRPC exporters (~700KB) 在实际需要时才加载
export async function initializeTelemetryAfterTrust(): Promise<void> {
  if (telemetryInitialized) return
  telemetryInitialized = true

  const { initializeTelemetry } = await import('../utils/telemetry/instrumentation.js')
  // ... 初始化 meter, tracer, logger providers
}
```

---

## 阶段三：Setup (setup.ts)

**文件**: `src/setup.ts`

Setup 阶段负责准备项目级环境，包括 worktree 管理、hook 配置、消息通道等。

### Setup 流程

```typescript
export async function setup(
  cwd: string,
  permissionMode: PermissionMode,
  allowDangerouslySkipPermissions: boolean,
  worktreeEnabled: boolean,
  worktreeName: string | undefined,
  tmuxEnabled: boolean,
  customSessionId?: string | null,
  worktreePRNumber?: number,
  messagingSocketPath?: string,
): Promise<void> {
```

### 主要步骤

#### 1. Node.js 版本检查
```typescript
const nodeVersion = process.version.match(/^v(\d+)\./)?.[1]
if (!nodeVersion || parseInt(nodeVersion) < 18) {
  console.error(chalk.bold.red('Error: Claude Code requires Node.js version 18 or higher.'))
  process.exit(1)
}
```

#### 2. 会话 ID 设置
```typescript
if (customSessionId) {
  switchSession(asSessionId(customSessionId))
}
```

#### 3. UDS (Unix Domain Socket) 消息服务

用于进程间通信（如 Agent Swarms 中的 teammate 通信）：

```typescript
if (!isBareMode() || messagingSocketPath !== undefined) {
  if (feature('UDS_INBOX')) {
    const m = await import('./utils/udsMessaging.js')
    await m.startUdsMessaging(
      messagingSocketPath ?? m.getDefaultUdsSocketPath(),
      { isExplicit: messagingSocketPath !== undefined },
    )
  }
}
```

#### 4. Worktree 创建

当启用 worktree 模式时，为每个会话创建独立的 Git worktree：

```typescript
if (worktreeEnabled) {
  const worktree = await createWorktreeForSession(
    cwd, worktreeName, worktreePRNumber
  )
  // 可选：创建 tmux session 关联到 worktree
  if (tmuxEnabled) {
    await createTmuxSessionForWorktree(worktree)
  }
}
```

#### 5. Hook 配置快照

捕获当前 hook 配置的快照，用于检测运行时配置变更：

```typescript
captureHooksConfigSnapshot()
```

#### 6. 后台预取与分析

```typescript
// 预取 API key (如果配置了 helper)
void prefetchApiKeyFromApiKeyHelperIfSafe()

// 初始化 session memory
void initSessionMemory()

// 检查发版说明
void checkForReleaseNotes()

// 初始化文件变更监听器
void initializeFileChangedWatcher()
```

#### 7. 版本锁定 (Native Installer)

```typescript
// 锁定当前版本以防止并发更新
void lockCurrentVersion()
```

---

## 阶段四：Main (main.tsx)

**文件**: `src/main.tsx`

Main 阶段是最复杂的阶段，负责 Commander.js CLI program 的创建、所有选项的注册、preAction hook 序列的执行，以及最终的 REPL 启动或 print mode 执行。

### 启动前的副作用（模块顶层）

```typescript
// 这些副作用必须在所有其他 import 之前运行：
profileCheckpoint('main_tsx_entry')     // 1. 标记入口时间
startMdmRawRead()                       // 2. 启动 MDM 子进程 (plutil/reg query)
startKeychainPrefetch()                 // 3. macOS keychain 并行读取 (~65ms 节省)
```

### Commander.js Program 构建

main.tsx 创建一个包含 50+ 选项的 Commander.js program：

```typescript
// 主要选项分类
program
  // 输入选项
  .option('-p, --print <prompt>', '非交互模式')
  .option('--prompt-file <path>', '从文件读取 prompt')
  .option('--resume <sessionId>', '恢复会话')

  // 模型选项
  .option('--model <model>', '指定模型')
  .option('--permission-mode <mode>', '权限模式')

  // 工具选项
  .option('--allowedTools <tools...>', '允许的工具列表')
  .option('--disallowedTools <tools...>', '禁止的工具列表')

  // MCP 选项
  .option('--mcp-config <path>', 'MCP 配置文件路径')

  // 环境选项
  .option('--cwd <dir>', '工作目录')
  .option('--worktree', '启用 worktree 模式')
  .option('--add-dir <dirs...>', '额外工作目录')

  // 输出选项
  .option('--output-format <format>', '输出格式 (text/json/stream-json)')
  .option('--verbose', '详细输出')
  .option('--max-turns <n>', '最大轮次')
  // ... 50+ 选项
```

### preAction Hook 序列

在命令执行前，按顺序执行一系列初始化 hook：

```
preAction 序列:
┌──────────────────────────────────────────────────────────┐
│ 1. MDM Settings       - 加载企业管理配置 (plutil 结果)    │
│ 2. Keychain Prefetch  - 等待 macOS keychain 读取完成      │
│ 3. Init               - init() (配置/TLS/OAuth/关机)      │
│ 4. Settings           - 加载设置、重置缓存                │
│ 5. Analytics Sinks    - 初始化分析数据管道                │
│ 6. Migrations         - 运行配置迁移脚本                  │
│    - migrateFennecToOpus                                 │
│    - migrateLegacyOpusToCurrent                          │
│    - migrateOpusToOpus1m                                 │
│    - migrateSonnet1mToSonnet45                           │
│    - migrateSonnet45ToSonnet46                           │
│    - resetProToOpusDefault                               │
│    - migrateAutoUpdatesToSettings                        │
│    - migrateBypassPermissionsAcceptedToSettings          │
│    - migrateEnableAllProjectMcpServersToSettings         │
│    - migrateReplBridgeEnabledToRemoteControlAtStartup    │
│    - resetAutoModeOptInForDefaultOffer                   │
│ 7. Remote Settings    - 加载远程管理设置                  │
│ 8. Policy Limits      - 加载策略限制                      │
│ 9. GrowthBook         - 初始化 feature flags              │
└──────────────────────────────────────────────────────────┘
```

### REPL 启动路径

```typescript
// 交互模式启动
async function launchRepl(
  root: Root,
  appProps: AppWrapperProps,
  replProps: REPLProps,
  renderAndRun: (root: Root, element: React.ReactNode) => Promise<void>
): Promise<void> {
  const { App } = await import('./components/App.js')     // 懒加载 App 组件
  const { REPL } = await import('./screens/REPL.js')      // 懒加载 REPL 组件
  await renderAndRun(root, <App {...appProps}><REPL {...replProps} /></App>)
}
```

### Print Mode (非交互) 路径

当使用 `-p` flag 时，直接执行查询并输出结果，不启动 REPL 界面：

```
-p "prompt text"
  → 构建 QueryEngine
  → submitMessage(prompt)
  → 流式输出到 stdout
  → 退出
```

### 调试保护

外部构建版本检测并阻止调试器附加：

```typescript
// 检测 --inspect, --debug 等调试标志
if ("external" !== 'ant' && isBeingDebugged()) {
  process.exit(1)
}
```

---

## 启动性能优化策略总结

| 优化策略 | 具体实现 | 节省时间 |
|---------|---------|---------|
| 快速路径 | `--version` 零 import | ~135ms (避免模块加载) |
| 并行预取 | MDM + Keychain 并行 | ~65ms |
| 延迟加载 | OpenTelemetry 延迟 import | ~400KB+ 模块加载 |
| Memoization | `init()` 只执行一次 | 重复调用零开销 |
| Feature Gate | `feature()` 编译时消除 | 减少 bundle 体积 |
| API 预连接 | TLS 握手预热 | 首次 API 调用延迟 |
| 启动 Profiler | `profileCheckpoint()` | 性能瓶颈可观测 |
