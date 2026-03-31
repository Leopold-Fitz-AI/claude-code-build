# Claude Code Vendor 与原生模块文档

## 概述

Claude Code 使用预编译的原生模块（NAPI `.node` 二进制文件）来实现高性能的音频录制/播放、图像处理、键盘修饰键检测和 URL 事件处理。这些模块位于 `vendor/` 目录下，支持多平台交叉编译。

**源码目录结构**:

```
vendor/
├── audio-capture/                # 预编译的音频录制/播放原生模块
│   ├── arm64-darwin/audio-capture.node
│   ├── x64-darwin/audio-capture.node
│   ├── arm64-linux/audio-capture.node
│   ├── x64-linux/audio-capture.node
│   ├── arm64-win32/audio-capture.node
│   └── x64-win32/audio-capture.node
├── audio-capture-src/            # 音频模块 TypeScript 封装
│   └── index.ts
├── ripgrep/                      # 预编译的 ripgrep (rg) 二进制文件
│   ├── arm64-darwin/rg
│   ├── x64-darwin/rg
│   ├── arm64-linux/rg
│   ├── x64-linux/rg
│   ├── arm64-win32/rg.exe
│   ├── x64-win32/rg.exe
│   └── COPYING
├── modifiers-napi-src/           # macOS 键盘修饰键检测
│   └── index.ts
├── url-handler-src/              # macOS Apple Event URL 处理
│   └── index.ts
└── image-processor-src/          # 图像处理模块（Sharp 兼容）
    └── index.ts
```

---

## 模块加载策略

所有原生模块使用统一的三层 fallback 加载策略：

```
环境变量路径 → 打包路径 → vendor 目录路径
```

### 优先级说明

| 优先级 | 加载方式 | 使用场景 | 路径示例 |
|--------|---------|---------|---------|
| 1（最高） | 环境变量 (`*_NODE_PATH`) | Bun compile 打包后的原生构建 | `process.env.AUDIO_CAPTURE_NODE_PATH` |
| 2 | 打包根目录相对路径 | npm install 后的生产布局 | `./vendor/audio-capture/${platformDir}/audio-capture.node` |
| 3（最低） | 源码相对路径 | 开发模式 | `../audio-capture/${platformDir}/audio-capture.node` |

**平台目录命名规则**: `${process.arch}-${process.platform}`

例如：`arm64-darwin`、`x64-linux`、`arm64-win32`

### 通用加载模式

所有模块封装均遵循相同的惰性加载模式：

```typescript
let cachedModule: NativeModuleType | null = null
let loadAttempted = false

function loadModule(): NativeModuleType | null {
  if (loadAttempted) return cachedModule
  loadAttempted = true

  // 优先级 1：环境变量路径（Bun compile 嵌入模式）
  if (process.env.MODULE_NODE_PATH) {
    try {
      cachedModule = require(process.env.MODULE_NODE_PATH)
      return cachedModule
    } catch { /* fallthrough */ }
  }

  // 优先级 2-3：运行时 fallback 路径
  const platformDir = `${process.arch}-${process.platform}`
  const fallbacks = [
    `./vendor/module/${platformDir}/module.node`,  // npm install 布局
    `../module/${platformDir}/module.node`,         // 开发布局
  ]
  for (const p of fallbacks) {
    try {
      cachedModule = require(p)
      return cachedModule
    } catch { /* try next */ }
  }
  return null
}
```

> **关键设计**: `loadAttempted` 标志确保仅尝试加载一次（即使加载失败），避免重复 `dlopen` 开销。首次调用 `loadModule()` 后，后续调用直接返回缓存结果。

---

## audio-capture 模块

**源码**: `vendor/audio-capture-src/index.ts`

多平台音频录制和播放 NAPI 原生模块。支持 macOS (darwin)、Linux 和 Windows (win32)。

### 原生绑定接口

```typescript
type AudioCaptureNapi = {
  // 开始录制音频
  startRecording(
    onData: (data: Buffer) => void,  // 音频数据回调
    onEnd: () => void                // 录制结束回调
  ): boolean

  // 停止录制
  stopRecording(): void

  // 是否正在录制
  isRecording(): boolean

  // 开始播放
  startPlayback(sampleRate: number, channels: number): boolean

  // 写入播放数据
  writePlaybackData(data: Buffer): void

  // 停止播放
  stopPlayback(): void

  // 是否正在播放
  isPlaying(): boolean

  // 麦克风授权状态（可选，部分平台可能不存在）
  microphoneAuthorizationStatus?(): number
}
```

### 导出的公共 API

| 函数 | 签名 | 描述 |
|------|------|------|
| `isNativeAudioAvailable()` | `() => boolean` | 检查原生音频模块是否可用 |
| `startNativeRecording()` | `(onData, onEnd) => boolean` | 开始录制音频，返回是否成功 |
| `stopNativeRecording()` | `() => void` | 停止录制 |
| `isNativeRecordingActive()` | `() => boolean` | 是否正在录制 |
| `startNativePlayback()` | `(sampleRate, channels) => boolean` | 开始播放音频 |
| `writeNativePlaybackData()` | `(data: Buffer) => void` | 写入播放数据 |
| `stopNativePlayback()` | `() => void` | 停止播放 |
| `isNativePlaying()` | `() => boolean` | 是否正在播放 |
| `microphoneAuthorizationStatus()` | `() => number` | 获取麦克风授权状态 |

### 麦克风授权状态码

| 状态码 | macOS (TCC) | Linux | Windows |
|--------|-------------|-------|---------|
| `0` | 未确定 (notDetermined) | -- | -- |
| `1` | 受限 (restricted) | -- | -- |
| `2` | 拒绝 (denied) | -- | 注册表中明确拒绝 |
| `3` | 已授权 (authorized) | 始终返回（无系统级 API） | 注册表缺失或允许 |

若原生模块不可用，`microphoneAuthorizationStatus()` 返回 `0`（未确定）。

### 环境变量

- `AUDIO_CAPTURE_NODE_PATH` — 自定义 `.node` 二进制文件路径（Bun compile 模式下在构建时定义）

### 使用示例

```typescript
import {
  isNativeAudioAvailable,
  startNativeRecording,
  stopNativeRecording,
  microphoneAuthorizationStatus,
} from './vendor/audio-capture-src/index.js'

// 检查可用性
if (!isNativeAudioAvailable()) {
  console.log('当前平台不支持原生音频')
  process.exit(1)
}

// 检查麦克风权限
const authStatus = microphoneAuthorizationStatus()
if (authStatus !== 3) {
  console.log(`麦克风未授权，状态码: ${authStatus}`)
  process.exit(1)
}

// 开始录制
const chunks: Buffer[] = []
const started = startNativeRecording(
  (data) => chunks.push(data),
  () => console.log('录制结束')
)

if (started) {
  // 5 秒后停止
  setTimeout(() => {
    stopNativeRecording()
    const fullAudio = Buffer.concat(chunks)
    console.log(`录制了 ${fullAudio.length} 字节的音频数据`)
  }, 5000)
}
```

---

## ripgrep 模块

**目录**: `vendor/ripgrep/`

预编译的 [ripgrep](https://github.com/BurntSushi/ripgrep) (rg) 二进制文件，用于快速全文内容搜索。Claude Code 的 GrepTool 依赖此模块。

### 平台支持

| 平台 | 架构 | 文件 |
|------|------|------|
| macOS (darwin) | arm64 | `arm64-darwin/rg` |
| macOS (darwin) | x64 | `x64-darwin/rg` |
| Linux | arm64 | `arm64-linux/rg` |
| Linux | x64 | `x64-linux/rg` |
| Windows (win32) | arm64 | `arm64-win32/rg.exe` |
| Windows (win32) | x64 | `x64-win32/rg.exe` |

### 许可证

ripgrep 使用 MIT 许可证分发，许可证文件位于 `vendor/ripgrep/COPYING`。

### 在 GrepTool 中的使用

GrepTool 通过以下方式定位 rg 二进制文件：

```typescript
const rgPath = path.join(
  vendorDir,
  'ripgrep',
  `${process.arch}-${process.platform}`,
  process.platform === 'win32' ? 'rg.exe' : 'rg'
)
```

---

## modifiers-napi 模块

**源码**: `vendor/modifiers-napi-src/index.ts`

macOS 专用的键盘修饰键实时检测模块。用于检测用户是否按住 Option、Command 等修饰键。

### 平台限制

**仅 macOS 可用**。在其他平台上，所有函数返回空值/默认值。

### 原生绑定接口

```typescript
type ModifiersNapi = {
  getModifiers(): string[]                    // 获取当前按下的所有修饰键
  isModifierPressed(modifier: string): boolean // 检查特定修饰键是否按下
}
```

### 导出的公共 API

| 函数 | 签名 | 描述 |
|------|------|------|
| `getModifiers()` | `() => string[]` | 返回当前按下的修饰键数组。非 macOS 返回空数组 `[]` |
| `isModifierPressed()` | `(modifier: string) => boolean` | 检查特定修饰键是否按下。非 macOS 返回 `false` |
| `prewarm()` | `() => void` | 预加载原生模块，避免首次使用时的延迟。建议在启动时调用 |

### 环境变量

- `MODIFIERS_NODE_PATH` — 自定义 `.node` 二进制文件路径

### 加载路径

```typescript
// 打包模式
require(process.env.MODIFIERS_NODE_PATH)

// 开发模式
const modulePath = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'modifiers-napi',
  `${process.arch}-darwin`,    // 仅 darwin
  'modifiers.node'
)
```

### 使用示例

```typescript
import { getModifiers, isModifierPressed, prewarm } from './vendor/modifiers-napi-src/index.js'

// 启动时预热
prewarm()

// 检测修饰键
const modifiers = getModifiers()
console.log('当前按下的修饰键:', modifiers)

if (isModifierPressed('option')) {
  console.log('Option 键被按下，启用替代行为')
}
```

---

## url-handler 模块

**源码**: `vendor/url-handler-src/index.ts`

macOS 专用的 Apple Event URL 处理模块。用于监听和处理 `kAEGetURL` Apple Event，实现自定义 URL scheme 的 deep linking。

### 平台限制

**仅 macOS 可用**。在其他平台上返回 `null`。

### 原生绑定接口

```typescript
type UrlHandlerNapi = {
  waitForUrlEvent(timeoutMs: number): string | null
}
```

### 导出的公共 API

| 函数 | 签名 | 描述 |
|------|------|------|
| `waitForUrlEvent()` | `(timeoutMs: number) => string \| null` | 等待 macOS URL 事件。初始化 NSApplication，注册 URL 事件，泵送事件循环直到超时。返回 URL 字符串或 `null` |

### 环境变量

- `URL_HANDLER_NODE_PATH` — 自定义 `.node` 二进制文件路径

### 工作原理

1. 初始化 `NSApplication`（macOS 应用程序框架）
2. 注册 `kAEGetURL` Apple Event 处理器
3. 泵送（pump）事件循环 `timeoutMs` 毫秒
4. 收到 URL 事件时返回 URL 字符串，否则超时返回 `null`

### 使用示例

```typescript
import { waitForUrlEvent } from './vendor/url-handler-src/index.js'

// 等待最多 30 秒的 URL 事件（用于 OAuth 回调等场景）
const url = waitForUrlEvent(30000)

if (url) {
  console.log(`收到 URL: ${url}`)
  // 解析 OAuth callback URL
  const parsed = new URL(url)
  const code = parsed.searchParams.get('code')
  console.log(`授权码: ${code}`)
} else {
  console.log('等待超时，未收到 URL 事件')
}
```

---

## image-processor 模块

**源码**: `vendor/image-processor-src/index.ts`

高性能图像处理模块，提供与 [Sharp](https://sharp.pixelplumbing.com/) 兼容的链式 API。原生部分基于系统图形库（macOS 上链接 CoreGraphics/ImageIO），TypeScript 层提供 Sharp 兼容的封装。

### 类型定义

```typescript
// 剪贴板图像结果
type ClipboardImageResult = {
  png: Buffer           // PNG 格式图像数据
  originalWidth: number // 原始宽度
  originalHeight: number // 原始高度
  width: number         // 处理后宽度
  height: number        // 处理后高度
}

// 原生模块接口
type NativeModule = {
  processImage: (input: Buffer) => Promise<ImageProcessor>
  readClipboardImage?: (maxWidth: number, maxHeight: number) => ClipboardImageResult | null
  hasClipboardImage?: () => boolean
}

// 图像处理器（原生）
interface ImageProcessor {
  metadata(): { width: number; height: number; format: string }
  resize(width: number, height: number, options?: {
    fit?: string
    withoutEnlargement?: boolean
  }): ImageProcessor
  jpeg(quality?: number): ImageProcessor
  png(options?: {
    compressionLevel?: number
    palette?: boolean
    colors?: number
  }): ImageProcessor
  webp(quality?: number): ImageProcessor
  toBuffer(): Promise<Buffer>
}

// Sharp 兼容接口
interface SharpInstance {
  metadata(): Promise<{ width: number; height: number; format: string }>
  resize(width: number, height: number, options?: {
    fit?: string
    withoutEnlargement?: boolean
  }): SharpInstance
  jpeg(options?: { quality?: number }): SharpInstance
  png(options?: {
    compressionLevel?: number
    palette?: boolean
    colors?: number
  }): SharpInstance
  webp(options?: { quality?: number }): SharpInstance
  toBuffer(): Promise<Buffer>
}
```

### 导出的公共 API

| 函数/类型 | 签名 | 描述 |
|-----------|------|------|
| `getNativeModule()` | `() => NativeModule \| null` | 获取原生模块实例，惰性加载 |
| `sharp()` | `(input: Buffer) => SharpInstance` | Sharp 兼容的工厂函数，创建图像处理链 |

### 惰性加载设计

图像处理模块使用与其他模块相同的惰性加载模式，但有特殊原因：原生二进制文件链接了 macOS 的 CoreGraphics/ImageIO 框架。如果在模块导入时立即调用 `dlopen`，会阻塞启动过程（因为 `imagePaste.ts` 通过静态 import 将其拉入 REPL chunk）。因此采用延迟到首次调用时才加载。

```typescript
// 惰性加载模式
let cachedModule: NativeModule | null = null
let loadAttempted = false

export function getNativeModule(): NativeModule | null {
  if (loadAttempted) return cachedModule
  loadAttempted = true
  try {
    cachedModule = require('../../image-processor.node')
  } catch {
    cachedModule = null
  }
  return cachedModule
}
```

### Sharp 兼容 API 使用示例

```typescript
import { sharp } from './vendor/image-processor-src/index.js'

// 链式 API — 与 npm sharp 包 API 兼容
const inputBuffer = fs.readFileSync('input.png')

// 获取元数据
const instance = sharp(inputBuffer)
const meta = await instance.metadata()
console.log(`图像尺寸: ${meta.width}x${meta.height}, 格式: ${meta.format}`)

// 调整大小并转换格式
const outputBuffer = await sharp(inputBuffer)
  .resize(800, 600, { fit: 'inside', withoutEnlargement: true })
  .jpeg({ quality: 85 })
  .toBuffer()

fs.writeFileSync('output.jpg', outputBuffer)

// PNG 压缩
const pngBuffer = await sharp(inputBuffer)
  .resize(256, 256)
  .png({ compressionLevel: 9, palette: true, colors: 128 })
  .toBuffer()

// WebP 转换
const webpBuffer = await sharp(inputBuffer)
  .webp({ quality: 80 })
  .toBuffer()
```

### 剪贴板图像功能（macOS 专用）

`readClipboardImage` 和 `hasClipboardImage` 仅在 macOS darwin 二进制文件中存在。这些属性名仅在类型空间中出现，所有运行时属性访问都在 `src/` 中通过 `feature()` 守卫，确保它们在不需要的构建中被 tree-shake 消除。

```typescript
const mod = getNativeModule()
if (mod?.hasClipboardImage?.()) {
  const result = mod.readClipboardImage(1920, 1080)
  if (result) {
    console.log(`剪贴板图像: ${result.originalWidth}x${result.originalHeight}`)
    console.log(`处理后: ${result.width}x${result.height}`)
    fs.writeFileSync('clipboard.png', result.png)
  }
}
```

---

## 平台支持矩阵

| 模块 | macOS arm64 | macOS x64 | Linux arm64 | Linux x64 | Win32 arm64 | Win32 x64 |
|------|:-----------:|:---------:|:-----------:|:---------:|:-----------:|:---------:|
| audio-capture | Yes | Yes | Yes | Yes | Yes | Yes |
| ripgrep | Yes | Yes | Yes | Yes | Yes | Yes |
| modifiers-napi | Yes | Yes | -- | -- | -- | -- |
| url-handler | Yes | Yes | -- | -- | -- | -- |
| image-processor | Yes* | Yes* | -- | -- | -- | -- |

> `*` image-processor 的原生二进制文件 (`image-processor.node`) 不在 vendor 目录中预编译分发，而是通过打包流程嵌入或依赖 sharp npm 包。

### 各模块环境变量总结

| 模块 | 环境变量 | 描述 |
|------|---------|------|
| audio-capture | `AUDIO_CAPTURE_NODE_PATH` | `.node` 二进制文件路径 |
| modifiers-napi | `MODIFIERS_NODE_PATH` | `.node` 二进制文件路径 |
| url-handler | `URL_HANDLER_NODE_PATH` | `.node` 二进制文件路径 |
| image-processor | -- | 固定路径 `require('../../image-processor.node')` |
| ripgrep | -- | 通过平台目录约定定位 |

---

## 构建集成注意事项

在 `build.mjs` 中，原生 `.node` 文件被标记为 external（不打包）：

```javascript
external: [
  '*.node',             // 所有原生 .node 插件
  'sharp',              // Sharp 使用原生绑定，运行时解析
  'modifiers-napi',     // 修饰键检测
  'audio-capture-napi', // 音频录制/播放
]
```

这确保了原生二进制文件不会被 esbuild 错误地内联，而是在运行时通过 `require()` 动态加载。
