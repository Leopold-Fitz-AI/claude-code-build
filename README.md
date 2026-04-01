# Claude Code Source Build

![](https://img.shields.io/badge/版本-2.1.88-blue?style=flat-square) ![](https://img.shields.io/badge/Node.js-18%2B-brightgreen?style=flat-square) ![](https://img.shields.io/badge/构建-esbuild-yellow?style=flat-square)

> Claude Code v2.1.88 完整源码 + esbuild 构建管线 + 中文文档
>
> Full source code of Claude Code v2.1.88 with an esbuild build pipeline and comprehensive Chinese documentation.

## 特性 / Features

- **完整 TypeScript 源码** — 包含 43+ 工具、104 个命令、147 个 React 组件的全部实现
- **esbuild 构建管线** — 替代内部 Bun 构建，支持 `--minify`、`--sourcemap` 等选项
- **全中文文档** — 20 篇覆盖架构、工具系统、服务层、SDK 等的详细中文文档（见 [`docs/`](docs/)）
- **原生模块** — 内置 ripgrep、audio-capture、image-processor 等 vendor 二进制

## 项目结构 / Project Structure

```
claude-code-build/
├── src/                 # TypeScript 源码
│   ├── entrypoints/     #   入口点（CLI、MCP、SDK）
│   ├── main.tsx         #   主应用逻辑
│   ├── query.ts         #   核心查询循环
│   ├── tools/           #   43+ 工具实现
│   ├── commands/        #   104 个命令
│   ├── components/      #   147 个 React 组件
│   ├── services/        #   服务层（API、MCP、分析）
│   ├── hooks/           #   85+ React Hooks
│   └── ...
├── docs/                # 中文文档（架构、工具、服务、SDK、构建）
├── vendor/              # 原生依赖（ripgrep 等）
├── build.mjs            # esbuild 构建脚本
├── cli.js               # 构建产物（~13MB 单文件 bundle）
├── sdk-tools.d.ts       # SDK TypeScript 类型定义
└── package.json
```

## 快速开始 / Quick Start

### 环境要求

- Node.js >= 18.0.0
- esbuild（通过 npm 安装）

### 从源码构建

```bash
# 克隆仓库
git clone https://github.com/Leopold-Fitz-AI/claude-code-build.git
cd claude-code-build

# 安装 esbuild
npm install esbuild

# 构建
node build.mjs
```

### 运行

```bash
# 直接运行构建产物
node cli.js

# 或全局链接后使用
npm link
claude
```

## 构建选项 / Build Options

| 命令 | 说明 |
|------|------|
| `node build.mjs` | 默认构建，输出 `cli.built.js` |
| `node build.mjs --minify` | 压缩输出（~10MB） |
| `node build.mjs --sourcemap` | 生成 source map |
| `node build.mjs --outfile=out.js` | 自定义输出文件名 |

## 文档 / Documentation

完整中文文档位于 [`docs/`](docs/) 目录：

| 模块 | 内容 |
|------|------|
| [架构](docs/architecture/) | 系统架构、启动流程、查询循环、状态管理、数据流 |
| [工具系统](docs/tools/) | 工具架构、核心工具、Agent 工具、网络工具、权限系统 |
| [服务层](docs/services/) | API 服务、MCP 协议、分析系统、Hooks 事件 |
| [UI](docs/ui/) | Ink 渲染引擎、React 组件、Skills 与 Commands |
| [工具模块](docs/utils/) | 配置系统、认证、模型选择、插件 |
| [SDK](docs/sdk/) | SDK API、控制协议、原生模块 |
| [构建](docs/build/) | 构建系统详解 |

## 技术栈 / Tech Stack

| 层级 | 技术 | 用途 |
|------|------|------|
| 运行时 | Node.js 18+ | 执行环境 |
| 语言 | TypeScript (TSX) | 类型安全的源码 |
| UI 框架 | React + Ink | 终端 UI 渲染 |
| CLI 框架 | Commander.js | 命令行参数解析 |
| 状态管理 | Zustand | 响应式状态 |
| 构建工具 | esbuild | 快速单文件打包 |
| 类型校验 | Zod v4 | 运行时 Schema 校验 |
| API 客户端 | @anthropic-ai/sdk | Anthropic API 调用 |
| 搜索引擎 | ripgrep | 快速文件内容搜索 |
| 扩展协议 | MCP | 第三方工具集成 |

## 许可证 / License

Copyright Anthropic PBC. All rights reserved.
详见 [LICENSE.md](LICENSE.md) | [Legal](https://code.claude.com/docs/en/legal-and-compliance)

## 相关链接 / Links

- [Claude Code 官方仓库](https://github.com/anthropics/claude-code) — 上游官方项目
- [Claude Code 官方文档](https://code.claude.com/docs/en/overview) — 英文使用文档
- [Claude Code 主页](https://claude.com/product/claude-code) — 产品介绍
- [Claude Developers Discord](https://anthropic.com/discord) — 开发者社区
