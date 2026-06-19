# CLAUDE.md

> 本文件为 Claude Code 提供项目上下文和开发指导。

# 项目核心指令 (CLAUDE.md)

## 1. 🛠️ Token 与动作约束 (严格遵守)
- **禁止大范围扫描：** 绝对不要去读取 `node_modules`, `dist`, `.git`, `build` 文件夹。
- **克制输出：** 在终端执行任何构建或测试命令时，必须将输出重定向 (`> temp.log`)。仅使用 `tail -n 30 temp.log` 或 `grep` 查看报错。禁止将几百行日志直接喷在控制台。
- **废话极简主义：** 不要向我解释基本概念。给我看改好的代码，并在代码块外用最多一两句话说明改了哪里。

## 2. 📦 技术栈与规范
- Node 版本: v22
- 核心框架: TypeScript + Next.js
- **首要原则：** 优先编写小巧独立的模块，拒绝大单体文件。类型优先于接口 (Prefer types over interfaces)。

## 3. ✅ 任务收尾流程 (每次修改完毕必须执行)
1. 运行 `npm run lint`，如果报错，你自己想办法修复，不要抛给我。
2. 运行 `npm run type-check`，确保 TypeScript 没有红线。
3. 如果引入了新的包，务必检查是否破坏了现有的锁文件 (lockfile)。

## 4. 📚 知识索引
- 如果你需要修改数据库，请先阅读 `docs/DB_SCHEMA.md`。
- 如果你需要添加新的 UI 组件，请查阅 `docs/UI_GUIDELINES.md`。

# 核心行为准则与 Token 保护策略

## 1. 终端输出限制 (极度重要)
- 严禁在控制台打印超过 50 行的完整文件内容或构建日志。
- 当你需要执行构建、测试或查询命令时，必须将输出重定向到临时文件中（如 `> temp_log.txt`）。
- 读取日志时，强制使用截取命令（如 `head -n 30` 或 `tail -n 30`）只看关键报错。

## 2. 代码库扫描限制
- 绝对禁止读取或分析 `node_modules`, `dist`, `build`, `.venv` 等构建和依赖目录。
- 了解项目结构时，优先使用 `tree -L 2` 这种浅层扫描。

## 项目概述

**World Monitor** — 实时全球情报仪表板，聚合地缘政治、军事、金融、网络安全、气候、海事、航空等领域的数据，通过交互式地图和面板呈现统一的态势感知。

## 核心信息

| 项目 | 值 |
|------|-----|
| 版本 | 2.8.0 |
| 许可证 | AGPL-3.0-only |
| 框架 | Preact + Vite |
| 地图 | deck.gl / globe.gl + maplibre-gl |
| 后端 | Vercel Edge Functions + Render (AIS Relay) |
| 数据库 | Convex + Upstash Redis |
| 桌面 | Tauri 2.x |
| 语言 | TypeScript |

## 目录结构

```
worldmonitor/
├── src/                    # 前端核心代码
│   ├── App.ts              # 主应用 (~85KB)
│   ├── main.ts             # 入口文件 (~52KB)
│   ├── app/                # 应用层逻辑
│   │   ├── data-loader.ts  # 数据加载 (147KB)
│   │   ├── panel-layout.ts # 面板布局 (103KB)
│   │   └── event-handlers.ts
│   ├── components/         # UI 组件 (86+ 个面板类)
│   │   ├── Map.ts          # 地图逻辑 (150KB)
│   │   ├── DeckGLMap.ts    # DeckGL 地图 (~300KB)
│   │   ├── GlobeMap.ts     # 3D 地球仪 (~154KB)
│   │   └── *.ts            # 各类面板组件
│   ├── config/              # 配置
│   ├── services/           # 服务层
│   ├── workers/            # Web Workers
│   └── locales/            # i18n
├── api/                    # Vercel Edge Functions (API routes)
│   ├── bootstrap.js         # 启动数据
│   ├── health.js           # 健康检查
│   ├── market/             # 市场数据 API
│   ├── military/           # 军事数据 API
│   ├── cyber/              # 网络安全 API
│   └── */                  # 按领域分类
├── server/                 # Node.js 服务 (AIS Relay)
├── convex/                 # Convex 后端
├── docs/                   # 文档
├── src-tauri/              # Tauri 桌面应用
└── tests/                  # 测试文件
```

## 技术栈详解

### 前端
- **Preact** — 轻量级 React 替代
- **Vite** — 构建工具
- **deck.gl** — WebGL 地图渲染
- **globe.gl** — 3D 地球可视化
- **maplibre-gl** — 地图瓦片渲染
- **D3.js** — 数据可视化
- **i18next** — 国际化
- **Sentry** — 错误追踪
- **ONNX Runtime Web** — 客户端 ML 推理

### 后端
- **Vercel Edge Functions** — API 路由
- **Render** — AIS Relay (WebSocket 代理)
- **Upstash Redis** — 缓存 + 限流
- **Convex** — 实时数据库
- **Clerk** — 身份认证

### 数据源 (30+)
- AIS 海事数据 (Ship trackers)
- OpenSky 航空数据
- GDELT / ACLED / UCDP 冲突数据
- FRED 经济数据
- FINNHUB / Yahoo 金融市场
- FIRMS 野火监测
- COINGECKO 加密货币

## 开发命令

```bash
# 开发
npm run dev              # 默认变体
npm run dev:tech         # Tech 版本
npm run dev:finance      # Finance 版本

# 构建
npm run build            # 全量构建
npm run build:tech       # Tech 版本
npm run build:finance    # Finance 版本
npm run build:full       # 所有变体

# 类型检查
npm run typecheck
npm run typecheck:all     # 含 API 和 Convex

# Lint
npm run lint
npm run lint:fix

# 测试
npm run test:e2e          # E2E 测试
npm run test:data         # 数据测试

# 桌面应用
npm run desktop:dev       # 开发桌面版
npm run tauri dev
```

## 变体 (Variants)

项目支持多版本构建，通过 `VITE_VARIANT` 环境变量：

| 变体 | 用途 |
|------|------|
| `full` | 完整功能版 |
| `tech` | 科技行业版 |
| `finance` | 金融行业版 |
| `commodity` | 大宗商品版 |
| `happy` | 正面新闻版 |

## 关键文件

- `vite.config.ts` — 构建配置 (62KB)
- `package.json` — 依赖和脚本
- `vercel.json` — Vercel 部署配置
- `docker-compose.yml` — Docker 编排
- `ARCHITECTURE.md` — 详细架构文档
- `AGENTS.md` — AI Agent 工作流

## 常用工具

```bash
# 代码格式化
npm run lint:fix

# API 契约检查
npm run lint:api-contract

# Unicode 安全检查
npm run lint:unicode

# RSS 源验证
npm run test:feeds
```

## 注意事项

1. **面板开发** — 所有面板扩展 `Panel` 基类，使用 `setContent(html)` 渲染
2. **地图层定义** — 在 `src/config/map-layer-definitions.ts` 中配置
3. **数据刷新** — 通过 `refresh-scheduler.ts` 统一管理
4. **桌面版** — 使用 Tauri 侧车 (sidecar) 代理 API 请求

## 文档

- `ARCHITECTURE.md` — 系统架构
- `AGENTS.md` — Agent 工作流
- `SELF_HOSTING.md` — 自托管指南
- `DEPLOYMENT-PLAN.md` — 部署计划

---

# 核心工作流与架构要求

1. **绝对依赖真实代码**：当你被问及项目架构、逻辑或任何代码细节时，严禁凭空想象或依赖预训练数据。
2. **强制使用 MCP**：必须优先使用 `my-local-code` (Filesystem MCP) 工具遍历和读取本地真实文件后再作答。
3. **精准阅读**：不要一次性读取过多无关文件，先看目录结构，再精准进入相关文件阅读。


# 🤖 Node.js & Python 双栈项目专属指南

## 🚫 绝对禁区 (黑名单)
当你使用 `my-local-code` (Filesystem MCP) 扫描目录或查找代码时，**绝对禁止**进入以下目录：
1. `node_modules/` (Node 依赖库)
2. `venv/`, `.env/`, `__pycache__/` (Python 虚拟环境与缓存)
3. `dist/`, `build/` (编译产物)
*如果需要了解依赖，请直接读取 `package.json` 或 `requirements.txt`。*

## 🛠️ 代码阅读与修改规范
1. **先看全貌**：在修改复杂的业务逻辑前，先用工具查看相关文件的引入（Imports），不要盲目瞎改。
2. **Node.js 规范**：优先使用 ES Modules 语法，注意异步 `async/await` 的错误捕获。
3. **Python 规范**：严格遵守 PEP8 规范，强制加上 Type Hints (类型注解)。

## 🏃 运行与测试机制
* 当你帮我修改了 Node 代码后，请主动建议或运行 `npm run dev` 或对应的测试命令。
* 当你修改了 Python 脚本后，请提醒我运行 `python xxx.py` 验证结果。


*最后更新: 2026-05-20*

## ⚡ 自动提交与 Token 节约

1. **代码修改完成后自动提交推送**：每次代码修改完成并确认无误后，必须自动执行 `git add -A && git commit -m "<message>" && git push origin main`，将变更推送到 GitHub origin。
2. **始终使用 `rtk` 前缀执行命令**：运行任何终端命令时，必须使用 `rtk` 前缀（如 `rtk git status`、`rtk npm run build`），以利用 RTK 的输出压缩功能节省 token 消耗。详见 `.clinerules` 中的 RTK 规则。*最后更新: 2026-05-29*