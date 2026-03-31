# Claude Code v2.1.88 源码文档

本文档详细记录了 Claude Code 的完整架构设计、代码实现和系统原理。

## 目录结构

```
docs/
├── README.md                    # 本文件 - 文档总览
├── architecture/                # 系统架构
│   ├── overview.md              # 架构总览与生命周期
│   ├── startup-flow.md          # 启动流程详解
│   ├── query-loop.md            # 查询循环与对话机制
│   ├── state-management.md      # 状态管理系统
│   └── data-flow.md             # 数据流与模块关系
├── tools/                       # 工具系统
│   ├── overview.md              # 工具架构与注册机制
│   ├── core-tools.md            # 核心工具（文件、搜索、Shell）
│   ├── agent-tools.md           # Agent 与多智能体工具
│   ├── web-tools.md             # 网络工具（WebFetch、WebSearch）
│   └── permission-system.md     # 权限系统详解
├── services/                    # 服务层
│   ├── api-service.md           # API 服务（Anthropic/Bedrock/Vertex）
│   ├── mcp-system.md            # MCP 协议系统
│   ├── analytics.md             # 分析与特性标志
│   └── hooks-system.md          # Hooks 事件系统
├── ui/                          # 用户界面
│   ├── ink-renderer.md          # Ink 终端渲染引擎
│   ├── components.md            # React 组件体系
│   └── skills-commands.md       # Skills 与 Commands
├── utils/                       # 工具模块
│   ├── settings-config.md       # 设置与配置系统
│   ├── auth.md                  # 认证系统
│   ├── model-selection.md       # 模型选择与管理
│   └── plugins.md               # 插件系统
├── sdk/                         # SDK 与扩展
│   ├── sdk-api.md               # SDK 公开 API
│   ├── control-protocol.md      # SDK 控制协议
│   └── vendor-native.md         # 原生模块与 Vendor
└── build/
    └── build-system.md          # 构建系统详解
```

## 项目概况

| 属性 | 值 |
|------|-----|
| 包名 | `@anthropic-ai/claude-code` |
| 版本 | 2.1.88 |
| 运行时 | Node.js >= 18.0.0 |
| 模块格式 | ESM |
| UI 框架 | React + Ink（终端 UI）|
| 构建工具 | esbuild（原始为 Bun）|
| 状态管理 | Zustand |
| 类型校验 | Zod v4 |
| CLI 框架 | Commander.js |

## 源码目录结构

```
src/
├── entrypoints/         # 入口点（CLI、MCP、SDK）
├── main.tsx             # 主应用逻辑（Commander 定义、REPL 启动）
├── query.ts             # 核心查询循环
├── QueryEngine.ts       # 查询引擎类
├── Tool.ts              # 工具基础接口
├── Task.ts              # 任务类型定义
├── tools.ts             # 工具注册与组装
├── commands.ts          # 命令注册中心
├── context.ts           # 上下文管理
├── setup.ts             # 会话初始化
├── cost-tracker.ts      # 费用跟踪
├── history.ts           # 对话历史
├── tools/               # 工具实现（43+ 目录）
├── services/            # 服务层（API、MCP、分析）
├── components/          # UI 组件
├── ink/                 # Ink 渲染引擎
├── state/               # 状态管理
├── hooks/               # React Hooks（85+）
├── skills/              # 技能系统
├── plugins/             # 插件系统
├── utils/               # 工具函数
├── types/               # 类型定义
├── constants/           # 常量
├── bootstrap/           # 引导状态
├── bridge/              # 远程桥接
├── remote/              # 远程会话
├── server/              # 服务端组件
├── migrations/          # 数据迁移
├── schemas/             # Schema 定义
├── vim/                 # Vim 模式
├── voice/               # 语音功能
└── keybindings/         # 键绑定
```
