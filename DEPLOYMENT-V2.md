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
# === 基础设施 ===
UPSTASH_REDIS_REST_URL=<同上>
UPSTASH_REDIS_REST_TOKEN=<同上>
CLOUDFLARE_ACCOUNT_ID=<同上>
CLOUDFLARE_KV_NAMESPACE_ID=<同上>
CLOUDFLARE_API_TOKEN=<同上>

# === Cloudflare R2 ===
CLOUDFLARE_R2_ACCOUNT_ID=<同上>
CLOUDFLARE_R2_API_TOKEN=<同上>
CLOUDFLARE_R2_BUCKET=wm-seed-data
CLOUDFLARE_R2_ACCESS_KEY_ID=<同上>
CLOUDFLARE_R2_SECRET_ACCESS_KEY=<同上>
CLOUDFLARE_R2_REGION=auto

# === API Keys ===
GROQ_API_KEY=<同上>
NVIDIA_NIM_API_KEY=<同上>
CEREBRAS_API_KEY=<同上>
SAMBANOVA_API_KEY=<同上>
OPENROUTER_API_KEY=<同上>
FINNHUB_API_KEY=<同上>
FRED_API_KEY=<同上>
EIA_API_KEY=<同上>
GIEAGSI_API_KEY=<同上>
AVIATIONSTACK_API=<同上>
NASA_FIRMS_API_KEY=<同上>
WINDY_API_KEY=<同上>
COINGECKO_API_KEY=<同上>
ALPHAVANTAGE_API_KEY=<同上>
WTO_API_KEY=<同上>
ABUSEIPDB_API_KEY=<同上>
OTX_API_KEY=<同上>
URLHAUS_AUTH_KEY=<同上>
COMTRADE_API_KEYS=<同上>
OPENAQ_API_KEY=<同上>
WAQI_API_KEY=<同上>
EXA_API_KEY=<同上>
FIRECRAWL_API_KEY=<同上>

# === Convex ===
CONVEX_URL=https://<convex-id>.convex.cloud
CONVEX_SITE_URL=https://<convex-id>.convex.site
WORLDMONITOR_RELAY_KEY=<与 WORLDMONITOR_VALID_KEYS 相同>

# === 通知 ===
RESEND_API_KEY=<同上>
BRIEF_URL_SIGNING_SECRET=<生成或导出>
RELAY_SHARED_SECRET=<同上>
RELAY_HEALTH_URL=https://<relay>.onrender.com/health
WORLDMONITOR_PUBLIC_BASE_URL=https://<站点>.netlify.app

# === 种子数据 ===
WORLDMONITOR_SEED_REFRESH_KEY=<生成: openssl rand -hex 32>
WORLDMONITOR_VALID_KEYS=<同上>
CONSUMER_PRICES_DATABASE_URL=<PostgreSQL连接串>

# === GH PAT（如需设置 Repo Variables）===
# GH_PAT=<带 repo scope 的 Personal Access Token>
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

---

## 迁移经验（踩坑记录）

### GitHub Actions Secrets 不会随 Git 迁移

换仓库（换 GitHub Org / 用户名）后，Actions secrets 需要**重新配置**。`gh secret list` 只显示当前 repo 的 secrets。把 `.env.local` 里的值用 `gh secret set` 配上：

```bash
gh secret set CLOUDFLARE_ACCOUNT_ID --body "$(grep CLOUDFLARE_ACCOUNT_ID .env.local | cut -d= -f2-)"
gh secret set CLOUDFLARE_API_TOKEN --body "$(grep CLOUDFLARE_API_TOKEN .env.local | cut -d= -f2-)"
# ... 其他所有 secrets
```

⚠️ **不要改代码来适配 missing secrets**。`process.exit(1)` 在 `_cfCredentials()` 里不是 bug——它是预期行为，secrets 配齐就不会触发。改代码只会引入不必要的 diff 和回归风险。

### GITHUB_TOKEN 不能设置 Repo Variables

`gh variable set` 底层调 `POST /repos/{owner}/{repo}/actions/variables`，需要 PAT（Personal Access Token）带 `repo` scope。GITHUB_TOKEN 无论给什么 `permissions:` 都没有这个权限（返回 403）。解决方案：要么配 `GH_PAT` secret，要么不用 repo variables。

### Netlify 环境变量需要 Redeploy

在 Netlify 站点设置或修改环境变量后，**必须重新部署**函数才能生效（运行时函数会缓存旧 env vars）。哪怕只是改一个 `WORLDMONITOR_VALID_KEYS`，也需要：

```bash
npm run build && npx netlify deploy --prod --dir=dist --no-build
```

`--no-build` 表示跳过 Netlify 端构建，直接用本地 `dist/` 目录部署。如果本地构建失败（Windows 环境兼容问题），可以先确认 `dist/` 和 `functions/` 目录是否就绪，然后重试 `--no-build` 部署。

### Netlify 迁移后的脚本 URL

Netlify 站点改名（如 `wm-worldmonitor` → `wm-245`）后，以下脚本中有硬编码的旧 URL 需要一并更新，否则 API 调用返回 404 或 CORS 拒绝：

- `scripts/seed-military-maritime-news.mjs`
- `scripts/seed-infra.mjs`
- `scripts/seed-service-statuses.mjs`
- `scripts/seed-classify.mjs`
- `scripts/seed-resilience-scores.mjs`
- `scripts/seed-insights.mjs`
- `scripts/seed-digest-notifications.mjs`
- `scripts/verify-import-hhi-coverage.mjs`

查找方式：
```bash
grep -rn 'wm-worldmonitor.netlify.app' scripts/ --include='*.mjs'
```

`Origin` 和 `HTTP-Referer` 头只是身份标识，不需要改——它们不是功能性的 API 端点地址。

### 修改代码前先查 Git Log

`git log --oneline -- <file>` 可以看文件的变更历史。在动手改代码之前，先确认原始代码是否本来就在工作——很多时候是配置问题，不是代码问题。
