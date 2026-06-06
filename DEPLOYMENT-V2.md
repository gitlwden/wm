# World Monitor Production Deployment Guide

> 本文档基于当前 `.env.local` 中已有的配置，指导你将项目部署到 Vercel 生产环境。

## 架构

```
Browser → Vercel (前端 + Edge API) → Upstash Redis (缓存/限流)
                                 ↘ Convex (数据库/认证)
GitHub Actions (seed cron) → Upstash Redis + Cloudflare KV
```

## 已完成项

| 组件 | 状态 | 备注 |
|------|------|------|
| Upstash Redis | ✅ | `winning-meerkat-98455.upstash.io` |
| Convex | ✅ | `adamant-mandrill-629` |
| Clerk (测试) | ✅ | `cheerful-mollusk-70.clerk.accounts.dev` — **当前为 test keys** |
| RELAY_SHARED_SECRET | ✅ | 已生成 |
| AISSTREAM_API_KEY | ✅ | 已注册 |
| Cloudflare KV | ✅ | `e23f292a3417486bbfe1f12d67b58bc4` |
| GitHub Actions Seed | ✅ | 20+ workflows 已存在，只需配 secrets |
| 数据源 API keys | ✅ | FINNHUB, FRED, EIA, ACLED, NASA_FIRMS 等已配置 |

## 需要完成项

---

### Phase 1: Vercel 部署

#### 1.1 连接仓库

1. 登录 https://vercel.com → Add New → Project
2. Import `worldmonitor` GitHub 仓库
3. Framework: **Vite** (自动检测), 其余默认

#### 1.2 环境变量

在 Vercel Dashboard → Settings → Environment Variables 添加以下变量。

**所有 Environment 都勾选** (Production, Preview, Development)：

```bash
# === 核心基础设施 ===
UPSTASH_REDIS_REST_URL=https://winning-meerkat-98455.upstash.io
UPSTASH_REDIS_REST_TOKEN=<从 .env.local 复制>

VITE_CONVEX_URL=https://adamant-mandrill-629.convex.cloud/
CONVEX_URL=https://adamant-mandrill-629.convex.cloud/
CONVEX_SITE_URL=https://adamant-mandrill-629.convex.site
CONVEX_SERVER_SHARED_SECRET=<从 .env.local 复制>

# === Clerk 认证 ===
VITE_CLERK_PUBLISHABLE_KEY=pk_test_Y2hlZXJmdWwtbW9sbHVzay03MC5jbGVyay5hY2NvdW50cy5kZXYk
CLERK_SECRET_KEY=<从 .env.local 复制>
CLERK_JWT_ISSUER_DOMAIN=https://cheerful-mollusk-70.clerk.accounts.dev
CLERK_PUBLISHABLE_KEY=pk_test_Y2hlZXJmdWwtbW9sbHVzay03MC5jbGVyay5hY2NvdW50cy5kZXYk

# === Relay 认证 ===
RELAY_SHARED_SECRET=<从 .env.local 复制>
RELAY_AUTH_HEADER=x-relay-key

# === 前端配置 ===
VITE_VARIANT=full
VITE_MAP_INTERACTION_MODE=flat
VITE_CLOUD_PREFS_ENABLED=true
VITE_FAKE_PRO_USER=false

# === AI 摘要 ===
GROQ_API_KEY=<从 .env.local 复制>
OPENROUTER_API_KEY=<从 .env.local 复制>
FORECAST_LLM_PROVIDER_ORDER=groq
FORECAST_LLM_MODEL_OPENROUTER=cognitivecomputations/dolphin-mistral-24b-venice-edition:free
FORECAST_LLM_COMBINED_PROVIDER_ORDER=groq
FORECAST_LLM_COMBINED_MODEL_OPENROUTER=openai/gpt-oss-120b
FORECAST_LLM_CRITICAL_PROVIDER_ORDER=groq
FORECAST_LLM_CRITICAL_MODEL_OPENROUTER=openai/gpt-oss-120b:free
FORECAST_LLM_MARKET_IMPLICATIONS_PROVIDER_ORDER=groq
FORECAST_LLM_MARKET_IMPLICATIONS_MODEL_OPENROUTER=groq/compound

# === 数据源 (面板会自动激活) ===
FINNHUB_API_KEY=<从 .env.local 复制>
FRED_API_KEY=<从 .env.local 复制>
EIA_API_KEY=<从 .env.local 复制>
ACLED_EMAIL=<从 .env.local 复制>
ACLED_PASSWORD=<从 .env.local 复制>
NASA_FIRMS_API_KEY=<从 .env.local 复制>
AVIATIONSTACK_API=<从 .env.local 复制>
OPENAQ_API_KEY=<从 .env.local 复制>
WAQI_API_KEY=<从 .env.local 复制>
RELIEFWEB_APPNAME=WorldMonitor-MyWarRoom
CLOUDFLARE_API_TOKEN=<从 .env.local 复制>
CLOUDFLARE_ACCOUNT_ID=768b3115e9ab856c072dddc7f14127c4
CLOUDFLARE_KV_NAMESPACE_ID=e23f292a3417486bbfe1f12d67b58bc4
```

> **注意**: 当前 Clerk keys 是 **test** 版本 (`pk_test_`, `sk_test_`)。
> 正式上线前需要在 Clerk Dashboard 创建 production instance，获取 `pk_live_` / `sk_live_` keys。

#### 1.3 部署

添加完环境变量后，Vercel 会自动触发构建。检查 Build Logs 确保无报错。

---

### Phase 2: GitHub Actions Seed

Seed workflows 已存在 (`.github/workflows/seed-*.yml`)，只需配置 repo secrets。

#### 2.1 配置 Secrets

GitHub repo → Settings → Secrets and variables → Actions → New repository secret:

```bash
# 核心 (必填)
UPSTASH_REDIS_REST_URL=https://winning-meerkat-98455.upstash.io
UPSTASH_REDIS_REST_TOKEN=<从 .env.local 复制>
CLOUDFLARE_ACCOUNT_ID=768b3115e9ab856c072dddc7f14127c4
CLOUDFLARE_KV_NAMESPACE_ID=e23f292a3417486bbfe1f12d67b58bc4
CLOUDFLARE_API_TOKEN=<从 .env.local 复制>

# 数据源 (按需，seed 会自动跳过缺少 key 的步骤)
FINNHUB_API_KEY=<从 .env.local 复制>
FRED_API_KEY=<从 .env.local 复制>
EIA_API_KEY=<从 .env.local 复制>
NASA_FIRMS_API_KEY=<从 .env.local 复制>
ACLED_EMAIL=<从 .env.local 复制>
ACLED_PASSWORD=<从 .env.local 复制>
GROQ_API_KEY=<从 .env.local 复制>
COINGECKO_API_KEY=<从 .env.local 复制>
OPENAQ_API_KEY=<从 .env.local 复制>
WAQI_API_KEY=<从 .env.local 复制>
RELIEFWEB_APPNAME=WorldMonitor-MyWarRoom
ALPHAVANTAGE_API_KEY=<从 .env.local 复制>
```

#### 2.2 验证

GitHub Actions → 选 `Seed Relay (Frequent)` → Run workflow → 检查日志。

---

### Phase 3: Convex 环境变量

在 Convex Dashboard → Settings → Environment Variables 确认已有：

| 变量 | 状态 |
|------|------|
| `CLERK_JWT_ISSUER_DOMAIN` | 需确认已设置 |
| `RELAY_SHARED_SECRET` | 需确认已设置 |

---

## 验证清单

| # | 检查项 | 方法 |
|---|--------|------|
| 1 | 网站可访问 | 打开 `https://xxx.vercel.app` |
| 2 | 地图渲染 | 首页地图正常显示 |
| 3 | 面板有数据 | 首页面板非空 (seed 数据已加载) |
| 4 | API 正常 | `/api/health` 返回 200 |
| 5 | Seed 状态 | `/api/seed-health` 显示数据域新鲜度 |
| 6 | Clerk 登录 | 点击登录按钮，完成注册/登录流程 |
| 7 | GitHub Actions | 至少一个 seed workflow 运行成功 |

---

## 后加功能 (零代码改动)

| 功能 | 操作 |
|------|------|
| Sentry 错误监控 | Vercel 加 `VITE_SENTRY_DSN` |
| AIS 船舶追踪 | 部署 AIS Relay (Koyeb/Railway) + Vercel 加 `WS_RELAY_URL` |
| Dodo 支付 | Vercel 加 Dodo 变量 + Convex 加 webhook secret |
| Telegram 通知 | Relay 加 `TELEGRAM_API_ID` / `TELEGRAM_API_HASH` |
| Slack/Discord OAuth | Vercel 加 `SLACK_*` / `DISCORD_*` |
| 生产 Clerk | 替换 `pk_test_` → `pk_live_`, `sk_test_` → `sk_live_` |

---

## 环境变量来源速查

| 变量 | Vercel | GitHub Secrets | Convex |
|------|--------|---------------|--------|
| UPSTASH_REDIS_REST_URL | ✅ | ✅ | |
| UPSTASH_REDIS_REST_TOKEN | ✅ | ✅ | |
| CONVEX_URL / VITE_CONVEX_URL | ✅ | | |
| CONVEX_SITE_URL | ✅ | | |
| CONVEX_SERVER_SHARED_SECRET | ✅ | | |
| Clerk keys | ✅ | | |
| CLERK_JWT_ISSUER_DOMAIN | ✅ | | ✅ |
| RELAY_SHARED_SECRET | ✅ | | ✅ |
| RELAY_AUTH_HEADER | ✅ | | |
| CLOUDFLARE_* | | ✅ | |
| 数据源 API keys | ✅ | ✅ | |
