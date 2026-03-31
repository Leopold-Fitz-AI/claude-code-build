# 模型选择与管理

本文档描述 Claude Code 的模型选择机制，包括选择优先级、模型别名、能力检测、企业允许列表和模型迁移。

---

## 模型选择优先级

模型的选择遵循以下优先级（从高到低）：

```
1. Session Override (/model 命令)  — 最高优先级
2. --model CLI flag               — 启动参数
3. ANTHROPIC_MODEL 环境变量        — 环境变量
4. Settings (settings.json model)  — 用户设置
5. Built-in Default               — 内建默认值
```

### 核心函数：`getUserSpecifiedModelSetting()` (`src/utils/model/model.ts`)

```typescript
function getUserSpecifiedModelSetting(): ModelSetting | undefined {
  // 1. 检查会话覆盖（/model 命令设置的 getMainLoopModelOverride()）
  // 2. 检查 --model 启动参数
  // 3. 检查 ANTHROPIC_MODEL 环境变量
  // 4. 检查 settings.model
  // 5. 验证模型是否在 allowlist 中（不在则返回 undefined）
  // 返回 undefined 表示用户未指定，将使用默认值
}
```

### 核心函数：`getMainLoopModel()`

```typescript
function getMainLoopModel(): ModelName {
  const model = getUserSpecifiedModelSetting()
  if (model !== undefined && model !== null) {
    return parseUserSpecifiedModel(model)  // 解析别名为完整模型名
  }
  return getDefaultMainLoopModel()  // 使用默认模型
}
```

### 核心函数：`getBestModel()`

```typescript
function getBestModel(): ModelName {
  return getDefaultOpusModel()  // 始终返回最佳可用模型（Opus）
}
```

---

## 模型别名 (`src/utils/model/aliases.ts`)

### 定义

```typescript
const MODEL_ALIASES = [
  'sonnet',       // → 当前最新 Sonnet 版本
  'opus',         // → 当前最新 Opus 版本
  'haiku',        // → 当前最新 Haiku 版本
  'best',         // → 最佳模型（等同 opus）
  'sonnet[1m]',   // → Sonnet + 1M context
  'opus[1m]',     // → Opus + 1M context
  'opusplan',     // → Opus 仅在 plan 模式使用，其他模式用 Sonnet
] as const

type ModelAlias = (typeof MODEL_ALIASES)[number]
```

### Family Alias（模型家族别名）

```typescript
const MODEL_FAMILY_ALIASES = ['sonnet', 'opus', 'haiku'] as const
```

Family alias 在 `availableModels` 允许列表中作为通配符使用：
- 当 `"opus"` 在允许列表中时，所有 Opus 版本（4.5, 4.6 等）均被允许
- 当具体模型 ID 在允许列表中时，仅该精确版本被允许

### 别名解析

```typescript
function isModelAlias(modelInput: string): modelInput is ModelAlias
// 检查输入是否为已知别名

function parseUserSpecifiedModel(model: ModelSetting): ModelName
// 将别名解析为实际模型名称
// 例如：'opus' → 'claude-opus-4-6-20250514'
```

---

## 默认模型选择

### `getDefaultMainLoopModelSetting()`

根据用户订阅类型选择默认模型：

```typescript
function getDefaultMainLoopModelSetting(): ModelName | ModelAlias {
  // Max 订阅用户 → Opus（可能带 [1m] 后缀）
  if (isMaxSubscriber()) return getDefaultOpusModel() + (isOpus1mMergeEnabled() ? '[1m]' : '')

  // Team Premium 订阅用户 → Opus（同 Max）
  if (isTeamPremiumSubscriber()) return getDefaultOpusModel() + (isOpus1mMergeEnabled() ? '[1m]' : '')

  // 其他用户（PAYG, Enterprise, Team Standard, Pro）→ Sonnet
  return getDefaultSonnetModel()
}
```

### 各模型族的默认版本

#### Opus 默认模型

```typescript
function getDefaultOpusModel(): ModelName {
  // 环境变量覆盖：ANTHROPIC_DEFAULT_OPUS_MODEL
  // 3P 提供商：opus46（可能滞后于 1P）
  // 1P（firstParty）：opus46
  return getModelStrings().opus46
}
```

#### Sonnet 默认模型

```typescript
function getDefaultSonnetModel(): ModelName {
  // 环境变量覆盖：ANTHROPIC_DEFAULT_SONNET_MODEL
  // 3P 提供商：sonnet45（可能滞后于 1P）
  // 1P（firstParty）：sonnet46
  return getModelStrings().sonnet46
}
```

#### Haiku 默认模型

```typescript
function getDefaultHaikuModel(): ModelName {
  // 环境变量覆盖：ANTHROPIC_DEFAULT_HAIKU_MODEL
  // 所有平台：haiku45
  return getModelStrings().haiku45
}
```

### Small Fast Model

```typescript
function getSmallFastModel(): ModelName {
  return process.env.ANTHROPIC_SMALL_FAST_MODEL || getDefaultHaikuModel()
}
```

用于轻量级任务（如 token 估算、标题生成等）。

---

## 运行时模型选择

### `getRuntimeMainLoopModel()`

根据运行时上下文动态调整模型选择：

```typescript
function getRuntimeMainLoopModel(params: {
  permissionMode: PermissionMode
  mainLoopModel: string
  exceeds200kTokens?: boolean
}): ModelName {
  // opusplan 模式：plan 模式时用 Opus（无 [1m] 后缀），其他模式用常规模型
  if (getUserSpecifiedModelSetting() === 'opusplan' && permissionMode === 'plan' && !exceeds200kTokens) {
    return getDefaultOpusModel()
  }

  // haiku + plan 模式 → 自动升级到 Sonnet
  if (getUserSpecifiedModelSetting() === 'haiku' && permissionMode === 'plan') {
    return getDefaultSonnetModel()
  }

  return mainLoopModel
}
```

---

## 模型能力检测

### 1M Context 支持

```typescript
function modelSupports1M(model: ModelName): boolean
// 检查模型是否支持 1M token context window

function has1mContext(): boolean
// 当前会话是否使用 1M context（考虑模型 + 配置）

function is1mContextDisabled(): boolean
// 1M context 是否被禁用
```

### Context Window 后缀

```
claude-opus-4-6[1m]    ← 启用 1M context
claude-opus-4-6         ← 标准 context（200K）
```

`[1m]` 后缀指示 API 使用扩展 context window。

### Caching 支持

模型级别的 prompt caching 能力检测，用于决定是否启用 cache_control 标记。

### Thinking Mode

Extended thinking 模式的能力检测，用于决定是否显示思考过程。

---

## 企业模型允许列表

### `isModelAllowed()` (`src/utils/model/modelAllowlist.ts`)

```typescript
function isModelAllowed(model: string): boolean {
  // 1. 获取 settings.availableModels
  // 2. 如果未配置允许列表，所有模型都允许
  // 3. 检查精确匹配
  // 4. 检查 family alias 匹配（如 'opus' 匹配所有 opus 版本）
  // 5. 返回是否允许
}
```

### 允许列表配置

在 `policySettings`（企业策略）中设置：

```json
{
  "availableModels": [
    "sonnet",                              // family alias：允许所有 Sonnet 版本
    "claude-opus-4-6-20250514",            // 精确版本：仅允许该版本
    "haiku"                                // family alias：允许所有 Haiku 版本
  ]
}
```

### 用户交互

当用户指定的模型不在允许列表中时：
- `getUserSpecifiedModelSetting()` 返回 `undefined`
- 回退到默认模型
- `/model` 命令的 UI 中仅显示允许的模型

---

## 费用计算

### `formatModelPricing()` (`src/utils/modelCost.ts`)

```typescript
function formatModelPricing(model: ModelName): string
// 返回模型的价格信息字符串
```

### Opus 4.6 费用层级

```typescript
function getOpus46CostTier(): string
// 获取 Opus 4.6 的费用层级（不同订阅类型可能有不同定价）
```

### 费用追踪

每次 API 调用后，根据 input/output token 数量和模型价格计算费用，累计显示在 StatusLine 中。

---

## 模型迁移

Claude Code 通过迁移脚本（`src/migrations/`）在版本升级时自动更新用户的模型设置。

### 迁移历史

| 迁移文件 | 说明 |
|----------|------|
| `migrateFennecToOpus.ts` | fennec 代号 → opus 正式名称 |
| `migrateOpusToOpus1m.ts` | opus → opus[1m]（默认启用 1M context） |
| `migrateSonnet1mToSonnet45.ts` | sonnet[1m] → sonnet 4.5 |
| `migrateSonnet45ToSonnet46.ts` | sonnet 4.5 → sonnet 4.6 |
| `migrateLegacyOpusToCurrent.ts` | 旧版 Opus → 当前 Opus |
| `resetProToOpusDefault.ts` | 重置 Pro 用户到 Opus 默认 |

### 迁移执行

迁移在 CLI 启动时自动运行，按顺序检查并执行。每个迁移：
1. 检查 settings.json 中的 model 字段
2. 如果匹配旧值，替换为新值
3. 保存更新后的设置

---

## 模型显示

### `modelDisplayString()`

```typescript
function modelDisplayString(model: ModelName): string
// 将完整模型 ID 转换为用户友好的显示名称
// 例如：'claude-opus-4-6-20250514' → 'Opus 4.6'
```

### `firstPartyNameToCanonical()`

```typescript
function firstPartyNameToCanonical(name: ModelName): ModelShortName
// 将完整模型名标准化为短名称
// 处理日期后缀、提供商前缀等
// 例如：'claude-3-7-sonnet-20250219' → 'sonnet-3.7'
```

---

## 3P 提供商模型映射

### API Provider 检测

```typescript
function getAPIProvider(): 'firstParty' | 'bedrock' | 'vertex' | 'foundry'
// 检测当前使用的 API 提供商
```

### 模型名称映射 (`src/utils/model/modelStrings.ts`)

不同提供商使用不同的模型名称格式：

| 提供商 | Opus 4.6 示例格式 |
|--------|---------------------|
| firstParty | `claude-opus-4-6-20250514` |
| Bedrock | `us.anthropic.claude-opus-4-6-v1:0` |
| Vertex | `claude-opus-4-6@20250514` |
| Foundry | `claude-opus-4-6` |

```typescript
function getModelStrings(): ModelStrings
// 返回当前提供商对应的模型名称映射

function resolveOverriddenModel(model: string): string
// 解析可能被环境变量覆盖的模型名称
```

---

## Opus 1M Merge

```typescript
function isOpus1mMergeEnabled(): boolean
// 检查 Opus [1m] 是否已合并为默认行为
// 当启用时，Opus 默认使用 1M context，无需 [1m] 后缀
```

这是一个渐进推出的功能，通过 GrowthBook feature flag 控制。

---

## 判断函数汇总

| 函数 | 说明 |
|------|------|
| `getMainLoopModel()` | 获取当前主循环模型 |
| `getBestModel()` | 获取最佳可用模型（Opus） |
| `getUserSpecifiedModelSetting()` | 获取用户指定的模型设置 |
| `isModelAllowed(model)` | 检查模型是否在允许列表中 |
| `getSmallFastModel()` | 获取轻量级快速模型（Haiku） |
| `getDefaultMainLoopModel()` | 获取默认主循环模型 |
| `getDefaultMainLoopModelSetting()` | 获取默认模型设置（考虑订阅类型） |
| `getDefaultOpusModel()` | 获取默认 Opus 模型 |
| `getDefaultSonnetModel()` | 获取默认 Sonnet 模型 |
| `getDefaultHaikuModel()` | 获取默认 Haiku 模型 |
| `getRuntimeMainLoopModel(params)` | 获取运行时模型（考虑权限模式） |
| `isNonCustomOpusModel(model)` | 是否为非自定义 Opus 模型 |
| `modelDisplayString(model)` | 模型显示名称 |
| `firstPartyNameToCanonical(name)` | 标准化模型名称 |
| `isModelAlias(input)` | 是否为模型别名 |
| `isModelFamilyAlias(model)` | 是否为模型家族别名 |
