# React 组件层次结构

本文档描述 Claude Code 的 React 组件架构，涵盖消息渲染、输入处理、配置界面和各种 UI 组件。

---

## 消息渲染系统

### Message.tsx (`src/components/Message.tsx`)

消息组件是 Claude Code 对话界面的核心渲染单元，负责根据消息类型分发到对应的子组件。

#### Props 定义

```typescript
type Props = {
  message: NormalizedUserMessage | AssistantMessage | AttachmentMessageType |
           SystemMessage | GroupedToolUseMessageType | CollapsedReadSearchGroupType
  lookups: ReturnType<typeof buildMessageLookups>
  containerWidth?: number       // 容器绝对宽度，消除外层 Box 包裹
  addMargin: boolean
  tools: Tools
  commands: Command[]
  verbose: boolean
  inProgressToolUseIDs: Set<string>
  progressMessagesForMessage: ProgressMessage[]
  shouldAnimate: boolean        // 是否播放动画效果
  shouldShowDot: boolean        // 是否显示活动指示点
  style?: 'condensed'           // 紧凑模式
  width?: number | string
  isTranscriptMode: boolean     // 转录模式（隐藏过时的 thinking）
  isStatic: boolean
  onOpenRateLimitOptions?: () => void
  isActiveCollapsedGroup?: boolean
  isUserContinuation?: boolean  // 用户连续消息合并
  lastThinkingBlockId?: string | null
  latestBashOutputUUID?: string | null
}
```

#### 消息类型分发

`Message` 组件根据 `message.type` 和 content block 类型路由到不同的子组件：

**Assistant 消息内容块：**

| Content Block 类型 | 渲染组件 | 说明 |
|---------------------|----------|------|
| `text` | `AssistantTextMessage` | 助手文本回复（Markdown 渲染） |
| `thinking` | `AssistantThinkingMessage` | 思考过程展示 |
| `redacted_thinking` | `AssistantRedactedThinkingMessage` | 已编辑的思考内容 |
| `tool_use` | `AssistantToolUseMessage` | 工具调用展示 |
| `advisor` (AdvisorBlock) | `AdvisorMessage` | 顾问消息 |
| `connector_text` | 特殊处理 | 连接器文本 |

**User 消息类型：**

| 消息类型 | 渲染组件 | 说明 |
|----------|----------|------|
| `text` | `UserTextMessage` | 用户文本输入 |
| `image` | `UserImageMessage` | 图片附件 |
| `tool_result` | `UserToolResultMessage` | 工具执行结果 |

**其他消息类型：**

| 消息类型 | 渲染组件 | 说明 |
|----------|----------|------|
| `system` | `SystemTextMessage` | 系统通知消息 |
| `attachment` | `AttachmentMessage` | 文件附件 |
| `grouped_tool_use` | `GroupedToolUseContent` | 分组的工具调用 |
| `collapsed_read_search` | `CollapsedReadSearchContent` | 折叠的读取/搜索内容 |
| `compact_summary` | `CompactSummary` | 压缩摘要 |
| `compact_boundary` | `CompactBoundaryMessage` | 压缩边界标记 |

### 消息子组件详解

#### AssistantTextMessage (`src/components/messages/AssistantTextMessage.tsx`)

渲染助手的文本回复，使用 Markdown 组件进行富文本渲染。

#### AssistantThinkingMessage (`src/components/messages/AssistantThinkingMessage.tsx`)

展示模型的思考过程。支持折叠/展开，在 transcript 模式下根据 `lastThinkingBlockId` 控制可见性。包含 `HighlightedThinkingText` 子组件进行语法高亮。

#### AssistantToolUseMessage (`src/components/messages/AssistantToolUseMessage.tsx`)

展示工具调用的参数和进度。每个工具类型都有专用的 `UI.tsx` 渲染组件（如 `BashTool/UI.tsx`, `FileEditTool/UI.tsx` 等）。

#### UserToolResultMessage (`src/components/messages/UserToolResultMessage/`)

工具结果渲染系统，包含以下子组件：

| 组件 | 说明 |
|------|------|
| `UserToolSuccessMessage` | 成功结果 |
| `UserToolErrorMessage` | 错误结果 |
| `UserToolRejectMessage` | 用户拒绝 |
| `UserToolCanceledMessage` | 取消执行 |
| `RejectedToolUseMessage` | 被拒绝的工具使用 |
| `RejectedPlanMessage` | 被拒绝的计划 |

### Messages.tsx (`src/components/Messages.tsx`)

消息列表容器，管理所有消息的渲染、虚拟滚动和可见性。

### MessageRow.tsx (`src/components/MessageRow.tsx`)

单条消息的行级布局容器。

### MessageResponse.tsx (`src/components/MessageResponse.tsx`)

助手回复的聚合渲染组件。

---

## 输入系统

### PromptInput (`src/components/PromptInput/PromptInput.tsx`)

主输入组件，是 Claude Code 中最复杂的组件之一。

#### 核心功能

- **文本编辑**：多行文本输入，支持光标移动、选择、复制粘贴
- **Slash 命令检测**：输入 `/` 触发命令自动补全（typeahead）
- **模型切换**：通过 `/model` 命令或快捷键切换模型
- **Vim 模式**：完整的 vim 键绑定支持（normal/insert/visual 模式）
- **命令队列**：管理排队的命令执行
- **Footer 信息栏**：显示模型、费用、权限模式等状态
- **通知系统**：显示系统通知和状态消息
- **图片粘贴**：支持从剪贴板粘贴图片
- **历史记录**：上下箭头浏览输入历史
- **@ 提及**：文件路径自动补全
- **权限模式切换**：在 plan/auto/normal 模式间切换
- **快捷键**：Ctrl+C 中断、Escape 取消、Ctrl+J 换行等
- **IDE 集成**：接收来自 IDE 扩展的 @ 提及

#### 子组件

| 组件 | 文件 | 说明 |
|------|------|------|
| `PromptInputFooter` | `PromptInputFooter.tsx` | 底部信息栏 |
| `PromptInputFooterLeftSide` | `PromptInputFooterLeftSide.tsx` | 底部栏左侧内容 |

#### 关键 Hooks 使用

- `useInputBuffer()` — 输入缓冲区管理
- `useTypeahead()` — 自动补全逻辑
- `useArrowKeyHistory()` — 历史记录导航
- `useHistorySearch()` — 历史搜索（Ctrl+R）
- `useCommandQueue()` — 命令队列
- `useMainLoopModel()` — 当前模型信息
- `usePromptSuggestion()` — 提示建议
- `useTerminalSize()` — 终端尺寸适配
- `useKeybinding()` / `useKeybindings()` — 快捷键绑定
- `useNotifications()` — 通知管理

### TextInput (`src/components/TextInput.tsx`)

基础文本输入组件，提供单行/多行编辑能力。

### BaseTextInput (`src/components/BaseTextInput.tsx`)

底层文本输入实现，处理字符输入、光标定位和选区管理。

---

## 配置界面

### Settings (`src/components/Settings/Settings.tsx`)

设置界面入口组件，管理设置面板的导航和布局。

### Config.tsx (`src/components/Settings/Config.tsx`)

全面的配置 UI 组件，提供可视化的设置编辑界面。

#### 配置分类

- **模型设置**：选择默认模型、配置模型别名
- **权限管理**：allow/deny/ask 规则的可视化编辑
- **沙箱配置**：sandbox 模式设置
- **Hooks 配置**：PreToolUse/PostToolUse/Stop 等钩子管理
- **环境变量**：自定义环境变量设置
- **MCP 服务器**：MCP server 配置和允许列表
- **Plugin 管理**：启用/禁用 plugin
- **Auto 模式**：自动执行模式配置

### Usage (`src/components/Settings/Usage.tsx`)

使用量和费用展示组件。

### Status (`src/components/Settings/Status.tsx`)

系统状态展示组件。

---

## 欢迎与引导

### LogoV2 (`src/components/LogoV2/LogoV2.tsx`)

动画欢迎屏幕组件。

**功能：**
- 品牌 logo 动画渲染
- Release notes 展示（`ChannelsNotice.tsx`）
- 首次使用引导
- 版本更新提示

### Onboarding (`src/components/Onboarding.tsx`)

新用户引导流程组件。

---

## 权限系统 UI

### PermissionRequest (`src/components/permissions/`)

工具权限提示组件系统，当工具需要用户授权时显示。

#### 核心组件

| 组件 | 说明 |
|------|------|
| `AskUserQuestionPermissionRequest` | 通用用户确认对话框 |
| `PreviewQuestionView` | 问题预览视图 |
| `QuestionView` | 问题展示和回答视图 |

#### 权限操作

- **Approve (y)**：允许本次执行
- **Deny (n)**：拒绝本次执行
- **Always Allow**：永久允许此操作
- **Auto Mode**：进入自动模式，跳过后续相同类型的确认

### 权限规则编辑

| 组件 | 说明 |
|------|------|
| `AddWorkspaceDirectory` | 添加工作区目录权限 |
| `ManagedSettingsSecurityDialog` | 托管设置安全对话框 |

---

## 状态展示组件

### StatusLine (`src/components/StatusLine.tsx`)

状态栏组件，位于界面顶部或底部。

**展示内容：**
- Claude Code 版本号
- 当前模型名称和别名
- 累计 API 调用费用
- 权限模式（plan/auto/default）
- Fast mode 状态
- 上下文窗口使用比例

### TokenWarning

上下文窗口使用量警告组件。当 token 使用量接近限制时显示警告，建议用户使用 `/compact` 命令压缩上下文。

### StatusNotices (`src/components/StatusNotices.tsx`)

状态通知组件，显示各种系统级别的通知消息（如沙箱激活、连接状态等）。

---

## 更新系统

### AutoUpdater (`src/components/AutoUpdater.tsx`)

自动更新 UI 组件，处理 Claude Code 版本更新的检测和安装流程。

### AutoUpdaterWrapper (`src/components/AutoUpdaterWrapper.tsx`)

自动更新器的包装组件，管理更新状态和条件渲染。

### NativeAutoUpdater (`src/components/NativeAutoUpdater.tsx`)

原生更新器组件（系统级安装包更新）。

### PackageManagerAutoUpdater (`src/components/PackageManagerAutoUpdater.tsx`)

包管理器更新 UI，支持 npm/yarn/pnpm 等包管理器的版本更新。

---

## 反馈收集

### FeedbackSurvey (`src/components/FeedbackSurvey/FeedbackSurvey.tsx`)

用户反馈收集组件系统。

#### 子组件

| 组件 | 说明 |
|------|------|
| `useFeedbackSurvey` | 反馈调查 hook |
| `useMemorySurvey` | 记忆功能反馈调查 |
| `usePostCompactSurvey` | 压缩后反馈调查 |
| `TranscriptSharePrompt` | 对话记录分享提示 |

---

## 代码差异可视化

### StructuredDiff / DiffDetailView (`src/components/diff/DiffDetailView.tsx`)

代码差异可视化组件系统。

**功能：**
- 行级差异对比（add/remove/modify）
- 语法高亮 (`HighlightedCode`)
- colorDiff 着色方案
- 全屏差异详情视图

### FileEditToolDiff (`src/components/FileEditToolDiff.tsx`)

文件编辑工具的差异展示组件，展示工具执行前后的文件变化。

### FileEditToolUpdatedMessage (`src/components/FileEditToolUpdatedMessage.tsx`)

文件更新成功消息组件。

---

## 对话框系统

### QuickOpenDialog (`src/components/QuickOpenDialog.tsx`)

快速打开对话框，支持文件搜索和命令面板功能。

### ExportDialog (`src/components/ExportDialog.tsx`)

导出对话框，支持将对话导出为不同格式。

### InvalidConfigDialog (`src/components/InvalidConfigDialog.tsx`)

无效配置警告对话框。

### IdleReturnDialog (`src/components/IdleReturnDialog.tsx`)

空闲返回对话框，长时间未操作后的重新连接提示。

### MCPServerApprovalDialog (`src/components/MCPServerApprovalDialog.tsx`)

MCP 服务器授权确认对话框。

### MCPServerMultiselectDialog (`src/components/MCPServerMultiselectDialog.tsx`)

MCP 服务器多选配置对话框。

### DevChannelsDialog (`src/components/DevChannelsDialog.tsx`)

开发频道配置对话框。

---

## Markdown 渲染

### Markdown (`src/components/Markdown.tsx`)

Markdown 渲染组件，将 Markdown 文本转换为终端可显示的格式。

**支持特性：**
- 标题（不同级别不同颜色）
- 代码块（语法高亮）
- 行内代码
- 列表（有序/无序）
- 链接（OSC 8 超链接）
- 粗体/斜体/删除线
- 表格
- 引用块

---

## 任务系统 UI (`src/components/tasks/`)

### BackgroundTasksDialog (`src/components/tasks/BackgroundTasksDialog.tsx`)

后台任务管理对话框，展示所有活跃的后台任务。

### BackgroundTask / BackgroundTaskStatus

单个后台任务的展示组件和状态组件。

### 任务详情对话框

| 组件 | 说明 |
|------|------|
| `AsyncAgentDetailDialog` | 异步 agent 任务详情 |
| `RemoteSessionDetailDialog` | 远程会话详情 |
| `ShellDetailDialog` | Shell 任务详情 |
| `InProcessTeammateDetailDialog` | 进程内队友任务详情 |
| `DreamDetailDialog` | Dream 任务详情 |

### 任务进度

| 组件 | 说明 |
|------|------|
| `RemoteSessionProgress` | 远程会话进度 |
| `ShellProgress` | Shell 任务进度 |
| `renderToolActivity` | 工具活动渲染函数 |

---

## 布局组件

### FullscreenLayout (`src/components/FullscreenLayout.tsx`)

全屏布局组件，管理 alt-screen 下的整体布局结构。

### App.tsx (`src/components/App.tsx`)

应用级根组件（非 Ink 的 App.tsx），管理整体应用状态和路由。

---

## UI 基础组件 (`src/components/ui/`)

### TreeSelect (`src/components/ui/TreeSelect.tsx`)

树形选择器组件，用于层级数据的选择。

### OrderedList / OrderedListItem

有序列表及列表项组件。

---

## Shell 输出组件 (`src/components/shell/`)

### OutputLine (`src/components/shell/OutputLine.tsx`)

Shell 输出的单行渲染组件。

### ShellProgressMessage (`src/components/shell/ShellProgressMessage.tsx`)

Shell 命令执行进度消息组件。

### ShellTimeDisplay (`src/components/shell/ShellTimeDisplay.tsx`)

Shell 命令执行时间展示组件。

### ExpandShellOutputContext (`src/components/shell/ExpandShellOutputContext.tsx`)

Shell 输出展开/折叠的 context provider。

---

## 其他组件

| 组件 | 说明 |
|------|------|
| `ApproveApiKey` | API key 审批组件 |
| `BashModeProgress` | Bash 模式执行进度 |
| `ClaudeInChromeOnboarding` | Chrome 集成引导 |
| `CompactSummary` | 压缩摘要展示 |
| `HighlightedCode` | 代码语法高亮 |
| `LanguagePicker` | 语言选择器 |
| `OutputStylePicker` | 输出样式选择器 |
| `SandboxViolationExpandedView` | 沙箱违规详情 |
| `TagTabs` | 标签页导航 |
| `ClaudeMdExternalIncludesDialog` | CLAUDE.md 外部引用配置 |
| `messageActions` | 消息操作菜单 |
| `LspRecommendationMenu` | LSP 推荐菜单 |
| `MemoryFileSelector` | 记忆文件选择器 |
| `MemoryUpdateNotification` | 记忆更新通知 |
| `PluginHintMenu` | Plugin 提示菜单 |
