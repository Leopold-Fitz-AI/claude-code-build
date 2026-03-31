# Ink 终端渲染引擎

本文档详细介绍 Claude Code 的终端 UI 渲染系统。该系统基于自定义 fork 的 Ink 框架构建，使用 React reconciler 将 React 组件树渲染到终端。

## 核心架构概览

渲染管线的整体流程为：

```
React 组件树 → React Reconciler → Ink DOM 树 → Yoga 布局计算 → Screen Buffer → ANSI 序列 → 终端输出
```

---

## Ink 类 (`src/ink/ink.tsx`)

`Ink` 是整个渲染系统的核心类，管理 React fiber tree 到终端输出的完整生命周期。

### 核心属性

| 属性 | 类型 | 说明 |
|------|------|------|
| `container` | `FiberRoot` | React reconciler 的 fiber root，通过 `reconciler.createContainer()` 创建，使用 `ConcurrentRoot` 模式 |
| `renderer` | `Renderer` | 由 `createRenderer()` 创建的渲染器函数，负责将 DOM 树转换为 Screen buffer |
| `selection` | `SelectionState` | 文本选择状态（仅 alt-screen 模式使用） |
| `terminal` | `Terminal` | 终端 I/O 接口，包含 `stdout` 和 `stderr` |
| `stylePool` | `StylePool` | 样式对象池，用于 cell 级样式的内存复用 |
| `charPool` | `CharPool` | 字符对象池，用于 tokenize 和 grapheme 聚类缓存 |
| `hyperlinkPool` | `HyperlinkPool` | OSC 8 超链接对象池 |
| `focusManager` | `FocusManager` | 焦点管理器，处理 tab 导航和焦点分发 |
| `rootNode` | `DOMElement` | Ink DOM 树的根节点（`ink-root`） |

### 核心方法

#### `render(node: ReactNode)`

将 React 节点渲染到终端。内部调用 `reconciler.updateContainer()` 更新 fiber tree，并将当前节点包裹在 `App` 组件中，提供必要的 context（终端尺寸、stdin、selection 等）。

#### `onRender()`

渲染管线的主执行入口，在每帧被调度执行。核心流程：

1. 调用 `renderer()` 将 DOM 树渲染为 `Frame`（包含 Screen buffer + cursor + viewport）
2. 调用 `LogUpdate.render()` 对比前后帧差异，生成 `Patch[]`
3. 调用 `optimize()` 合并/去重 patch
4. 应用 selection overlay 和 search highlight
5. 调用 `writeDiffToTerminal()` 将 patch 序列化为 ANSI 序列并写入 stdout

#### `unmount()`

卸载 React 树并清理终端状态。包括：
- 退出 alt-screen（如果激活）
- 禁用鼠标追踪
- 恢复 console.log/stderr patch
- 释放 Yoga node 内存

#### `onInput(input: string, key: ParsedKey)`

处理终端输入事件，分发到 React 组件树中的事件处理器。

#### `getSelectedText(): string`

获取当前文本选择的内容，包括已滚出视口的 `scrolledOffAbove` 和 `scrolledOffBelow` 文本。

### 构造函数流程

```typescript
constructor(options: Options) {
  // 1. 初始化终端 I/O
  this.terminal = { stdout, stderr }

  // 2. 创建对象池
  this.stylePool = new StylePool()
  this.charPool = new CharPool()
  this.hyperlinkPool = new HyperlinkPool()

  // 3. 初始化前后帧缓冲区
  this.frontFrame = emptyFrame(...)
  this.backFrame = emptyFrame(...)

  // 4. 创建 LogUpdate 实例（负责 screen diff）
  this.log = new LogUpdate({ isTTY, stylePool })

  // 5. 设置渲染调度（throttle + microtask）
  this.scheduleRender = throttle(deferredRender, FRAME_INTERVAL_MS)

  // 6. 创建 DOM 根节点和 FocusManager
  this.rootNode = dom.createNode('ink-root')
  this.focusManager = new FocusManager(...)

  // 7. 创建 React reconciler container (ConcurrentRoot)
  this.container = reconciler.createContainer(this.rootNode, ConcurrentRoot, ...)
}
```

---

## 帧管理：前后缓冲区模式 (Front/Back Buffer Pattern)

Ink 使用双缓冲区技术避免渲染闪烁：

### Frame 类型 (`src/ink/frame.ts`)

```typescript
type Frame = {
  readonly screen: Screen      // 屏幕像素缓冲区（cell 数组）
  readonly viewport: Size      // 视口尺寸 { width, height }
  readonly cursor: Cursor      // 光标位置 { x, y, visible }
  readonly scrollHint?: ScrollHint | null  // DECSTBM 滚动优化提示
  readonly scrollDrainPending?: boolean    // ScrollBox 是否有待处理的滚动增量
}
```

### 双缓冲工作流

1. **Back buffer**：当前帧渲染目标。`renderer()` 将 DOM 树渲染到 `backFrame.screen`
2. **Front buffer**：上一帧的渲染结果。`LogUpdate.render()` 将 `backFrame` 与 `frontFrame` 进行 cell 级 diff
3. **交换**：渲染完成后，前后缓冲区交换角色

### FrameEvent 性能指标

```typescript
type FrameEvent = {
  durationMs: number
  phases?: {
    renderer: number    // DOM → Yoga layout → Screen buffer
    diff: number        // Screen diff → Patch[]
    optimize: number    // Patch merge/dedupe
    write: number       // ANSI 序列化 → stdout
    yoga: number        // calculateLayout() 耗时
    commit: number      // React reconcile 耗时
    yogaVisited: number // layoutNode() 调用次数
    yogaMeasured: number // measureFunc 调用次数（文本换行/宽度计算）
    yogaCacheHits: number // 单槽缓存命中数
    yogaLive: number     // 活跃 Yoga Node 实例数
  }
}
```

### Patch 类型

```typescript
type Patch =
  | { type: 'stdout'; content: string }   // ANSI 输出内容
  | { type: 'clear'; count: number }       // 清除行
  | { type: 'clearTerminal'; reason: FlickerReason; ... }  // 全屏清除
```

---

## Yoga Layout 引擎 (WASM)

Claude Code 使用 Yoga layout 引擎（Facebook 开源的 flexbox 实现）在终端中实现 flex 布局。

### 关键文件

- `src/ink/layout/yoga.ts`：Yoga WASM 绑定
- `src/ink/layout/engine.ts`：布局引擎封装
- `src/ink/layout/node.ts`：LayoutNode 类型定义
- `src/ink/layout/geometry.ts`：几何计算工具

### 布局计算流程

1. 每个 `DOMElement` 持有一个 `yogaNode`（`LayoutNode` 类型）
2. React reconciler 在 `resetAfterCommit` 回调中触发 `onComputeLayout()`
3. `rootNode.yogaNode.setWidth(terminalColumns)` 设置根节点宽度
4. `rootNode.yogaNode.calculateLayout(terminalColumns)` 递归计算整棵树的布局
5. 渲染器通过 `yogaNode.getComputedTop()`, `getComputedLeft()`, `getComputedWidth()`, `getComputedHeight()` 读取计算结果

### 性能优化

- **单槽缓存**（`_hasL` cache）：避免重复计算未变化的节点
- **脏标记传播**：`markDirty()` 仅标记发生变化的子树
- **布局偏移检测**：`layoutShifted` 标志判断是否需要全量重绘，稳态帧（spinner、clock）不触发

---

## React Reconciler (`src/ink/reconciler.ts`)

自定义 React reconciler 将 React fiber tree 桥接到 Ink DOM 节点。

### Host Config 配置

reconciler 使用 `createReconciler<ElementNames, Props, DOMElement, ...>` 创建，类型参数包括：

- `ElementNames`：元素名称类型（`ink-root` | `ink-box` | `ink-text` | `ink-virtual-text` | `ink-link` | `ink-progress` | `ink-raw-ansi`）
- `Props`：`Record<string, unknown>`
- `DOMElement` / `TextNode`：自定义 DOM 节点类型
- `HostContext`：`{ isInsideText: boolean }`

### 关键回调实现

| 回调 | 功能 |
|------|------|
| `getRootHostContext()` | 返回 `{ isInsideText: false }` |
| `createInstance(type, props)` | 创建 `DOMElement`，应用 style、绑定事件处理器，分配 Yoga node |
| `createTextInstance(text)` | 创建 `TextNode`，设置文本值和测量函数 |
| `appendChildNode(parent, child)` | 将子节点附加到父节点的 `childNodes` |
| `removeChildNode(parent, child)` | 从父节点移除子节点，释放 Yoga node |
| `commitUpdate(node, type, prevProps, nextProps)` | 对比 props 差异，仅更新变化的属性 |
| `resetAfterCommit(rootNode)` | 触发 `onComputeLayout()` 执行 Yoga 布局，然后调度渲染 |
| `prepareForCommit()` | 记录 commit 开始时间（性能分析） |

### Props Diffing

```typescript
const diff = (before: AnyObject, after: AnyObject): AnyObject | undefined => {
  // 浅比较：仅对比顶层 key 的引用相等性
  // 返回变化的属性集合，undefined 表示无变化
}
```

### 事件处理器注册

事件处理器通过 `EVENT_HANDLER_PROPS` 集合识别，存储在 `node._eventHandlers` 中而非 `attributes` 中。这确保了事件处理器的 identity 变化不会标记节点为 dirty，避免不必要的重绘。

```typescript
function applyProp(node: DOMElement, key: string, value: unknown): void {
  if (key === 'style') { setStyle(node, value); applyStyles(node.yogaNode, value); return }
  if (key === 'textStyles') { node.textStyles = value; return }
  if (EVENT_HANDLER_PROPS.has(key)) { setEventHandler(node, key, value); return }
  setAttribute(node, key, value)
}
```

### Debug 功能

- `CLAUDE_CODE_DEBUG_REPAINTS` 环境变量启用重绘调试
- `getOwnerChain(fiber)` 追踪组件拥有者链路
- `CLAUDE_CODE_COMMIT_LOG` 环境变量记录 commit 性能日志

---

## 渲染管线详解

### 完整管线：DOM tree → styled output → ANSI sequences → terminal

#### 阶段 1：DOM → Yoga 布局 → Screen Buffer (`renderer.ts`)

`createRenderer()` 返回一个 `Renderer` 函数，接收 `RenderOptions` 参数：

```typescript
type RenderOptions = {
  frontFrame: Frame         // 上一帧（用于 blit 优化）
  backFrame: Frame          // 当前帧目标
  isTTY: boolean
  terminalWidth: number
  terminalRows: number
  altScreen: boolean
  prevFrameContaminated: boolean  // 上一帧是否被 selection overlay 污染
}
```

核心流程：
1. 检查 Yoga node 有效性（`getComputedHeight/Width` 非 NaN/负数/Infinity）
2. `renderNodeToOutput()` 递归遍历 DOM 树，将每个节点的文本内容写入 `Output` 对象
3. `Output` 将文本写入 `Screen` buffer（cell 数组）

#### 阶段 2：Screen Diff → Patch[] (`log-update.ts`)

`LogUpdate.render()` 将新旧 Screen buffer 进行 cell 级差分比较：
- 逐行扫描，找出发生变化的行
- 对变化行生成最小化的 ANSI 移动+写入序列
- Alt-screen 模式支持 DECSTBM 硬件滚动优化

#### 阶段 3：Patch 优化 (`optimizer.ts`)

`optimize()` 合并相邻的同类型 patch，减少 write 调用次数。

#### 阶段 4：ANSI 序列化 → 终端 (`terminal.ts`)

`writeDiffToTerminal()` 将 Patch 数组序列化为 ANSI 转义序列，通过 `stdout.write()` 写入终端。支持 BSU/ESU (Begin/End Synchronized Update) 包裹，确保帧更新原子性。

### Blit 优化

稳态帧（没有布局偏移的帧）可以重用上一帧的大部分内容：
- `prevFrameContaminated` 标志指示上一帧的 Screen buffer 是否可信
- 当布局未偏移且前一帧未被污染时，仅更新实际变化的 cell（narrow damage）
- 代替全量重绘（O(rows x cols)），降低为 O(changed cells)

---

## DOM 元素 (`src/ink/dom.ts`)

### DOMElement 类型

```typescript
type DOMElement = {
  nodeName: ElementNames        // 'ink-root' | 'ink-box' | 'ink-text' | ...
  attributes: Record<string, DOMNodeAttribute>
  childNodes: DOMNode[]
  textStyles?: TextStyles       // 文本样式（颜色、粗体等）

  // 内部属性
  dirty: boolean                // 是否需要重新渲染
  isHidden?: boolean            // reconciler 的 hideInstance/unhideInstance
  _eventHandlers?: Record<string, unknown>  // 事件处理器（独立于 attributes）

  // 滚动状态 (overflow: 'scroll')
  scrollTop?: number            // 内容滚动偏移量
  pendingScrollDelta?: number   // 待处理的滚动增量（分帧消耗）
  scrollHeight?: number         // 内容总高度
  scrollViewportHeight?: number // 可见区域高度
  stickyScroll?: boolean        // 自动固定到底部
  scrollAnchor?: { el: DOMElement; offset: number }  // 单次锚定滚动

  // Layout
  yogaNode?: LayoutNode         // Yoga 布局节点
  style: Styles                 // CSS-like 样式
  parentNode: DOMElement | undefined

  // Debug
  debugOwnerChain?: string[]    // React 组件拥有者链（DEBUG_REPAINTS 模式）
  focusManager?: FocusManager   // 仅 ink-root 节点
} & InkNode
```

### TextNode 类型

```typescript
type TextNode = {
  nodeName: '#text'
  nodeValue: string
} & InkNode
```

### 元素名称

| 名称 | 对应组件 | 说明 |
|------|----------|------|
| `ink-root` | — | DOM 树根节点 |
| `ink-box` | `<Box>` | 布局容器（flexbox） |
| `ink-text` | `<Text>` | 文本节点容器 |
| `ink-virtual-text` | 内部使用 | 嵌套文本中的虚拟文本节点 |
| `ink-link` | `<Link>` | OSC 8 超链接 |
| `ink-progress` | — | 进度指示器 |
| `ink-raw-ansi` | `<RawAnsi>` | 原始 ANSI 序列透传 |

### DOM 操作函数

- `createNode(name)` — 创建元素节点并分配 Yoga node
- `createTextNode(text)` — 创建文本节点
- `appendChildNode(parent, child)` — 附加子节点
- `removeChildNode(parent, child)` — 移除子节点
- `insertBeforeNode(parent, child, beforeChild)` — 在指定节点前插入
- `setAttribute(node, key, value)` — 设置属性并标记 dirty
- `setStyle(node, style)` — 设置样式
- `setTextNodeValue(node, text)` — 更新文本内容
- `markDirty(node)` — 向上冒泡标记脏节点

---

## 文本选择系统 (`src/ink/selection.ts`)

文本选择功能仅在 alt-screen（全屏）模式下可用。

### SelectionState 类型

```typescript
type SelectionState = {
  anchor: Point | null          // 选择起点（mouse-down 位置）
  focus: Point | null           // 当前拖拽位置
  isDragging: boolean           // 是否正在拖拽
  anchorSpan: { lo: Point; hi: Point; kind: 'word' | 'line' } | null  // 词/行选择模式的初始范围
  scrolledOffAbove: string[]    // 已滚出视口上方的选中文本
  scrolledOffBelow: string[]    // 已滚出视口下方的选中文本
  scrolledOffAboveSW: boolean[] // 对应的 soft-wrap 标志
  scrolledOffBelowSW: boolean[] // 对应的 soft-wrap 标志
  virtualAnchorRow?: number     // 虚拟锚点行（shiftSelection clamp 补偿）
  virtualFocusRow?: number      // 虚拟焦点行
  lastPressHadAlt: boolean      // 鼠标按下时是否按住 Alt 键
}
```

### 选择操作

| 函数 | 说明 |
|------|------|
| `createSelectionState()` | 创建初始选择状态 |
| `startSelection(s, col, row)` | 开始新选择 |
| `extendSelection(s, col, row, screen)` | 扩展选择到新位置 |
| `moveFocus(s, move)` | 根据方向键移动焦点 |
| `clearSelection(s)` | 清除选择 |
| `hasSelection(s)` | 判断是否有活跃选择 |
| `getSelectedText(s, screen, ...)` | 提取选中文本内容 |
| `selectWordAt(s, col, row, screen)` | 双击选词 |
| `selectLineAt(s, col, row, screen)` | 三击选行 |
| `shiftSelection(s, delta, rows)` | 滚动时偏移选择区域 |
| `shiftSelectionForFollow(s, delta, screen)` | 跟随滚动时偏移 |
| `shiftAnchor(s, delta)` | 偏移锚点位置 |
| `captureScrolledRows(s, screen, ...)` | 捕获滚出的行到累积缓冲区 |

### 选择渲染流程

1. `App.tsx` 中的鼠标事件处理器更新 `SelectionState`
2. `onRender()` 中调用 `applySelectionOverlay()` 将选择区域的 cell 样式反转
3. 选择 overlay 会污染 Screen buffer，因此设置 `prevFrameContaminated = true`

### 搜索高亮

`searchHighlightQuery` 和 `searchPositions` 提供独立的高亮渲染：
- `applySearchHighlight()` 反转匹配 cell 的样式
- `applyPositionedHighlight()` 为位置化搜索结果着色（当前匹配为黄色）
- `scanPositions()` 扫描消息元素获取匹配位置

---

## 核心组件

### App.tsx (`src/ink/components/App.tsx`)

根组件，是所有 Ink 渲染内容的容器。作为 PureComponent 实现。

**职责：**
- 提供 context provider 栈：`AppContext`, `StdinContext`, `TerminalSizeContext`, `TerminalFocusProvider`, `ClockProvider`, `CursorDeclarationContext`
- 处理 stdin 输入解析（`parseMultipleKeypresses`）
- 分发鼠标事件（click、hover、selection drag、multi-click）
- 管理终端焦点状态检测
- 错误边界（`ErrorOverview`）
- 终端能力探测（`TerminalQuerier` for XTVERSION）
- 键盘模式管理（Kitty keyboard protocol, modifyOtherKeys）
- 进程挂起/恢复（SIGSTOP/SIGCONT）
- Stdin 静默间隙检测（5s 后重新断言终端模式）

### AlternateScreen (`src/ink/components/AlternateScreen.tsx`)

管理终端的 alt-screen buffer 切换。

**功能：**
- 进入/退出 alt-screen (`ENTER_ALT_SCREEN` / `EXIT_ALT_SCREEN`)
- 可选启用鼠标追踪 (`ENABLE_MOUSE_TRACKING`)
- 光标隐藏/显示管理
- SIGCONT 后自动恢复 alt-screen 状态

### Box (`src/ink/components/Box.tsx`)

Flexbox 布局容器，映射到 `ink-box` DOM 元素。

**支持的样式属性：** `flexDirection`, `flexGrow`, `flexShrink`, `flexBasis`, `alignItems`, `justifyContent`, `padding`, `margin`, `width`, `height`, `minWidth`, `minHeight`, `maxWidth`, `maxHeight`, `overflow`, `position`, `gap`, `borderStyle`, `borderColor` 等。

### Text (`src/ink/components/Text.tsx`)

文本渲染组件，映射到 `ink-text` DOM 元素。

**支持的样式属性：** `color`, `backgroundColor`, `bold`, `italic`, `underline`, `strikethrough`, `dimColor`, `inverse`, `wrap` 等。

### 其他组件

| 组件 | 文件 | 说明 |
|------|------|------|
| `Spacer` | `Spacer.tsx` | flex 弹性空间填充 |
| `Link` | `Link.tsx` | OSC 8 超链接渲染 |
| `Newline` | `Newline.tsx` | 换行符组件 |
| `ScrollBox` | `ScrollBox.tsx` | 可滚动容器（`overflow: 'scroll'`） |
| `Button` | `Button.tsx` | 可点击按钮（onClick 事件） |
| `RawAnsi` | `RawAnsi.tsx` | 原始 ANSI 序列透传 |
| `NoSelect` | `NoSelect.tsx` | 不可选择区域标记 |
| `ErrorOverview` | `ErrorOverview.tsx` | React 错误边界展示 |
| `ClockContext` | `ClockContext.tsx` | 全局时钟 context（定时器驱动重渲染） |
| `TerminalSizeContext` | `TerminalSizeContext.tsx` | 终端尺寸 context |
| `TerminalFocusContext` | `TerminalFocusContext.tsx` | 终端焦点状态 context |

---

## 辅助系统

### termio 子系统 (`src/ink/termio/`)

终端 I/O 低级协议处理：

| 文件 | 职责 |
|------|------|
| `ansi.ts` | ANSI 转义序列基础定义 |
| `csi.ts` | CSI (Control Sequence Introducer) 序列：光标移动、键盘模式、DECSTBM |
| `dec.ts` | DEC 私有模式：alt-screen、鼠标追踪、光标显隐 |
| `osc.ts` | OSC (Operating System Command)：剪贴板、tab 状态、iTerm2 进度 |
| `sgr.ts` | SGR (Select Graphic Rendition)：颜色和样式编码 |
| `esc.ts` | ESC 基础序列 |
| `parser.ts` | 终端输入解析器 |
| `tokenize.ts` | 输入数据分词 |
| `types.ts` | 类型定义 |

### 事件系统 (`src/ink/events/`)

| 文件 | 职责 |
|------|------|
| `dispatcher.ts` | 事件捕获/冒泡分发器（类浏览器模型） |
| `emitter.ts` | 事件发射器基类 |
| `event.ts` | 基础事件类型 |
| `keyboard-event.ts` | 键盘事件 |
| `input-event.ts` | 输入事件 |
| `click-event.ts` | 鼠标点击事件 |
| `focus-event.ts` | 焦点事件 |
| `terminal-focus-event.ts` | 终端获得/失去焦点事件 |
| `terminal-event.ts` | 终端通用事件 |
| `event-handlers.ts` | 支持的事件处理器 props 集合 |

### Hooks

| Hook | 文件 | 说明 |
|------|------|------|
| `useInput` | `use-input.ts` | 监听终端键盘输入 |
| `useStdin` | `use-stdin.ts` | 访问 stdin context |
| `useApp` | `use-app.ts` | 访问 App context（exit 等） |
| `useSelection` | `use-selection.ts` | 监听文本选择状态变化 |
| `useAnimationFrame` | `use-animation-frame.ts` | 动画帧回调 |
| `useDeclaredCursor` | `use-declared-cursor.ts` | 声明原生光标位置（IME/无障碍） |
| `useTerminalViewport` | `use-terminal-viewport.ts` | 终端视口信息 |
| `useInterval` | `use-interval.ts` | 定时器 hook |
| `useTerminalTitle` | `use-terminal-title.ts` | 设置终端标题 |
| `useTerminalFocus` | `use-terminal-focus.ts` | 监听终端获得/失去焦点 |
| `useSearchHighlight` | `use-search-highlight.ts` | 设置搜索高亮查询 |
| `useTabStatus` | `use-tab-status.ts` | 终端 tab 状态指示 |
