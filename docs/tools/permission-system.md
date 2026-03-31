# Claude Code 权限系统详解

本文档全面描述 Claude Code 的权限系统，包括权限模式、规则体系、检查流程、
分类器机制和持久化方案。

---

## 1. 权限模式 (Permission Modes)

### 模式定义 (`src/types/permissions.ts`)

```typescript
// 外部可见模式（settings.json、CLI --permission-mode）
const EXTERNAL_PERMISSION_MODES = [
  'acceptEdits',        // 自动接受文件编辑，其他操作仍需确认
  'bypassPermissions',  // 跳过所有权限检查（危险）
  'default',            // 默认模式，所有写操作需确认
  'dontAsk',            // 不询问，拒绝未明确允许的操作
  'plan',               // 计划模式，仅允许只读操作
] as const

type ExternalPermissionMode = (typeof EXTERNAL_PERMISSION_MODES)[number]

// 内部模式（包含 ant-only 模式）
type InternalPermissionMode = ExternalPermissionMode | 'auto' | 'bubble'

type PermissionMode = InternalPermissionMode
```

### 模式行为对比

| 模式 | 读操作 | 写操作 | 网络操作 | Shell 命令 |
|------|--------|--------|----------|-----------|
| `default` | 允许 | 询问 | 询问 | 询问 |
| `acceptEdits` | 允许 | 自动允许 | 询问 | 询问 |
| `bypassPermissions` | 允许 | 允许 | 允许 | 允许 |
| `dontAsk` | 允许 | 拒绝(无规则) | 拒绝(无规则) | 拒绝(无规则) |
| `plan` | 允许 | 拒绝 | 拒绝 | 仅只读命令 |
| `auto` (ant-only) | 允许 | 分类器评估 | 分类器评估 | 分类器评估 |
| `bubble` (ant-only) | 允许 | 向上冒泡 | 向上冒泡 | 向上冒泡 |

---

## 2. 权限规则 (Permission Rules)

### 规则结构

```typescript
// 规则来源
type PermissionRuleSource =
  | 'userSettings'       // ~/.claude/settings.json
  | 'projectSettings'    // .claude/settings.json
  | 'localSettings'      // .claude/settings.local.json
  | 'flagSettings'       // feature flag
  | 'policySettings'     // 企业策略
  | 'cliArg'             // 命令行参数
  | 'command'            // 命令系统
  | 'session'            // 会话内

// 规则值
type PermissionRuleValue = {
  toolName: string        // 工具名称（如 "Bash", "Edit", "WebFetch"）
  ruleContent?: string    // 可选的内容匹配模式
}

// 完整规则
type PermissionRule = {
  source: PermissionRuleSource
  ruleBehavior: PermissionBehavior      // 'allow' | 'deny' | 'ask'
  ruleValue: PermissionRuleValue
}
```

### 规则示例

```json
{
  "permissions": {
    "allow": [
      "Bash(git *)",
      "Bash(npm test)",
      "Edit",
      "WebFetch(domain:docs.python.org)"
    ],
    "deny": [
      "Bash(rm -rf *)",
      "Bash(curl:*)",
      "mcp__untrusted_server"
    ]
  }
}
```

---

## 3. ToolPermissionContext

权限检查的完整上下文，使用 `DeepImmutable` 确保不可变：

```typescript
type ToolPermissionContext = DeepImmutable<{
  mode: PermissionMode

  // 额外工作目录
  additionalWorkingDirectories: Map<string, AdditionalWorkingDirectory>

  // 三种行为的规则集（按来源分组）
  alwaysAllowRules: ToolPermissionRulesBySource
  alwaysDenyRules: ToolPermissionRulesBySource
  alwaysAskRules: ToolPermissionRulesBySource

  // 权限模式可用性
  isBypassPermissionsModeAvailable: boolean
  isAutoModeAvailable?: boolean

  // 被剥离的危险规则（安全审计）
  strippedDangerousRules?: ToolPermissionRulesBySource

  // 非交互行为
  shouldAvoidPermissionPrompts?: boolean     // 后台 agent 自动拒绝权限提示
  awaitAutomatedChecksBeforeDialog?: boolean // coordinator worker 等待自动检查

  // 计划模式之前的权限模式（用于恢复）
  prePlanMode?: PermissionMode
}>
```

### ToolPermissionRulesBySource 类型

```typescript
type ToolPermissionRulesBySource = {
  [T in PermissionRuleSource]?: string[]
  // 例如:
  // userSettings: ["Bash(git *)", "Edit"]
  // projectSettings: ["Bash(npm test)"]
}
```

### 默认空上下文

```typescript
const getEmptyToolPermissionContext: () => ToolPermissionContext = () => ({
  mode: 'default',
  additionalWorkingDirectories: new Map(),
  alwaysAllowRules: {},
  alwaysDenyRules: {},
  alwaysAskRules: {},
  isBypassPermissionsModeAvailable: false,
})
```

---

## 4. PermissionResult 类型

权限检查的返回结果是一个 discriminated union：

```typescript
// 允许执行
type PermissionAllowDecision<Input> = {
  behavior: 'allow'
  updatedInput?: Input          // 可选的修改后输入
  userModified?: boolean        // 用户是否修改了输入
  decisionReason?: PermissionDecisionReason
  toolUseID?: string
  acceptFeedback?: string       // 用户接受时的反馈
  contentBlocks?: ContentBlockParam[]
}

// 需要询问用户
type PermissionAskDecision<Input> = {
  behavior: 'ask'
  message: string               // 展示给用户的消息
  updatedInput?: Input
  decisionReason?: PermissionDecisionReason
  suggestions?: PermissionUpdate[]    // 建议的权限规则
  blockedPath?: string
  metadata?: PermissionMetadata
  isBashSecurityCheckForMisparsing?: boolean
  pendingClassifierCheck?: PendingClassifierCheck  // 异步分类器检查
  contentBlocks?: ContentBlockParam[]
}

// 拒绝执行
type PermissionDenyDecision = {
  behavior: 'deny'
  message: string
  decisionReason: PermissionDecisionReason
  toolUseID?: string
}

// 穿透（交由上层处理）
type PermissionPassthrough = {
  behavior: 'passthrough'
  message: string
  decisionReason?: PermissionDecisionReason
  suggestions?: PermissionUpdate[]
  blockedPath?: string
  pendingClassifierCheck?: PendingClassifierCheck
}

// 最终结果类型
type PermissionResult<Input> =
  | PermissionDecision<Input>   // allow | ask | deny
  | PermissionPassthrough       // 穿透（MCP 工具等使用）
```

---

## 5. 权限检查流程

### 完整流程图

```
工具调用
  │
  ▼
validateInput()              ← 步骤 1: 输入验证
  │ 失败 → 返回错误给模型
  │
  ▼
checkPermissions()           ← 步骤 2: 工具特定权限检查
  │ behavior: 'allow' → 执行
  │ behavior: 'deny' → 拒绝
  │ behavior: 'passthrough' → 继续到通用检查
  │
  ▼
通用权限规则匹配              ← 步骤 3: deny/allow/ask 规则
  │ deny 规则命中 → 拒绝
  │ allow 规则命中 → 允许
  │ ask 规则命中 → 继续
  │
  ▼
模式检查                      ← 步骤 4: 权限模式评估
  │ bypassPermissions → 允许
  │ plan + 非只读 → 拒绝
  │ dontAsk + 无规则 → 拒绝
  │ auto → 分类器评估
  │
  ▼
分类器系统                    ← 步骤 5: (auto 模式) YOLO/Bash 分类器
  │ 安全 → 允许
  │ 危险 → 询问/拒绝
  │
  ▼
用户提示                      ← 步骤 6: 交互式确认
  │ 用户接受 → 允许（可选保存规则）
  │ 用户拒绝 → 拒绝
```

### 步骤详解

#### 步骤 1: validateInput()

在权限检查之前执行，确保输入的结构有效性：

```typescript
// Tool 接口方法
validateInput?(input, context): Promise<ValidationResult>

type ValidationResult =
  | { result: true }
  | { result: false; message: string; errorCode: number }
```

常见验证：
- 文件路径是否存在
- old_string 是否在文件中找到
- 文件是否在上次读取后被修改
- 是否在 deny 目录中

#### 步骤 2: checkPermissions()

工具特定的权限逻辑。每个工具可覆盖此方法：

```typescript
// 文件工具使用路径检查
async checkPermissions(input, context): Promise<PermissionDecision> {
  return checkWritePermissionForTool(tool, input, permissionContext)
}

// Bash 工具使用命令解析
// bashPermissions.ts 中的 bashToolHasPermission()

// MCP 工具返回 passthrough
async checkPermissions(): Promise<PermissionResult> {
  return { behavior: 'passthrough', message: 'MCPTool requires permission.' }
}
```

#### 步骤 3: 规则匹配

从 `ToolPermissionContext` 的三类规则集中匹配：

```
alwaysDenyRules   →  匹配 → deny
alwaysAllowRules  →  匹配 → allow
alwaysAskRules    →  匹配 → ask
```

---

## 6. 工具特定匹配器 (Permission Matchers)

### Bash 工具匹配

```typescript
// 命令模式匹配
// 规则: "Bash(git *)" → 匹配所有以 "git " 开头的命令
// 规则: "Bash(npm test)" → 仅匹配 "npm test"

// 通配符匹配逻辑
function matchWildcardPattern(pattern: string, command: string): boolean

// AST 分析提取命令前缀
function getCommandSubcommandPrefix(command: string): CommandPrefixResult

// 复合命令分析（&&, ||, |, ; 等）
function checkCommandOperatorPermissions(command, permissionContext)
```

#### Bash 权限检查详细流程

```
1. 解析命令 AST (tree-sitter)
2. 检查命令安全性 (bashSecurity.ts)
   - 检测命令替换、进程替换等危险模式
3. 权限模式验证 (modeValidation.ts)
   - plan 模式: 仅允许只读命令
4. 路径约束检查 (pathValidation.ts)
   - 确保操作路径在允许的工作目录内
5. Sed 约束检查 (sedValidation.ts)
   - sed 编辑命令的特殊处理
6. 只读验证 (readOnlyValidation.ts)
7. 规则匹配
8. 分类器评估（auto 模式）
```

### 文件工具匹配

```typescript
// 文件路径模式匹配
// 规则: "Edit" → 匹配所有 Edit 操作
// 规则: "Edit(/src/*)" → 匹配 /src/ 下的编辑
// 规则: "Write(/tmp/*)" → 匹配 /tmp/ 下的写入

function matchWildcardPattern(pattern: string, filePath: string): boolean
```

### WebFetch 工具匹配

```typescript
// 域名模式匹配
// 规则: "WebFetch(domain:example.com)" → 匹配 example.com 域名

function webFetchToolInputToPermissionRuleContent(input): string {
  const hostname = new URL(url).hostname
  return `domain:${hostname}`
}
```

### preparePermissionMatcher

工具可实现 `preparePermissionMatcher` 方法，预解析输入以优化 hook `if` 条件匹配：

```typescript
// FileEditTool 示例
async preparePermissionMatcher({ file_path }) {
  return pattern => matchWildcardPattern(pattern, file_path)
}

// GrepTool 示例
async preparePermissionMatcher({ pattern }) {
  return rulePattern => matchWildcardPattern(rulePattern, pattern)
}
```

---

## 7. 分类器系统

### YOLO Classifier (auto 模式)

在 `auto` 模式下，YOLO 分类器评估工具调用的安全性：

```typescript
type YoloClassifierResult = {
  thinking?: string              // 分类器思考过程
  shouldBlock: boolean           // 是否应该阻止
  reason: string                 // 决定理由
  unavailable?: boolean          // 分类器是否不可用
  transcriptTooLong?: boolean    // 上下文超长
  model: string                  // 使用的模型
  usage?: ClassifierUsage        // Token 使用量
  durationMs?: number            // 分类器耗时
  stage?: 'fast' | 'thinking'    // 两阶段 XML 分类器的阶段
  stage1Usage?: ClassifierUsage
  stage1DurationMs?: number
  stage1RequestId?: string
  stage1MsgId?: string
  stage2Usage?: ClassifierUsage
  stage2DurationMs?: number
  stage2RequestId?: string
  stage2MsgId?: string
}
```

#### 两阶段分类

1. **Stage 1 (fast)**: 快速 XML 分类，覆盖大部分安全操作
2. **Stage 2 (thinking)**: 深度思考分类，处理复杂场景

### Bash Classifier

专门针对 Bash 命令的分类器：

```typescript
type ClassifierResult = {
  matches: boolean               // 是否匹配
  matchedDescription?: string    // 匹配的描述
  confidence: 'high' | 'medium' | 'low'
  reason: string
}

type ClassifierBehavior = 'deny' | 'ask' | 'allow'

// 分类器提供三类描述
getBashPromptAllowDescriptions()  // 允许行为描述
getBashPromptAskDescriptions()    // 需询问行为描述
getBashPromptDenyDescriptions()   // 拒绝行为描述
```

### PendingClassifierCheck

异步分类器检查，允许非阻塞评估：

```typescript
type PendingClassifierCheck = {
  command: string
  cwd: string
  descriptions: string[]
}
```

当 `PermissionAskDecision` 携带 `pendingClassifierCheck` 时，分类器可在用户响应前
自动批准操作。

---

## 8. 权限持久化

### PermissionUpdate Schema

```typescript
type PermissionUpdate =
  | {
      type: 'addRules'             // 添加规则
      destination: PermissionUpdateDestination
      rules: PermissionRuleValue[]
      behavior: PermissionBehavior
    }
  | {
      type: 'replaceRules'         // 替换规则
      destination: PermissionUpdateDestination
      rules: PermissionRuleValue[]
      behavior: PermissionBehavior
    }
  | {
      type: 'removeRules'          // 移除规则
      destination: PermissionUpdateDestination
      rules: PermissionRuleValue[]
      behavior: PermissionBehavior
    }
  | {
      type: 'setMode'              // 设置模式
      destination: PermissionUpdateDestination
      mode: ExternalPermissionMode
    }
  | {
      type: 'addDirectories'       // 添加工作目录
      destination: PermissionUpdateDestination
      directories: string[]
    }
  | {
      type: 'removeDirectories'    // 移除工作目录
      destination: PermissionUpdateDestination
      directories: string[]
    }
```

### 持久化目标

```typescript
type PermissionUpdateDestination =
  | 'userSettings'       // ~/.claude/settings.json — 全局用户配置
  | 'projectSettings'    // .claude/settings.json — 项目共享配置
  | 'localSettings'      // .claude/settings.local.json — 本地配置（不入版本控制）
  | 'session'            // 仅当前会话
  | 'cliArg'             // 命令行参数
```

### 用户确认后的规则保存

用户在权限提示中选择"始终允许"时，系统会：

1. 创建 `PermissionUpdate`（`type: 'addRules'`）
2. 选择合适的 `destination`（通常 `session` 或 `userSettings`）
3. 更新 `ToolPermissionContext` 中的 `alwaysAllowRules`

---

## 9. 拒绝跟踪与阈值回退

### DenialTrackingState

```typescript
// 跟踪拒绝次数
type DenialTrackingState = {
  // 拒绝计数器
  // 达到阈值后自动回退到用户提示模式
}
```

当子 agent 的 `setAppState` 为 no-op 时（异步 agent），使用 `localDenialTracking` 避免
拒绝计数器无法累积的问题。

### 回退机制

当同一工具被连续拒绝超过阈值时，系统从自动拒绝模式回退到用户提示模式，
给用户机会手动评估操作。

---

## 10. PermissionDecisionReason

权限决定的完整理由追踪：

```typescript
type PermissionDecisionReason =
  | { type: 'rule'; rule: PermissionRule }           // 匹配了特定规则
  | { type: 'mode'; mode: PermissionMode }           // 权限模式决定
  | { type: 'subcommandResults'; reasons: Map<string, PermissionResult> }  // 子命令结果
  | { type: 'permissionPromptTool'; permissionPromptToolName; toolResult } // 权限提示工具
  | { type: 'hook'; hookName; hookSource?; reason? }  // Hook 决定
  | { type: 'asyncAgent'; reason }                     // 异步 agent
  | { type: 'sandboxOverride'; reason: 'excludedCommand' | 'dangerouslyDisableSandbox' }
  | { type: 'classifier'; classifier; reason }         // 分类器决定
  | { type: 'workingDir'; reason }                     // 工作目录约束
  | { type: 'safetyCheck'; reason; classifierApprovable } // 安全检查
  | { type: 'other'; reason }                          // 其他
```

### safetyCheck 的 classifierApprovable

```typescript
{
  type: 'safetyCheck',
  reason: string,
  classifierApprovable: boolean  // true: 分类器可评估（如敏感文件路径）
                                  // false: 必须人工确认（如 Windows 路径绕过）
}
```

---

## 11. AdditionalWorkingDirectory

```typescript
type AdditionalWorkingDirectory = {
  path: string
  source: WorkingDirectorySource  // 与 PermissionRuleSource 相同
}
```

额外工作目录扩展了文件操作的允许范围。可通过 `PermissionUpdate` 的 `addDirectories` 添加。

---

## 12. 权限系统架构图

```
┌─────────────────────────────────────────────────────┐
│                 Permission Config                    │
│                                                     │
│  ~/.claude/settings.json    (userSettings)          │
│  .claude/settings.json      (projectSettings)       │
│  .claude/settings.local.json (localSettings)        │
│  CLI args                   (cliArg)                │
│  Feature flags              (flagSettings)          │
│  Enterprise policy          (policySettings)        │
│  Session state              (session)               │
│  Command system             (command)               │
└──────────────────┬──────────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────────┐
│            ToolPermissionContext                      │
│                                                     │
│  mode: PermissionMode                               │
│  alwaysAllowRules: { source: string[] }             │
│  alwaysDenyRules: { source: string[] }              │
│  alwaysAskRules: { source: string[] }               │
│  additionalWorkingDirectories: Map                  │
└──────────────────┬──────────────────────────────────┘
                   │
          ┌────────┼────────┐
          │        │        │
          ▼        ▼        ▼
    ┌─────────┐ ┌──────┐ ┌──────────┐
    │  Deny   │ │Allow │ │   Ask    │
    │  Rules  │ │Rules │ │  Rules   │
    └────┬────┘ └──┬───┘ └────┬─────┘
         │         │          │
         ▼         ▼          ▼
┌─────────────────────────────────────────────────────┐
│              Permission Decision                     │
│                                                     │
│  Tool.checkPermissions() → rule matching →          │
│  mode evaluation → classifier (auto) →              │
│  user prompt (interactive)                          │
└──────────────────┬──────────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────────┐
│              PermissionResult                        │
│                                                     │
│  allow  → 执行工具 (可附带 updatedInput)             │
│  deny   → 返回错误给模型                             │
│  ask    → 显示权限对话框                             │
│  passthrough → 交由上层处理（MCP 工具等）             │
└─────────────────────────────────────────────────────┘
```

---

## 相关文件路径

- 权限类型定义: `/src/types/permissions.ts`
- Tool 类型 (ToolPermissionContext): `/src/Tool.ts`
- Bash 权限: `/src/tools/BashTool/bashPermissions.ts`
- Bash 安全解析: `/src/tools/BashTool/bashSecurity.ts`
- Bash 模式验证: `/src/tools/BashTool/modeValidation.ts`
- Bash 路径验证: `/src/tools/BashTool/pathValidation.ts`
- 文件系统权限: `/src/utils/permissions/filesystem.ts`
- 权限核心: `/src/utils/permissions/permissions.ts`
- 规则匹配: `/src/utils/permissions/shellRuleMatching.ts`
- 权限结果: `/src/utils/permissions/PermissionResult.ts`
- 权限更新: `/src/utils/permissions/PermissionUpdate.ts`
- Bash 分类器: `/src/utils/permissions/bashClassifier.ts`
- 拒绝跟踪: `/src/utils/permissions/denialTracking.ts`
