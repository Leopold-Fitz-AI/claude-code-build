# Analytics 与 Feature Flags 系统

> Claude Code 的事件分析、实验平台和遥测系统。
> 源码路径: `src/services/analytics/`, `src/utils/telemetry/`

---

## 目录

- [总体架构](#总体架构)
- [事件系统 (index.ts)](#事件系统-indexts)
- [事件路由 (sink.ts)](#事件路由-sinkts)
- [GrowthBook 集成 (growthbook.ts)](#growthbook-集成-growthbookts)
- [元数据丰富 (metadata.ts)](#元数据丰富-metadatats)
- [第一方事件日志 (firstPartyEventLogger.ts)](#第一方事件日志-firstpartyeventloggerts)
- [Datadog 集成 (datadog.ts)](#datadog-集成-datadogts)
- [OpenTelemetry 遥测 (instrumentation.ts)](#opentelemetry-遥测-instrumentationts)
- [Sink Killswitch (sinkKillswitch.ts)](#sink-killswitch-sinkkillswitchts)

---

## 总体架构

```
┌─────────────────────────────────────────────────────────────────┐
│                    应用层 (REPL / SDK / 工具)                    │
│                                                                 │
│  logEvent('event_name', { key: value })                        │
│  logEventAsync('event_name', { key: value })                   │
└────────────────────────┬────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│                 index.ts (公共 API)                              │
│  ┌──────────────┐  ┌────────────────────────────────────────┐   │
│  │ 事件队列     │  │ PII 安全标记                            │   │
│  │ (sink 未就绪)│  │ AnalyticsMetadata_I_VERIFIED_THIS_IS_  │   │
│  │              │  │ NOT_CODE_OR_FILEPATHS                   │   │
│  └──────┬───────┘  └────────────────────────────────────────┘   │
│         │                                                       │
│  attachAnalyticsSink(sink) ─── 延迟初始化                       │
└────────────────────────┬────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│                  sink.ts (事件路由)                               │
│                                                                 │
│  ┌──────────────┐    ┌──────────────────┐                       │
│  │ shouldSample │    │ isSinkKilled     │                       │
│  │ Event()      │    │ ('datadog')      │                       │
│  └──────┬───────┘    └──────┬───────────┘                       │
│         │                   │                                   │
│         ▼                   ▼                                   │
│  ┌─────────────────────────────────────┐                        │
│  │        stripProtoFields()           │                        │
│  │  (移除 _PROTO_* PII 字段)           │                        │
│  └──────────────┬──────────────────────┘                        │
│                 │                                               │
│       ┌─────────┴──────────┐                                    │
│       ▼                    ▼                                    │
│  ┌──────────┐      ┌──────────────────┐                         │
│  │ Datadog  │      │ 1P Event Logger  │                         │
│  │ (公开)   │      │ (含 _PROTO_* 字段)│                        │
│  └──────────┘      └──────────────────┘                         │
└─────────────────────────────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│          OpenTelemetry 遥测 (instrumentation.ts)                 │
│                                                                 │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐                      │
│  │ Metrics  │  │ Traces   │  │ Logs     │                      │
│  │ Provider │  │ Provider │  │ Provider │                      │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘                      │
│       │              │              │                           │
│  ┌────┴──────────────┴──────────────┴────┐                      │
│  │       Exporters (动态导入)             │                      │
│  │  gRPC │ HTTP │ Proto │ Prometheus     │                      │
│  └───────────────────────────────────────┘                      │
└─────────────────────────────────────────────────────────────────┘
```

---

## 事件系统 (index.ts)

### 设计原则

- **零依赖**: `index.ts` 没有外部依赖，避免循环导入
- **延迟初始化**: 事件在 sink 就绪前排队
- **PII 安全**: 通过类型系统强制验证数据安全性

### PII 安全标记类型

```typescript
/**
 * 标记类型: 验证分析元数据不包含敏感信息
 * 类型为 `never`，只能通过显式类型断言使用
 *
 * 用法: `myString as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS`
 */
export type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS = never

/**
 * 标记类型: 用于路由到 PII 标记的 proto 列
 * 目标 BigQuery 列具有特权访问控制
 * _PROTO_* 键在非 1P sink 前被 stripProtoFields() 移除
 */
export type AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED = never
```

### 元数据类型

```typescript
// 事件元数据: 只允许 boolean、number、undefined
// 字符串必须通过 PII 安全标记类型转换
type LogEventMetadata = { [key: string]: boolean | number | undefined }
```

### 核心 API

```typescript
/**
 * 同步记录事件
 * 支持基于 'tengu_event_sampling_config' 的采样
 * sink 未就绪时自动排队
 */
export function logEvent(
  eventName: string,
  metadata: LogEventMetadata,
): void

/**
 * 异步记录事件
 * 同样支持采样和排队
 */
export async function logEventAsync(
  eventName: string,
  metadata: LogEventMetadata,
): Promise<void>
```

### Sink 接口

```typescript
export type AnalyticsSink = {
  logEvent: (eventName: string, metadata: LogEventMetadata) => void
  logEventAsync: (eventName: string, metadata: LogEventMetadata) => Promise<void>
}
```

### 延迟初始化流程

```typescript
/**
 * 附加分析 sink。排队事件通过 queueMicrotask 异步排放。
 * 幂等: 如果 sink 已附加，此操作为空操作。
 */
export function attachAnalyticsSink(newSink: AnalyticsSink): void

// 初始化时序:
// 1. 应用启动，各模块调用 logEvent() → 事件排队
// 2. attachAnalyticsSink() 被调用
// 3. 排队事件通过 queueMicrotask 异步排放
// 4. 后续 logEvent() 直接发送到 sink
```

### Proto 字段剥离

```typescript
/**
 * 从发往通用存储的 payload 中移除 _PROTO_* 键
 * 用于:
 *   - sink.ts: Datadog 扇出前 (不接收 PII 标记值)
 *   - firstPartyEventLoggingExporter: 防御性剥离
 *
 * 无 _PROTO_ 键时返回原引用 (零拷贝)
 */
export function stripProtoFields<V>(
  metadata: Record<string, V>,
): Record<string, V>
```

---

## 事件路由 (sink.ts)

### 初始化

```typescript
// 在应用启动时调用:
export function initializeAnalyticsSink(): void
```

### 路由逻辑

```typescript
function logEventImpl(eventName: string, metadata: LogEventMetadata): void {
  // 1. 采样检查
  const sampleResult = shouldSampleEvent(eventName)
  if (sampleResult === 0) return  // 未被选中

  // 2. 附加 sample_rate
  const metadataWithSampleRate = sampleResult !== null
    ? { ...metadata, sample_rate: sampleResult }
    : metadata

  // 3. Datadog 路由 (通用存储 → 剥离 _PROTO_*)
  if (shouldTrackDatadog()) {
    trackDatadogEvent(eventName, stripProtoFields(metadataWithSampleRate))
  }

  // 4. 1P 路由 (含 _PROTO_* 字段)
  logEventTo1P(eventName, metadataWithSampleRate)
}
```

### Datadog 开关

```typescript
// 通过 GrowthBook feature gate 控制:
const DATADOG_GATE_NAME = 'tengu_log_datadog_events'

function shouldTrackDatadog(): boolean {
  if (isSinkKilled('datadog')) return false  // Killswitch 优先
  // 回退到上次 session 的缓存值
  return checkStatsigFeatureGate_CACHED_MAY_BE_STALE(DATADOG_GATE_NAME)
}
```

---

## GrowthBook 集成 (growthbook.ts)

### 用户属性

```typescript
export type GrowthBookUserAttributes = {
  id: string                    // 用户 ID
  sessionId: string             // 会话 ID
  deviceID: string              // 设备 ID
  platform: 'win32' | 'darwin' | 'linux'
  apiBaseUrlHost?: string       // API base URL 主机名
  organizationUUID?: string     // 组织 UUID
  accountUUID?: string          // 账户 UUID
  userType?: string             // 用户类型
  subscriptionType?: string     // 订阅类型
  rateLimitTier?: string        // 速率限制层级
  firstTokenTime?: number       // 首次 token 时间
  email?: string                // 邮箱
  appVersion?: string           // 应用版本
  github?: GitHubActionsMetadata // GitHub Actions 元数据
}
```

### Feature Flag API

```typescript
// 获取 feature flag 值 (发起远程请求):
export function getFeatureValue<T>(
  featureKey: string,
  defaultValue: T,
): T

// 获取缓存的 feature flag 值 (可能过期):
// 适用于热路径 (如 render 循环中的 isAutoMemoryEnabled)
export function getFeatureValue_CACHED_MAY_BE_STALE<T>(
  featureKey: string,
  defaultValue: T,
): T

// 检查 feature gate (缓存):
export function checkStatsigFeatureGate_CACHED_MAY_BE_STALE(
  gateName: string,
): boolean
```

### 实验参与记录

```typescript
// 存储实验数据用于后续 exposure 记录:
type StoredExperimentData = {
  experimentId: string
  variationId: number
  inExperiment?: boolean
  hashAttribute?: string
  hashValue?: string
}

// 按 feature 键存储:
const experimentDataByFeature = new Map<string, StoredExperimentData>()

// Exposure 去重: 每个 session 中每个 feature 只记录一次
const loggedExposures = new Set<string>()
```

### Remote Eval 缓存

```typescript
// SDK 不可靠地处理 remoteEval 响应，使用本地缓存:
const remoteEvalFeatureValues = new Map<string, unknown>()
```

### 刷新监听

```typescript
// 当 GrowthBook feature 值刷新时通知 (初始化或定期刷新):
type GrowthBookRefreshListener = () => void | Promise<void>

// 用于构建时烘焙 feature 值的系统:
// 例如 firstPartyEventLogger 在构造时读取 tengu_1p_event_batch_config
// 需要在配置变化时重建
const refreshed = createSignal()
```

### 客户端生命周期

```typescript
// 初始化:
// 1. 创建 GrowthBook 客户端
// 2. 设置用户属性
// 3. 加载 feature 定义
// 4. 注册 beforeExit/exit handler 确保数据持久化

// 重新初始化 (认证变化后):
let reinitializingPromise: Promise<unknown> | null = null
// 安全检查在重新初始化期间等待完成

// 重置:
// resetGrowthBook() 不清除 refreshed 监听器
// 监听器在 init.ts 中注册一次，必须在认证变化重置后存活
```

### 动态配置

```typescript
// getDynamicConfig_BLOCKS_ON_INIT(): 阻塞直到初始化完成
// 用于需要精确值的场景

// getFeatureValue_CACHED_MAY_BE_STALE(): 非阻塞
// 用于热路径，接受过期值
```

---

## 元数据丰富 (metadata.ts)

### 工具名称脱敏

```typescript
/**
 * MCP 工具名格式: mcp__<server>__<tool>
 * 可能泄露用户服务器配置 (PII-medium)
 * 内置工具名 (Bash, Read, Write 等) 安全记录
 */
export function sanitizeToolNameForAnalytics(
  toolName: string,
): AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS {
  if (toolName.startsWith('mcp__')) {
    return 'mcp_tool' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
  }
  return toolName as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
}
```

### 环境元数据

```typescript
// 收集的元数据包括:
// - env: 运行环境信息
// - getHostPlatformForAnalytics(): 主机平台
// - getSessionId(): 会话 ID
// - getIsInteractive(): 是否交互式
// - getClientType(): 客户端类型
// - getParentSessionId(): 父会话 ID
// - isClaudeAISubscriber(): 是否 ClaudeAI 订阅者
// - getSubscriptionType(): 订阅类型
// - getRepoRemoteHash(): 仓库远程 hash
// - getWslVersion(): WSL 版本
// - getLinuxDistroInfo(): Linux 发行版信息
// - detectVcs(): 版本控制系统检测
// - getModelBetas(): 模型 beta 标识
// - getMainLoopModel(): 主循环模型

// Teammate 元数据 (feature 受控):
// - isTeammate(): 是否为 teammate
// - getTeamName(): 团队名称
// - getAgentId(): agent ID
// - getTeammateParentSessionId(): teammate 父会话 ID
```

---

## 第一方事件日志 (firstPartyEventLogger.ts)

### 事件采样

```typescript
// 基于 'tengu_event_sampling_config' dynamic config:
export function shouldSampleEvent(eventName: string): number | null
// 返回值:
//   null → 不采样 (全量记录)
//   0 → 被过滤 (不记录)
//   N → 被采样 (记录，附加 sample_rate=N)
```

### 1P 事件记录

```typescript
// 记录事件到第一方后端:
export function logEventTo1P(
  eventName: string,
  metadata: LogEventMetadata,
): void

// 1P 接收完整 payload (包含 _PROTO_* 字段)
// _PROTO_* 键被解构并路由到 proto 字段
```

### 1P Event Logging 开关

```typescript
export function is1PEventLoggingEnabled(): boolean
```

### GrowthBook Experiment Exposure 记录

```typescript
// 将 GrowthBook 实验 exposure 记录到 1P:
export function logGrowthBookExperimentTo1P(
  experimentId: string,
  variationId: number,
  // ...
): void
```

---

## Datadog 集成 (datadog.ts)

```typescript
// 发送事件到 Datadog:
export async function trackDatadogEvent(
  eventName: string,
  metadata: Record<string, boolean | number | undefined>,
): Promise<void>

// 注意:
// - Datadog 是通用存储后端
// - _PROTO_* 字段在发送前被 stripProtoFields() 移除
// - 受 GrowthBook feature gate 'tengu_log_datadog_events' 控制
// - 受 killswitch 'datadog' 控制
```

---

## OpenTelemetry 遥测 (instrumentation.ts)

### 架构

```
┌────────────────────────────────────────┐
│         OpenTelemetry SDK              │
├────────────────────────────────────────┤
│                                        │
│  ┌─────────────┐  ┌─────────────┐     │
│  │MeterProvider │  │TracerProvider│     │
│  │(Metrics)     │  │(Traces)     │     │
│  └──────┬──────┘  └──────┬──────┘     │
│         │                │             │
│  ┌──────┴──────┐  ┌──────┴──────┐     │
│  │Periodic     │  │Batch        │     │
│  │MetricReader │  │SpanProcessor│     │
│  └──────┬──────┘  └──────┬──────┘     │
│         │                │             │
│  ┌──────┴──────┐  ┌──────┴──────┐     │
│  │Exporter     │  │Exporter     │     │
│  └─────────────┘  └─────────────┘     │
│                                        │
│  ┌─────────────┐                       │
│  │LoggerProvider│                      │
│  │(Logs)       │                       │
│  └──────┬──────┘                       │
│         │                              │
│  ┌──────┴──────────┐                   │
│  │BatchLogRecord   │                   │
│  │Processor        │                   │
│  └──────┬──────────┘                   │
│         │                              │
│  ┌──────┴──────┐                       │
│  │Exporter     │                       │
│  └─────────────┘                       │
└────────────────────────────────────────┘
```

### Resource 属性

```typescript
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
  SEMRESATTRS_HOST_ARCH,
} from '@opentelemetry/semantic-conventions'

// Resource 检测器:
import { envDetector, hostDetector, osDetector } from '@opentelemetry/resources'
```

### Provider 设置

```typescript
// Metrics Provider:
const meterProvider = new MeterProvider({
  readers: [new PeriodicExportingMetricReader({
    exporter: metricExporter,
    exportIntervalMillis: DEFAULT_METRICS_EXPORT_INTERVAL_MS,  // 60000ms
  })],
})

// Tracer Provider:
const tracerProvider = new BasicTracerProvider({
  spanProcessors: [new BatchSpanProcessor(spanExporter)],
})

// Logger Provider:
const loggerProvider = new LoggerProvider({
  processors: [new BatchLogRecordProcessor(logExporter, {
    exportIntervalMillis: DEFAULT_LOGS_EXPORT_INTERVAL_MS,  // 5000ms
  })],
})
```

### Exporter 动态导入

```typescript
// OTLP/Prometheus exporters 在协议选择时动态导入
// 避免加载全部 6 种 exporter (~1.2MB)

// 支持的 exporter:
// - gRPC
// - HTTP (OTLP/HTTP)
// - Proto
// - Prometheus
// - Console (调试用)
// - BigQuery (自定义)
```

### 默认导出间隔

```typescript
const DEFAULT_METRICS_EXPORT_INTERVAL_MS = 60000   // 1 分钟
const DEFAULT_LOGS_EXPORT_INTERVAL_MS = 5000        // 5 秒
const DEFAULT_TRACES_EXPORT_INTERVAL_MS = 5000      // 5 秒
```

### Provider 全局注册

```typescript
// 通过 bootstrap/state.ts 的全局 setter/getter:
import {
  getLoggerProvider, getMeterProvider, getTracerProvider,
  setEventLogger, setLoggerProvider, setMeterProvider, setTracerProvider,
} from 'src/bootstrap/state.js'
```

### 代理支持

```typescript
import { HttpsProxyAgent } from 'https-proxy-agent'
import { getProxyUrl, shouldBypassProxy } from '../proxy.js'
// OTLP exporter 支持通过 HTTPS 代理发送遥测数据
```

### CA 证书 & mTLS

```typescript
import { getCACertificates } from '../caCerts.js'
import { getMTLSConfig } from '../mtls.js'
// 支持自定义 CA 证书和双向 TLS
```

### Session Tracing

```typescript
// Beta 功能: 增强的 session tracing
import { isBetaTracingEnabled } from './betaSessionTracing.js'
import { isEnhancedTelemetryEnabled } from './sessionTracing.js'

// LLM Request Span:
import {
  startLLMRequestSpan,
  endLLMRequestSpan,
} from './sessionTracing.js'
```

### Perfetto Tracing

```typescript
// 本地性能分析:
import { initializePerfettoTracing } from './perfettoTracing.js'
```

### 超时处理

```typescript
class TelemetryTimeoutError extends Error {}

// 遥测操作有超时保护，防止阻塞应用退出
function telemetryTimeout(ms: number, message: string): Promise<never>
```

---

## Sink Killswitch (sinkKillswitch.ts)

```typescript
// 紧急关闭特定 sink 的能力:
export function isSinkKilled(sinkName: 'datadog' | '1p'): boolean

// 通过 GrowthBook 动态配置控制
// 用于在 sink 出问题时快速关闭，避免影响用户体验
```

---

## 配置参考 (config.ts)

```typescript
// Analytics 配置相关
// 可通过 GrowthBook dynamic config 动态调整:
// - tengu_event_sampling_config: 事件采样配置
// - tengu_log_datadog_events: Datadog 开关
// - tengu_1p_event_batch_config: 1P 批处理配置
```

---

## 数据流总结

```
应用层事件
    │
    ▼
index.ts (排队/直接发送)
    │
    ▼
sink.ts (采样 + 路由)
    │
    ├──→ Datadog (stripProtoFields, gate 控制)
    │
    └──→ 1P Event Logger (含 _PROTO_* 字段)
              │
              ├──→ OpenTelemetry Logs Exporter
              │
              └──→ Proto 字段提升到 BigQuery 特权列

GrowthBook (独立)
    │
    ├──→ Feature Flags (targeting by 用户属性)
    ├──→ Experiment Exposure 记录到 1P
    └──→ 动态配置 (采样率, killswitch 等)

OpenTelemetry (独立)
    │
    ├──→ Metrics (周期性导出, 60s)
    ├──→ Traces (批量导出, 5s)
    └──→ Logs (批量导出, 5s)
```
