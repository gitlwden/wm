# World Monitor Production Deployment Guide

> 本项目已从 Vercel 迁移到 Netlify。代码中所有域名引用已动态化，部署到新 Netlify 站点无需修改代码。

## 架构

```
Browser → Netlify (前端 + Functions API) → Upstash Redis (缓存/限流)
                                      ↘ Convex (数据库/认证)
                                      ↘ Render (AIS Relay) → aisstream.io WebSocket
GitHub Actions (seed cron) → Upstash Redis + Cloudflare KV
GitHub Actions (keepalive) → Render /health (防休眠)
```

## 一键迁移（新 Netlify 站点）

代码中零硬编码域名。迁移到新 Netlify 站点只需：

```bash
# 1. 创建站点
npx netlify sites:create --name <名称> --account-slug <团队slug>

# 2. Link 项目
npx netlify link --id <站点ID>

# 3. 导入环境变量（见下方完整列表）
#    唯一需要改的值：WORLDMONITOR_PUBLIC_BASE_URL=<新站点URL>

# 4. 构建 + 部署
npm run build && npx netlify deploy --prod --dir=dist --no-build
```

### 环境变量批量导入

从已有站点导出：
```bash
NETLIFY_AUTH_TOKEN=<旧token> npx netlify env:list --json > env-backup.json
```

导入到新站点：
```bash
node -e "
const d=require('./env-backup.json');
const NEW_TOKEN='<新token>';
const {execSync}=require('child_process');
for(const [k,v] of Object.entries(d)){
  execSync('NETLIFY_AUTH_TOKEN='+NEW_TOKEN+' npx netlify env:set '+k+' \"'+v+'\"',{stdio:'inherit'});
}
"
```

然后手动更新 `WORLDMONITOR_PUBLIC_BASE_URL` 为新站点 URL。

---

## 当前基础设施

| 组件 | 值 | 备注 |
|------|-----|------|
| Netlify 站点 | `wm-worldmonitor-847.netlify.app` | 当前生产 |
| Upstash Redis | `fitting-bluejay-147007.upstash.io` | 缓存/限流 |
| Convex | `ideal-snail-922.convex.cloud` | 数据库/认证 |
| Clerk | `good-bonefish-27.clerk.accounts.dev` | 测试环境 |
| AIS Relay | `wm-relay.onrender.com` | 船舶追踪 |
| GitHub Repo | `jlulwd/wm` | 源码 + Actions |

---

## 环境变量完整列表

### 核心基础设施（必填）

```bash
# === 基础设施 ===
WORLDMONITOR_PUBLIC_BASE_URL=https://<你的Netlify站点>.netlify.app
UPSTASH_REDIS_REST_URL=<Upstash URL>
UPSTASH_REDIS_REST_TOKEN=<Upstash Token>

# === Convex ===
VITE_CONVEX_URL=https://<convex-id>.convex.cloud
CONVEX_URL=https://<convex-id>.convex.cloud
CONVEX_SITE_URL=https://<convex-id>.convex.site
CONVEX_SERVER_SHARED_SECRET=<生成: openssl rand -hex 32>

# === Clerk 认证 ===
VITE_CLERK_PUBLISHABLE_KEY=pk_test_<你的key>
CLERK_SECRET_KEY=sk_test_<你的key>
CLERK_JWT_ISSUER_DOMAIN=https://<你的clerk实例>.clerk.accounts.dev
CLERK_PUBLISHABLE_KEY=pk_test_<你的key>

# === Relay ===
RELAY_SHARED_SECRET=<生成: openssl rand -hex 32>
RELAY_AUTH_HEADER=x-relay-key
WIDGET_RELAY_URL=https://<relay>.onrender.com
WS_RELAY_URL=https://<relay>.onrender.com
PRO_WIDGET_KEY=<生成: openssl rand -hex 24 | sed 's/^/wm_/'>

# === Session ===
WM_SESSION_SECRET=<生成: openssl rand -hex 32>
```

### 前端配置

```bash
VITE_VARIANT=full
VITE_MAP_INTERACTION_MODE=3d
VITE_CLOUD_PREFS_ENABLED=false
VITE_FAKE_PRO_USER=false
VITE_DODO_ENVIRONMENT=test_mode
VITE_TELEGRAM_BOT_USERNAME=WorldMonitorBot
```

### AI / LLM

```bash
GROQ_API_KEY=<console.groq.com>
NVIDIA_NIM_API_KEY=<build.nvidia.com>
CEREBRAS_API_KEY=<cloud.cerebras.ai>
SAMBANOVA_API_KEY=<cloud.sambanova.ai>
OPENROUTER_API_KEY=<openrouter.ai>
LLM_REASONING_PROVIDER=groq
FORECAST_LLM_PROVIDER_ORDER=groq
FORECAST_LLM_COMBINED_PROVIDER_ORDER=groq
FORECAST_LLM_CRITICAL_PROVIDER_ORDER=groq
FORECAST_LLM_MARKET_IMPLICATIONS_PROVIDER_ORDER=groq
```

### 数据源 API Keys

```bash
FINNHUB_API_KEY=<finnhub.io>
FRED_API_KEY=<fred.stlouisfed.org>
EIA_API_KEY=<eia.gov>
ACLED_EMAIL=<acleddata.com>
ACLED_PASSWORD=<acleddata.com>
NASA_FIRMS_API_KEY=<firms.modaps.eosdis.nasa.gov>
AVIATIONSTACK_API=<aviationstack.com>
OPENAQ_API_KEY=<openaq.org>
COINGECKO_API_KEY=<coingecko.com>
ABUSEIPDB_API_KEY=<abuseipdb.com>
EXA_API_KEY=<exa.ai>
FIRECRAWL_API_KEY=<firecrawl.dev>
WINDY_API_KEY=<windy.com>
```

### 通知

```bash
RESEND_API_KEY=<resend.com>
RESEND_FROM_EMAIL=WorldMonitor <alerts@worldmonitor.app>
RESEND_FROM_BRIEF=WorldMonitor Brief <brief@worldmonitor.app>
BRIEF_URL_SIGNING_SECRET=<生成: openssl rand -hex 32>
```

### Cloudflare

```bash
CLOUDFLARE_API_TOKEN=<cloudflare.com>
CLOUDFLARE_ACCOUNT_ID=<account ID>
CLOUDFLARE_R2_BUCKET=<bucket name>
CLOUDFLARE_R2_ACCESS_KEY_ID=<R2 key>
CLOUDFLARE_R2_SECRET_ACCESS_KEY=<R2 secret>
```

---

## GitHub Actions Secrets

GitHub repo → Settings → Secrets → Actions：

```bash
UPSTASH_REDIS_REST_URL=<同上>
UPSTASH_REDIS_REST_TOKEN=<同上>
CLOUDFLARE_ACCOUNT_ID=<同上>
CLOUDFLARE_KV_NAMESPACE_ID=<同上>
CLOUDFLARE_API_TOKEN=<同上>
GROQ_API_KEY=<同上>
NVIDIA_NIM_API_KEY=<同上>
FINNHUB_API_KEY=<同上>
FRED_API_KEY=<同上>
COINGECKO_API_KEY=<同上>
RELAY_HEALTH_URL=https://<relay>.onrender.com/health
```

---

## Convex 环境变量

Convex Dashboard → Settings → Environment Variables：

```bash
CLERK_SECRET_KEY=sk_test_<你的key>
CLERK_JWT_ISSUER_DOMAIN=https://<clerk实例>.clerk.accounts.dev
```

---

## AIS Relay (Render)

| 设置 | 值 |
|------|-----|
| Runtime | Docker |
| Dockerfile | `Dockerfile.relay` |
| Instance | Free |
| Port | 3004 |
| Health | `/health` |

环境变量：
```bash
AISSTREAM_API_KEY=<aisstream.io>
RELAY_SHARED_SECRET=<同上>
RELAY_AUTH_HEADER=x-relay-key
UPSTASH_REDIS_REST_URL=<同上>
UPSTASH_REDIS_REST_TOKEN=<同上>
```

---

## 验证清单

| # | 检查项 | 方法 |
|---|--------|------|
| 1 | 网站可访问 | 打开站点 URL |
| 2 | API 正常 | `/api/health` 返回 200 |
| 3 | 地图渲染 | 首页地图正常显示 |
| 4 | 面板有数据 | 首页面板非空（seed 数据已加载） |
| 5 | WM Analyst | 发送消息，收到 LLM 回复 |
| 6 | Deduct Situation | 输入问题，收到分析结果 |
| 7 | Clerk 登录 | 登录按钮正常工作 |
| 8 | Seed workflows | GitHub Actions 至少一个 seed 成功 |
| 9 | AIS Relay | Render `/health` 返回 200 |

---

## 域名动态化说明

所有代码中的域名引用已通过以下方式消除硬编码：

| 层级 | 机制 |
|------|------|
| 后端 API/服务端 | `WORLDMONITOR_PUBLIC_BASE_URL` 环境变量 |
| 前端 API 调用 | `window.location.origin` |
| CORS 白名单 | 从 `WORLDMONITOR_PUBLIC_BASE_URL` 动态生成正则 |
| Cookie 域名 | `location.hostname` |
| Sentry 环境 | `location.hostname.endsWith('.netlify.app')` |
| 面板链接 | 相对路径（`/pro`、`/blog/`） |

**唯一需要手动设置的变量是 `WORLDMONITOR_PUBLIC_BASE_URL`**，其余全部自动适配。
