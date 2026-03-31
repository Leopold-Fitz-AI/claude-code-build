# Claude Code 构建系统文档

## 概述

Claude Code 使用 esbuild 作为构建工具，将 TypeScript/TSX 源码打包为单个 ESM JavaScript 文件。构建系统通过一组自定义 esbuild 插件和编译时常量注入，实现了 feature flag 控制、内部模块隔离和跨平台兼容。

**构建脚本**: `build.mjs`

**基本用法**:

```bash
# 默认构建
node build.mjs

# 自定义输出文件
node build.mjs --outfile=out.js

# 压缩输出（约 10MB）
node build.mjs --minify

# 生成 source map
node build.mjs --sourcemap

# 组合使用
node build.mjs --minify --sourcemap --outfile=claude-code.js
```

---

## 构建配置

### 核心参数

| 参数 | 值 | 描述 |
|------|-----|------|
| 入口文件 | `src/entrypoints/cli.tsx` | CLI 主入口 |
| 输出格式 | ESM (`format: 'esm'`) | ECMAScript Module 格式 |
| 目标环境 | `node18` | Node.js 18+ |
| 默认输出 | `cli.built.js` | 可通过 `--outfile` 覆盖 |
| JSX 转换 | `automatic` | React JSX Runtime 自动导入 |
| JSX Source | `react` | React 作为 JSX 工厂 |
| Tree Shaking | 启用 | 配合 feature flag 实现死代码消除 |
| Code Splitting | 禁用 | 单文件输出 |

### 完整 esbuild 配置

```javascript
await esbuild.build({
  entryPoints: ['src/entrypoints/cli.tsx'],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'esm',
  outfile: outfile,
  minify: doMinify,
  sourcemap: doSourcemap,
  banner: { js: bannerContent },
  define: { ...MACROS },
  plugins: [
    bunBundlePlugin,      // 1. bun:bundle shim
    missingModulePlugin,  // 2. 缺失模块 stub
    srcAliasPlugin,       // 3. src/ 路径别名
    tsResolverPlugin,     // 4. .js → .ts 解析
  ],
  external: externalPackages,
  jsx: 'automatic',
  jsxImportSource: 'react',
  logLevel: 'warning',
  treeShaking: true,
  splitting: false,
  metafile: false,
  nodePaths: ['node_modules'],
})
```

---

## 构建插件详解

### 插件 1: bun:bundle shim (`bunBundlePlugin`)

**用途**: 模拟 Bun 内部的 `bun:bundle` 模块，提供编译时 `feature()` 函数。

**工作原理**: Claude Code 的内部构建使用 Bun bundler，通过 `import { feature } from 'bun:bundle'` 进行编译时特性检测。esbuild 构建中，此插件拦截 `bun:bundle` 导入，返回一个包含所有 feature flag 值的 `feature()` 函数。

```javascript
const bunBundlePlugin = {
  name: 'bun-bundle-shim',
  setup(build) {
    // 拦截 bun:bundle 模块解析
    build.onResolve({ filter: /^bun:bundle$/ }, () => ({
      path: 'bun:bundle',
      namespace: 'bun-bundle-shim',
    }))

    // 返回 feature() 函数实现
    build.onLoad({ filter: /.*/, namespace: 'bun-bundle-shim' }, () => ({
      contents: `
        const FLAGS = ${JSON.stringify(FEATURE_FLAGS)};
        export function feature(name) {
          return FLAGS[name] ?? false;
        }
      `,
      loader: 'js',
    }))
  },
}
```

**在源码中的使用模式**:

```typescript
import { feature } from 'bun:bundle'

// 编译时条件 — tree shaking 会消除 false 分支
if (feature('VOICE_MODE')) {
  // 仅在 VOICE_MODE 启用时包含的代码
  const { VoiceRecorder } = await import('./voice/recorder.js')
}

if (feature('DAEMON')) {
  // 仅在内部构建中包含的 daemon 代码
  startDaemon()
}
```

---

### 插件 2: 缺失模块 stub (`missingModulePlugin`)

**用途**: 为 npm 发行版中不存在的模块生成 stub，防止构建失败。

该插件处理四类缺失模块：

#### (a) 私有/内部包

以下 npm scope 或包名的导入被 stub：

```javascript
const PRIVATE_PACKAGES = [
  '@ant/',                           // Anthropic 内部包
  '@anthropic-ai/claude-agent-sdk',  // Agent SDK
  '@anthropic-ai/mcpb',              // MCP Builder
  '@anthropic-ai/sandbox-runtime',   // 沙箱运行时
  'color-diff-napi',                 // 原生颜色差异比较
]
```

#### (b) 缺失的内部目录模块

```javascript
const MISSING_MODULES = [
  '../daemon/',                   // daemon 子系统
  '../environment-runner/',       // 环境运行器
  '../self-hosted-runner/',       // 自托管运行器
  '../cli/bg',                    // 后台 session 管理
  '../cli/handlers/templateJobs', // 模板任务处理器
]
```

#### (c) 缺失的 `.txt` 和 `.md` 文件

分类器 prompt、skill 内容等文本文件若不存在，返回空字符串：

```javascript
build.onLoad({ filter: /.*/, namespace: 'text-stub' }, () => ({
  contents: `export default "";`,
  loader: 'js',
}))
```

#### (d) `.d.ts` 类型声明文件

类型声明文件无运行时内容，直接 stub：

```javascript
build.onResolve({ filter: /\.d\.ts$/ }, () => ({
  path: 'types-stub',
  namespace: 'stub-module',
}))
```

#### 特殊 stub 实现

某些被 stub 的包需要提供功能性的 mock 对象，而非简单的 `undefined`：

**SandboxManager stub**:

```javascript
// @anthropic-ai/sandbox-runtime
export const SandboxManager = new Proxy({
  getFsReadConfig: noopObj,
  getFsWriteConfig: noopObj,
  getNetworkRestrictionConfig: noopObj,
  checkDependencies: noopAsync,
  isSupportedPlatform: () => false,
  wrapWithSandbox: (fn) => fn,
  initialize: noopAsync,
  updateConfig: noop,
  reset: noop,
}, handler)
export const SandboxRuntimeConfigSchema = { parse: (x) => x }
export const SandboxViolationStore = { getViolations: () => [], subscribe: noop }
```

**BROWSER_TOOLS stub**:

```javascript
// @ant/claude-for-chrome-mcp
export const BROWSER_TOOLS = []
export const CHROME_TOOL_NAMES = []
export const createClaudeForChromeMcpServer = () => {}
```

**Computer Use stub**:

```javascript
// @ant/computer-use-mcp
export const buildComputerUseTools = () => []
export const createComputerUseMcpServer = () => {}
export const bindSessionContext = () => {}
export const DEFAULT_GRANT_FLAGS = {}
export const API_RESIZE_PARAMS = {}
export const targetImageSize = () => ({})
export const getSentinelCategory = () => null
```

#### 完整 stub 命名导出注册表

```javascript
const STUB_NAMED_EXPORTS = {
  '@ant/computer-use-mcp': [
    'buildComputerUseTools', 'createComputerUseMcpServer',
    'bindSessionContext', 'DEFAULT_GRANT_FLAGS',
    'API_RESIZE_PARAMS', 'targetImageSize'
  ],
  '@ant/computer-use-mcp/sentinelApps': ['getSentinelCategory'],
  '@ant/computer-use-mcp/types': ['DEFAULT_GRANT_FLAGS'],
  '@ant/claude-for-chrome-mcp': [
    'createClaudeForChromeMcpServer', 'BROWSER_TOOLS', 'CHROME_TOOL_NAMES'
  ],
  '@anthropic-ai/sandbox-runtime': [
    'SandboxManager', 'SandboxRuntimeConfigSchema', 'SandboxViolationStore'
  ],
  'color-diff-napi': ['ColorDiff', 'ColorFile', 'getSyntaxTheme'],
}

// 相对路径 stub（按后缀匹配）
const RELATIVE_STUB_EXPORTS = {
  'connectorText.js': ['isConnectorTextBlock', 'ConnectorTextBlock'],
  'TungstenTool.js': ['TungstenTool'],
  'WorkflowTool/constants.js': ['WORKFLOW_TOOL_NAME'],
  'types.js': [
    'DEFAULT_UPLOAD_CONCURRENCY', 'FILE_COUNT_LIMIT', 'OUTPUTS_SUBDIR'
  ],
}
```

---

### 插件 3: 源码路径别名 (`srcAliasPlugin`)

**用途**: 解析以 `src/` 开头的 bare import 路径。

某些源文件使用 `from 'src/utils/cwd.js'` 形式的 bare import，此插件将其解析为实际文件路径。

```javascript
const srcAliasPlugin = {
  name: 'src-alias',
  setup(build) {
    build.onResolve({ filter: /^src\// }, (args) => {
      const resolved = path.join(srcDir, args.path.slice(4)) // 移除 'src/'

      // 依次尝试 .ts, .tsx, .js 扩展名
      for (const ext of ['.ts', '.tsx', '.js']) {
        const withExt = resolved.replace(/\.js$/, ext)
        if (existsSync(withExt)) {
          return { path: withExt }
        }
      }

      // 尝试目录 index 文件
      for (const ext of ['.ts', '.tsx', '.js']) {
        const indexPath = path.join(
          resolved.replace(/\.js$/, ''),
          `index${ext}`
        )
        if (existsSync(indexPath)) {
          return { path: indexPath }
        }
      }

      // 不存在则 stub
      return { path: args.path, namespace: 'stub-module' }
    })
  },
}
```

---

### 插件 4: .js → .ts/.tsx 解析器 (`tsResolverPlugin`)

**用途**: 将 `.js` 扩展名的导入解析为实际的 `.ts` 或 `.tsx` 文件。

TypeScript 源码中，`import` 语句使用 `.js` 扩展名（符合 Node.js ESM 规范），但实际源文件为 `.ts`/`.tsx`。此插件在构建时完成映射。

```javascript
const tsResolverPlugin = {
  name: 'ts-resolver',
  setup(build) {
    build.onResolve({ filter: /\.js$/ }, (args) => {
      if (args.kind === 'entry-point') return     // 跳过入口
      if (!args.path.startsWith('.')) return       // 跳过 node_modules
      if (args.namespace === 'stub-module') return // 跳过 stub

      const dir = args.resolveDir
      const jsPath = path.resolve(dir, args.path)

      // 优先尝试 .ts, .tsx
      for (const ext of ['.ts', '.tsx']) {
        const tsPath = jsPath.replace(/\.js$/, ext)
        if (existsSync(tsPath)) {
          return { path: tsPath }
        }
      }

      // .js 文件本身存在则使用
      if (existsSync(jsPath)) {
        return { path: jsPath }
      }

      // 尝试目录 index
      const dirPath = jsPath.replace(/\.js$/, '')
      for (const ext of ['.ts', '.tsx', '.js']) {
        const indexPath = path.join(dirPath, `index${ext}`)
        if (existsSync(indexPath)) {
          return { path: indexPath }
        }
      }
    })
  },
}
```

**解析优先级**:

1. `./module.ts` (TypeScript)
2. `./module.tsx` (TypeScript JSX)
3. `./module.js` (JavaScript)
4. `./module/index.ts`
5. `./module/index.tsx`
6. `./module/index.js`

---

## Feature Flags

### 编译时特性开关系统

Feature flags 实现编译时死代码消除（Dead Code Elimination）。当 flag 为 `false` 时，esbuild 的 tree shaking 会完全移除相关代码路径，使外部构建不包含内部功能代码。

### 完整 Feature Flag 列表

以下是外部构建中所有 feature flag 及其默认值：

#### 启用的功能（`true`）

| Flag | 描述 |
|------|------|
| `AUTO_THEME` | 自动主题检测 |
| `BUILDING_CLAUDE_APPS` | Claude 应用构建支持 |
| `BUILTIN_EXPLORE_PLAN_AGENTS` | 内置探索和规划 agent |
| `COMMIT_ATTRIBUTION` | Git commit 归属标记 |
| `COMPACTION_REMINDERS` | 压缩提醒 |
| `EXTRACT_MEMORIES` | 记忆提取功能 |
| `HOOK_PROMPTS` | Hook prompt 支持 |
| `MCP_RICH_OUTPUT` | MCP 富文本输出 |
| `MCP_SKILLS` | MCP 技能系统 |

#### 禁用的功能（`false`） — 部分摘录

| Flag | 描述 | 禁用原因 |
|------|------|---------|
| `DAEMON` | 后台守护进程 | `src/daemon/` 目录不在 npm 包中 |
| `BRIDGE_MODE` | claude.ai 桥接模式 | 依赖内部桥接模块 |
| `CHICAGO_MCP` | Computer Use MCP | 依赖 `@ant/computer-use-mcp` |
| `KAIROS` | 定时任务调度器 | 内部功能 |
| `VOICE_MODE` | 语音交互模式 | 依赖原生音频模块 |
| `BG_SESSIONS` | 后台 session | `src/cli/bg.ts` 缺失 |
| `SELF_HOSTED_RUNNER` | 自托管运行器 | `src/self-hosted-runner/` 缺失 |
| `BYOC_ENVIRONMENT_RUNNER` | BYOC 环境运行器 | `src/environment-runner/` 缺失 |
| `TEMPLATES` | 模板系统 | `src/cli/handlers/templateJobs.ts` 缺失 |
| `WEB_BROWSER_TOOL` | Web 浏览器工具 | 依赖内部包 |
| `COORDINATOR_MODE` | 协调器模式 | 内部功能 |
| `ULTRAPLAN` | 超级规划 | 内部功能 |
| `ULTRATHINK` | 超级思考 | 内部功能 |
| `SSH_REMOTE` | SSH 远程模式 | 内部功能 |
| `STREAMLINED_OUTPUT` | 精简输出模式 | 内部功能 |
| `PERFETTO_TRACING` | Perfetto 追踪 | 内部功能 |
| `TREE_SITTER_BASH` | Tree-sitter Bash 解析 | 内部功能 |
| `DIRECT_CONNECT` | 直连模式 | 内部功能 |
| `TERMINAL_PANEL` | 终端面板 | 内部功能 |
| `TORCH` | Torch 功能 | 内部功能 |
| `LODESTONE` | Lodestone 功能 | 内部功能 |
| `BUDDY` | Buddy 功能 | 内部功能 |

> **完整列表**: 构建脚本中定义了 120+ 个 feature flag。上表仅列出主要功能。完整定义参见 `build.mjs` 中的 `FEATURE_FLAGS` 对象。

---

## MACRO 编译时常量

MACRO 是通过 esbuild 的 `define` 选项注入的编译时常量，在代码中以 `MACRO.XXX` 形式使用。

```javascript
const MACROS = {
  'MACRO.VERSION': JSON.stringify(VERSION),
  'MACRO.BUILD_TIME': JSON.stringify(new Date().toISOString()),
  'MACRO.PACKAGE_URL': JSON.stringify('@anthropic-ai/claude-code'),
  'MACRO.NATIVE_PACKAGE_URL': JSON.stringify(null),
  'MACRO.FEEDBACK_CHANNEL': JSON.stringify(
    'https://github.com/anthropics/claude-code/issues'
  ),
  'MACRO.ISSUES_EXPLAINER': JSON.stringify(
    'report the issue at https://github.com/anthropics/claude-code/issues'
  ),
  'MACRO.VERSION_CHANGELOG': JSON.stringify(''),
  'MACRO.MACRO_VERSION': JSON.stringify(VERSION),
}
```

### 各 MACRO 用途

| MACRO | 类型 | 描述 | 示例值 |
|-------|------|------|-------|
| `MACRO.VERSION` | `string` | 当前版本号（来自 `package.json`） | `"2.1.88"` |
| `MACRO.BUILD_TIME` | `string` | 构建时间（ISO 8601） | `"2026-03-31T10:00:00.000Z"` |
| `MACRO.PACKAGE_URL` | `string` | npm 包标识符 | `"@anthropic-ai/claude-code"` |
| `MACRO.NATIVE_PACKAGE_URL` | `null` | 原生包标识符（外部构建为 null） | `null` |
| `MACRO.FEEDBACK_CHANNEL` | `string` | 反馈渠道 URL | `"https://github.com/anthropics/claude-code/issues"` |
| `MACRO.ISSUES_EXPLAINER` | `string` | 问题报告提示文本 | `"report the issue at ..."` |
| `MACRO.VERSION_CHANGELOG` | `string` | 版本变更日志 | `""` |

**在源码中的使用**:

```typescript
// 显示版本信息
console.log(`Claude Code v${MACRO.VERSION}`)

// 构建时间
console.log(`Built at: ${MACRO.BUILD_TIME}`)

// 错误报告提示
console.log(`请${MACRO.ISSUES_EXPLAINER}`)
```

> **注意**: VERSION 从 `package.json` 的 `version` 字段读取，若不存在则回退到 `'2.1.88'`。

---

## External 包（不打包）

以下包被标记为 `external`，不会被 esbuild 打包，而是在运行时动态 `import()` 或 `require()`：

### 原生 .node 绑定

```javascript
'*.node',              // 所有 NAPI .node 二进制
'modifiers-napi',      // 键盘修饰键检测
'audio-capture-napi',  // 音频录制/播放
```

### 图像处理

```javascript
'@img/sharp-*',   // Sharp 平台特定二进制
'sharp',           // Sharp 核心（原生绑定，运行时解析）
```

### 云 SDK（按需动态导入）

```javascript
'@aws-sdk/client-bedrock',       // AWS Bedrock
'@aws-sdk/client-sts',           // AWS STS
'@anthropic-ai/bedrock-sdk',     // Anthropic Bedrock SDK
'@anthropic-ai/foundry-sdk',     // Anthropic Foundry SDK
'@anthropic-ai/vertex-sdk',      // Anthropic Vertex SDK
'@azure/identity',               // Azure 身份认证
```

### OpenTelemetry 导出器

```javascript
// Metrics 导出器
'@opentelemetry/exporter-metrics-otlp-grpc',
'@opentelemetry/exporter-metrics-otlp-http',
'@opentelemetry/exporter-metrics-otlp-proto',
'@opentelemetry/exporter-prometheus',

// Logs 导出器
'@opentelemetry/exporter-logs-otlp-grpc',
'@opentelemetry/exporter-logs-otlp-http',
'@opentelemetry/exporter-logs-otlp-proto',

// Traces 导出器
'@opentelemetry/exporter-trace-otlp-grpc',
'@opentelemetry/exporter-trace-otlp-http',
'@opentelemetry/exporter-trace-otlp-proto',
```

### 其他可选依赖

```javascript
'fflate',     // 可选压缩库
'turndown',   // HTML → Markdown 转换器（原生插件）
```

---

## 输出文件结构

### Banner（文件头）

构建输出的文件头包含 shebang、版权声明和 CJS 兼容 shim：

```javascript
#!/usr/bin/env node
// Claude Code v2.1.88 - Built from source on 2026-03-31T10:00:00.000Z
// (c) Anthropic PBC. All rights reserved.

import { createRequire as __createRequire } from 'node:module';
import { fileURLToPath as __fileURLToPath } from 'node:url';
import { dirname as __dirname_fn } from 'node:path';
const __filename = __fileURLToPath(import.meta.url);
const __dirname = __dirname_fn(__filename);
const require = __createRequire(import.meta.url);
```

**Banner 设计说明**:

1. **Shebang** (`#!/usr/bin/env node`) — 允许直接作为可执行脚本运行
2. **版权声明** — 包含版本号和构建时间
3. **`createRequire` shim** — ESM 格式不原生支持 `require()`，但原生 `.node` 模块必须通过 `require()` 加载。此 shim 创建了一个 CJS 兼容的 `require` 函数

### 输出大小

| 构建模式 | 大小 | 说明 |
|---------|------|------|
| 默认（无压缩） | ~40-50 MB | 开发调试用 |
| `--minify` | ~10 MB | 生产部署推荐 |
| `--minify --sourcemap` | ~10 MB + .map | 生产部署 + 调试支持 |

---

## 构建流程图

```
package.json (version)
       │
       ▼
┌─────────────────────────────────────────────┐
│  build.mjs                                  │
│                                             │
│  1. 解析 CLI 参数 (--outfile, --minify...)  │
│  2. 读取版本号                               │
│  3. 定义 FEATURE_FLAGS (120+)               │
│  4. 定义 MACROS (7 个编译时常量)             │
│  5. 注册 esbuild 插件                       │
│     ├── bunBundlePlugin (feature flags)     │
│     ├── missingModulePlugin (stubs)         │
│     ├── srcAliasPlugin (src/ 别名)          │
│     └── tsResolverPlugin (.js→.ts)          │
│  6. 执行 esbuild.build()                   │
└─────────────────────┬───────────────────────┘
                      │
     ┌────────────────┼────────────────┐
     │                │                │
     ▼                ▼                ▼
src/entrypoints/   node_modules/   vendor/
  cli.tsx            (bundled)      (external)
     │
     ▼
cli.built.js (单文件 ESM 输出)
  ├── Banner (shebang + require shim)
  ├── 打包的应用代码
  ├── 打包的依赖代码
  └── feature-gated 代码（false 分支已消除）
```

---

## 故障排除

### 常见构建错误

**1. 模块解析失败**

```
[stub] Missing module: ../some/path.js (from src/xxx/yyy.ts)
```

这是正常的 — 缺失的模块被 stub 插件处理。如果该模块确实需要，请检查是否缺少相关 npm 包。

**2. Named export 缺失**

若构建时报错 `xxx is not exported from yyy`，需要在 `STUB_NAMED_EXPORTS` 或 `RELATIVE_STUB_EXPORTS` 中添加对应的 export 名称：

```javascript
// build.mjs
const STUB_NAMED_EXPORTS = {
  'new-package': ['exportA', 'exportB'],
}
```

**3. 原生模块加载失败**

运行时若 `.node` 模块加载失败，检查：
- 目标平台的预编译二进制文件是否存在于 `vendor/` 下
- 文件权限是否正确（Linux/macOS 需要可执行权限）
- `external` 列表是否包含该模块

### 添加新的 Feature Flag

1. 在 `build.mjs` 的 `FEATURE_FLAGS` 对象中添加新 flag
2. 在源码中使用 `feature('NEW_FLAG')` 守卫
3. 外部构建设为 `false`，内部构建可按需设为 `true`

```javascript
// build.mjs
const FEATURE_FLAGS = {
  // ...
  MY_NEW_FEATURE: false,  // 默认关闭
}

// 源码中使用
import { feature } from 'bun:bundle'
if (feature('MY_NEW_FEATURE')) {
  // 新功能代码
}
```

### 添加新的私有包 Stub

1. 将包前缀添加到 `PRIVATE_PACKAGES`
2. 若需要特定 named exports，添加到 `STUB_NAMED_EXPORTS`
3. 若需要功能性 mock（而非 `undefined`），在 `missingModulePlugin` 的 `onLoad` 中添加特殊处理

```javascript
// 步骤 1
const PRIVATE_PACKAGES = [
  // ...
  '@myorg/internal-package',
]

// 步骤 2
const STUB_NAMED_EXPORTS = {
  // ...
  '@myorg/internal-package': ['MyClass', 'myFunction'],
}

// 步骤 3（可选，需要功能性 mock 时）
if (args.path.includes('internal-package')) {
  return {
    contents: `
      export class MyClass { constructor() {} }
      export const myFunction = () => null;
      export default {};
    `,
    loader: 'js',
  }
}
```
