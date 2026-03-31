# Claude Code 核心工具详解

本文档详细描述所有核心工具的参数、行为、限制和实现细节。

---

## 1. FileReadTool (Read)

**名称**: `Read` | **文件**: `src/tools/FileReadTool/FileReadTool.ts`

读取本地文件系统上的文件，支持文本文件、图片、PDF 和 Jupyter Notebook。

### 输入参数

```typescript
z.strictObject({
  file_path: z.string(),    // 绝对路径（必须）
  offset: z.number(),       // 起始行号（可选）
  limit: z.number(),        // 读取行数（可选）
  pages: z.string(),        // PDF 页码范围，如 "1-5"（可选，仅 PDF）
})
```

### 输出限制

| 限制 | 默认值 | 说明 |
|------|--------|------|
| `maxSizeBytes` | 256 KB | 文件总大小限制（stat 检查，读取前） |
| `maxTokens` | 25,000 | 输出 token 数限制（API 估算，读取后） |
| `maxResultSizeChars` | `Infinity` | 永不持久化到磁盘（避免循环读取） |

限制优先级: 环境变量 `CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS` > GrowthBook > 默认值

### 支持的文件类型

- **文本文件**: 使用 `cat -n` 格式输出（带行号）
- **图片**: PNG, JPG, GIF, WEBP 等；自动调整大小和压缩
- **PDF**: 使用 `extractPDFPages()` 提取；大文件必须指定 `pages` 参数；每次最多 20 页
- **Jupyter Notebook** (`.ipynb`): 解析并展示所有 cell 及输出
- **二进制文件**: 通过扩展名检测，拒绝读取

### 安全机制

- 阻止读取危险设备路径 (`/dev/zero`, `/dev/random`, `/dev/stdin` 等)
- UNC 路径跳过文件系统操作（防止 NTLM 凭据泄露）
- deny 规则检查（权限设置中的路径排除）

### 工具特性

```typescript
isReadOnly: true
isConcurrencySafe: true
shouldDefer: false
```

---

## 2. FileEditTool (Edit)

**名称**: `Edit` | **文件**: `src/tools/FileEditTool/FileEditTool.ts`

原地编辑文件内容，支持精确字符串替换。

### 输入参数

```typescript
z.strictObject({
  file_path: z.string(),          // 绝对路径
  old_string: z.string(),         // 要替换的文本
  new_string: z.string(),         // 替换为的新文本（必须与 old_string 不同）
  replace_all: z.boolean(),       // 是否替换所有匹配（默认 false）
})
```

### 输入验证逻辑 (`validateInput`)

1. **团队内存秘密检查**: 拒绝在团队内存文件中引入秘密
2. **相同内容检查**: `old_string === new_string` 时拒绝
3. **deny 规则检查**: 路径是否在拒绝目录中
4. **文件存在性**: 不存在时提供相似文件建议
5. **空 old_string + 非空文件**: 拒绝（文件已存在无法创建）
6. **Notebook 文件检查**: `.ipynb` 文件引导使用 NotebookEditTool
7. **读取状态检查**: 文件必须先被读取（`readFileState` 中有记录）
8. **修改时间检查**: 文件自上次读取后是否被修改（Windows 还做内容比较兜底）
9. **字符串匹配**: 使用 `findActualString()` 处理引号规范化
10. **唯一性检查**: 多处匹配 + `replace_all=false` 时拒绝

### 原子操作流程

```
读取文件 → 检查过时 → 查找替换 → 写入磁盘 → 更新 readFileState → 通知 LSP → 通知 VSCode
```

- 写入使用 `writeTextContent()` 保持原编码和行尾符
- 更新后立即刷新 `readFileState` 时间戳，防止连续编辑的过时误报
- LSP 通知包括 `didChange` 和 `didSave`

### 输出

```typescript
type FileEditOutput = {
  filePath: string
  oldString: string
  newString: string
  originalFile: string
  structuredPatch: Hunk[]
  userModified: boolean
  replaceAll: boolean
  gitDiff?: ToolUseDiff
}
```

### 工具特性

```typescript
isReadOnly: false
isConcurrencySafe: false
strict: true
maxResultSizeChars: 100_000
```

---

## 3. FileWriteTool (Write)

**名称**: `Write` | **文件**: `src/tools/FileWriteTool/FileWriteTool.ts`

创建新文件或完全覆写已有文件。

### 输入参数

```typescript
z.strictObject({
  file_path: z.string(),    // 绝对路径
  content: z.string(),      // 写入内容
})
```

### 与 Edit 的区别

| 特性 | Edit | Write |
|------|------|-------|
| 操作方式 | 精确字符串替换 | 完全内容覆写 |
| 行尾符处理 | 保持文件原有行尾符 | 使用模型提供的行尾符（LF） |
| 部分更新 | 支持 | 不支持 |
| 创建新文件 | `old_string=''` + 新文件 | 直接创建 |

### 验证逻辑

- 团队内存秘密检查
- deny 规则检查
- 已有文件必须先读取
- 文件修改时间戳检查（防止覆盖外部修改）

### 输出

```typescript
type Output = {
  type: 'create' | 'update'
  filePath: string
  content: string
  structuredPatch: Hunk[]
  originalFile: string | null
  gitDiff?: ToolUseDiff
}
```

### 工具特性

```typescript
isReadOnly: false
isConcurrencySafe: false
strict: true
maxResultSizeChars: 100_000
```

---

## 4. NotebookEditTool

**名称**: `NotebookEdit` | **文件**: `src/tools/NotebookEditTool/NotebookEditTool.ts`

编辑 Jupyter Notebook (`.ipynb`) 文件的 cell。

### 输入参数

```typescript
z.strictObject({
  notebook_path: z.string(),           // Notebook 绝对路径
  cell_id: z.string().optional(),      // cell ID（插入时为插入位置之后的 cell）
  new_source: z.string(),              // 新的 cell 内容
  cell_type: z.enum(['code', 'markdown']).optional(),  // cell 类型
  edit_mode: z.enum(['replace', 'insert', 'delete']).optional(),  // 编辑模式（默认 replace）
})
```

### 编辑模式

| 模式 | 行为 |
|------|------|
| `replace` | 替换指定 cell 的内容 |
| `insert` | 在指定 cell 之后插入新 cell（未指定 cell_id 则在开头插入） |
| `delete` | 删除指定 cell |

### 工具特性

```typescript
isReadOnly: false
isConcurrencySafe: false
shouldDefer: true
```

---

## 5. GlobTool

**名称**: `Glob` | **文件**: `src/tools/GlobTool/GlobTool.ts`

快速文件模式匹配工具，基于 glob 模式搜索文件。

### 输入参数

```typescript
z.strictObject({
  pattern: z.string(),             // glob 模式（如 "**/*.ts"）
  path: z.string().optional(),     // 搜索目录（默认 cwd）
})
```

### 输出

```typescript
type Output = {
  durationMs: number        // 搜索耗时（毫秒）
  numFiles: number          // 找到的文件数
  filenames: string[]       // 匹配的文件路径列表（相对路径）
  truncated: boolean        // 结果是否被截断
}
```

### 限制

- 默认最多返回 100 个结果（通过 `globLimits.maxResults` 可配置）
- 结果按修改时间降序排列
- 路径转为相对路径以节省 token

### 工具特性

```typescript
isReadOnly: true
isConcurrencySafe: true
maxResultSizeChars: 100_000
```

---

## 6. GrepTool

**名称**: `Grep` | **文件**: `src/tools/GrepTool/GrepTool.ts`

基于 ripgrep 的内容搜索工具，支持正则表达式。

### 输入参数

```typescript
z.strictObject({
  pattern: z.string(),                  // 正则表达式模式
  path: z.string().optional(),          // 搜索路径（默认 cwd）
  glob: z.string().optional(),          // 文件过滤 glob（如 "*.js", "*.{ts,tsx}"）
  output_mode: z.enum([
    'content',               // 显示匹配行内容
    'files_with_matches',    // 仅显示文件路径（默认）
    'count',                 // 显示匹配计数
  ]).optional(),
  '-B': z.number().optional(),          // 匹配前的上下文行数
  '-A': z.number().optional(),          // 匹配后的上下文行数
  '-C': z.number().optional(),          // context 别名
  context: z.number().optional(),       // 匹配前后的上下文行数
  '-n': z.boolean().optional(),         // 显示行号（默认 true）
  '-i': z.boolean().optional(),         // 大小写不敏感
  type: z.string().optional(),          // 文件类型过滤（rg --type）
  head_limit: z.number().optional(),    // 结果限制（默认 250，0 = 无限）
  offset: z.number().optional(),        // 跳过前 N 条结果
  multiline: z.boolean().optional(),    // 多行模式（默认 false）
})
```

### 输出模式详解

| 模式 | 输出内容 | 排序 |
|------|----------|------|
| `files_with_matches` | 匹配文件路径列表 | 按修改时间降序 |
| `content` | 匹配行内容（带路径和行号） | 按 ripgrep 原始顺序 |
| `count` | 每文件匹配次数 (`file:count`) | 按 ripgrep 原始顺序 |

### 内部行为

- 自动排除版本控制目录: `.git`, `.svn`, `.hg`, `.bzr`, `.jj`, `.sl`
- 限制行长度为 500 字符（防止 base64/minified 内容）
- 启用 `--hidden` 搜索隐藏文件
- 应用 deny 规则中的忽略模式
- `head_limit` 默认为 250（`DEFAULT_HEAD_LIMIT`），防止上下文膨胀

### 工具特性

```typescript
isReadOnly: true
isConcurrencySafe: true
strict: true
maxResultSizeChars: 20_000
```

---

## 7. BashTool

**名称**: `Bash` | **文件**: `src/tools/BashTool/BashTool.tsx`

执行 Shell 命令，支持后台运行、超时控制和沙箱隔离。

### 输入参数

```typescript
z.strictObject({
  command: z.string(),                            // 要执行的命令
  timeout: z.number().optional(),                 // 超时（毫秒，最大可配）
  description: z.string().optional(),             // 命令描述（用户可见）
  run_in_background: z.boolean().optional(),      // 后台运行
  dangerouslyDisableSandbox: z.boolean().optional(), // 禁用沙箱
})
```

### 输出

```typescript
type Output = {
  stdout: z.string()
  stderr: z.string()
  rawOutputPath?: z.string()      // 大输出文件路径
  interrupted: z.boolean()
  isImage?: z.boolean()           // stdout 包含图片数据
}
```

### 安全机制

1. **AST 安全解析** (`bashSecurity.ts`): 使用 tree-sitter 解析命令 AST，检测危险模式
   - 命令替换: `$()`, `` ` ` ``, `<()`, `>()`
   - 参数扩展: `${}`
   - Zsh 特殊扩展: `=(cmd)`, `=cmd`
   - Heredoc 嵌套替换

2. **沙箱支持** (`shouldUseSandbox.ts`): 网络和文件系统隔离
   - `SandboxManager` 管理沙箱生命周期
   - `dangerouslyDisableSandbox` 可绕过（需权限）

3. **权限检查** (`bashPermissions.ts`):
   - 基于命令前缀的通配符模式匹配
   - Bash 分类器（classifier）自动评估安全性
   - 模式验证（`plan` 模式下限制写操作）

### 超时控制

| 参数 | 默认值 | 说明 |
|------|--------|------|
| 默认超时 | 30 秒 | 通过 `getDefaultTimeoutMs()` 获取 |
| 最大超时 | 可配置 | 通过 `getMaxTimeoutMs()` 获取 |
| 后台任务 | 无超时 | `run_in_background: true` 时 |

### 命令分类

工具内部将命令分为多类，用于 UI 折叠显示：

```typescript
BASH_SEARCH_COMMANDS = ['find', 'grep', 'rg', 'ag', 'ack', 'locate', ...]
BASH_READ_COMMANDS = ['cat', 'head', 'tail', 'wc', 'stat', 'jq', 'awk', ...]
BASH_LIST_COMMANDS = ['ls', 'tree', 'du']
BASH_SILENT_COMMANDS = ['mv', 'cp', 'rm', 'mkdir', 'chmod', ...]
```

### 工具特性

```typescript
isReadOnly: false  // 根据命令动态判断
isConcurrencySafe: false
maxResultSizeChars: 100_000
```

---

## 8. PowerShellTool

**名称**: `PowerShell` | **文件**: `src/tools/PowerShellTool/`

Windows 平台的 Shell 工具，行为类似 BashTool，但使用 PowerShell 语法。

### 特性

- 仅在 `isPowerShellToolEnabled()` 返回 true 时启用
- 共享 BashTool 的多数模式：权限检查、路径验证、只读验证、破坏性命令警告
- 文件结构: `commonParameters.ts`, `commandSemantics.ts`, `gitSafety.ts`, `pathValidation.ts`,
  `readOnlyValidation.ts`, `modeValidation.ts`, `powershellPermissions.ts`

---

## 9. SkillTool

**名称**: `Skill` | **文件**: `src/tools/SkillTool/SkillTool.ts`

执行技能（Skill），包括内置技能和插件技能。

### 输入参数

```typescript
z.object({
  skill: z.string(),              // 技能名称或路径
  args: z.string().optional(),    // 可选参数
})
```

### 技能来源

1. **内置命令**: 通过 `findCommand()` 查找已注册命令
2. **插件技能**: 来自 `.claude/skills/` 或 `~/.claude/skills/` 的 Markdown 文件
3. **Marketplace 技能**: 带 `@scope/name` 标识符的官方插件

### 执行流程

1. 查找命令 → 解析 frontmatter → 确定模型覆盖
2. 准备 fork 上下文 → 创建用户消息
3. 调用 `query()` 执行技能 prompt → 提取结果文本

### 权限

- 内置命令默认允许
- 插件技能需要权限检查
- 基于 `ruleContent` 匹配技能名称

### 工具特性

```typescript
isConcurrencySafe: false
shouldDefer: true  // 部分技能延迟加载
```

---

## 10. LSPTool

**名称**: `LSP` | **文件**: `src/tools/LSPTool/LSPTool.ts`

Language Server Protocol 工具，提供代码智能功能。

### 操作类型

通过 discriminated union schema 定义所有支持的 LSP 操作：

```typescript
// 操作公共参数
{
  operation: string       // 操作类型
  filePath: string        // 文件路径
  line: number            // 行号（1-based）
  character: number       // 列号（1-based）
}
```

| 操作 | 描述 |
|------|------|
| `goToDefinition` | 跳转到符号定义位置 |
| `findReferences` | 查找符号的所有引用 |
| `hover` | 获取悬停信息（文档、类型信息） |

### 启用条件

仅当设置 `ENABLE_LSP_TOOL=true` 时启用。

### 工具特性

```typescript
isReadOnly: true
isConcurrencySafe: true
isLsp: true
```

---

## 工具对比总览

| 工具 | 只读 | 并发安全 | 延迟加载 | 结果限制 |
|------|------|----------|----------|----------|
| FileReadTool | Yes | Yes | No | Infinity |
| FileEditTool | No | No | No | 100K |
| FileWriteTool | No | No | No | 100K |
| NotebookEditTool | No | No | Yes | 100K |
| GlobTool | Yes | Yes | No | 100K |
| GrepTool | Yes | Yes | No | 20K |
| BashTool | 动态 | No | No | 100K |
| SkillTool | 动态 | No | Yes | - |
| LSPTool | Yes | Yes | No | - |

---

## 相关文件路径

- FileReadTool: `/src/tools/FileReadTool/FileReadTool.ts`, `limits.ts`, `imageProcessor.ts`
- FileEditTool: `/src/tools/FileEditTool/FileEditTool.ts`, `types.ts`, `utils.ts`
- FileWriteTool: `/src/tools/FileWriteTool/FileWriteTool.ts`
- NotebookEditTool: `/src/tools/NotebookEditTool/NotebookEditTool.ts`
- GlobTool: `/src/tools/GlobTool/GlobTool.ts`
- GrepTool: `/src/tools/GrepTool/GrepTool.ts`
- BashTool: `/src/tools/BashTool/BashTool.tsx`, `bashSecurity.ts`, `bashPermissions.ts`
- PowerShellTool: `/src/tools/PowerShellTool/`
- SkillTool: `/src/tools/SkillTool/SkillTool.ts`
- LSPTool: `/src/tools/LSPTool/LSPTool.ts`, `schemas.ts`
