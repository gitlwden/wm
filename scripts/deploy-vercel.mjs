#!/usr/bin/env node
/**
 * World Monitor — One-click deployment script
 *
 * Deploys to: GitHub → Vercel → Cloudflare DNS → Render (AIS Relay)
 *
 * Usage:
 *   node scripts/deploy-vercel.mjs --dry-run   # Preview
 *   node scripts/deploy-vercel.mjs              # Execute
 *
 * All secrets are read from .env.local automatically.
 * Set VERCEL_TOKEN in .env.local or as env var.
 *
 * Optional (env vars or .env.local):
 *   VERCEL_TOKEN         — https://vercel.com/account/tokens
 *   RENDER_API_KEY       — https://dashboard.render.com/account/api-keys
 *   CUSTOM_DOMAIN        — e.g. worldmonitor.app (skip to use .vercel.app)
 *   CLOUDFLARE_ZONE_ID   — Cloudflare → domain → Overview → Zone ID
 *   GITHUB_REPO_NAME     — defaults to "wm"
 */

import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// ─── Helpers ────────────────────────────────────────────────────────

const DRY_RUN = process.argv.includes('--dry-run');
const log = (icon, msg) => console.log(`${icon}  ${msg}`);
const ok = (msg) => log('✅', msg);
const skip = (msg) => log('⏭️ ', msg);
const info = (msg) => log('ℹ️ ', msg);
const warn = (msg) => log('⚠️ ', msg);
const err = (msg) => { log('❌', msg); process.exit(1); };
const step = (n, msg) => console.log(`\n${'─'.repeat(60)}\n  Phase ${n}: ${msg}\n${'─'.repeat(60)}`);

async function api(url, opts = {}) {
  const { method = 'GET', headers = {}, body, token, expectJson = true } = opts;
  const h = { 'Content-Type': 'application/json', ...headers };
  if (token) h['Authorization'] = `Bearer ${token}`;
  const res = await fetch(url, {
    method, headers: h,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`API ${method} ${url} → ${res.status}: ${text.slice(0, 500)}`);
  }
  if (!expectJson) return text;
  try { return JSON.parse(text); } catch { return text; }
}

function run(cmd, opts = {}) {
  try {
    return execSync(cmd, {
      cwd: ROOT, encoding: 'utf-8',
      stdio: opts.silent ? 'pipe' : 'inherit',
      timeout: opts.timeout ?? 120_000,
      ...opts,
    }).trim();
  } catch (e) {
    if (opts.allowFail) return e.stdout?.trim() ?? '';
    throw e;
  }
}

// ─── Load env files ─────────────────────────────────────────────────

function parseEnvFile(filePath) {
  if (!existsSync(filePath)) return {};
  const lines = readFileSync(filePath, 'utf-8').split('\n');
  const env = {};
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    if (!trimmed.includes('=')) continue;
    const eqIdx = trimmed.indexOf('=');
    const key = trimmed.slice(0, eqIdx).trim();
    if (/\s/.test(key) || key.startsWith('-')) continue;
    let val = trimmed.slice(eqIdx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (val) env[key] = val; // only keep non-empty values
  }
  return env;
}

// deploy.env (deployment-only vars) takes priority over .env.local
const deployEnv = parseEnvFile(resolve(ROOT, 'deploy.env'));
const localEnv = parseEnvFile(resolve(ROOT, '.env.local'));
const ENV = { ...localEnv, ...deployEnv };

// ─── Config ─────────────────────────────────────────────────────────

const CFG = {
  repoName:     process.env.GITHUB_REPO_NAME ?? ENV.GITHUB_REPO_NAME ?? 'wm',
  customDomain: process.env.CUSTOM_DOMAIN ?? ENV.CUSTOM_DOMAIN ?? '',
  vercelToken:  process.env.VERCEL_TOKEN ?? ENV.VERCEL_TOKEN ?? '',
  renderApiKey: process.env.RENDER_API_KEY ?? ENV.RENDER_API_KEY ?? '',
  cfZoneId:     process.env.CLOUDFLARE_ZONE_ID ?? ENV.CLOUDFLARE_ZONE_ID ?? '',
  cfApiToken:   ENV.CLOUDFLARE_API_TOKEN ?? '',
};

// ─── Variable classification ────────────────────────────────────────

// Variables that go to Vercel (build-time + runtime)
const VERCEL_KEYS = [
  'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN',
  'VITE_CONVEX_URL', 'CONVEX_URL', 'CONVEX_SITE_URL', 'CONVEX_SERVER_SHARED_SECRET',
  'VITE_CLERK_PUBLISHABLE_KEY', 'CLERK_SECRET_KEY', 'CLERK_JWT_ISSUER_DOMAIN',
  'RELAY_SHARED_SECRET', 'RELAY_AUTH_HEADER',
  'VITE_VARIANT', 'VITE_MAP_INTERACTION_MODE', 'VITE_CLOUD_PREFS_ENABLED',
  'VITE_FAKE_PRO_USER', 'VITE_TELEGRAM_BOT_USERNAME',
  'VITE_DODO_ENVIRONMENT',
  'GROQ_API_KEY', 'OPENROUTER_API_KEY',
  'FORECAST_LLM_PROVIDER_ORDER', 'FORECAST_LLM_MODEL_OPENROUTER',
  'FORECAST_LLM_COMBINED_PROVIDER_ORDER', 'FORECAST_LLM_COMBINED_MODEL_OPENROUTER',
  'FORECAST_LLM_CRITICAL_PROVIDER_ORDER', 'FORECAST_LLM_CRITICAL_MODEL_OPENROUTER',
  'FORECAST_LLM_MARKET_IMPLICATIONS_PROVIDER_ORDER', 'FORECAST_LLM_MARKET_IMPLICATIONS_MODEL_OPENROUTER',
  'FINNHUB_API_KEY', 'ALPHAVANTAGE_API_KEY', 'TWELVEDATA_API_KEY',
  'EIA_API_KEY', 'FRED_API_KEY',
  'OPENAQ_API_KEY', 'WAQI_API_KEY',
  'AVIATIONSTACK_API', 'TRAVELPAYOUTS_API_TOKEN',
  'ACLED_EMAIL', 'ACLED_PASSWORD', 'UCDP_ACCESS_TOKEN',
  'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_KV_NAMESPACE_ID',
  'CLOUDFLARE_R2_ACCOUNT_ID', 'CLOUDFLARE_R2_BUCKET', 'CLOUDFLARE_R2_TRACE_BUCKET',
  'CLOUDFLARE_R2_ACCESS_KEY_ID', 'CLOUDFLARE_R2_SECRET_ACCESS_KEY',
  'CLOUDFLARE_R2_REGION', 'CLOUDFLARE_R2_TRACE_PREFIX',
  'NASA_FIRMS_API_KEY', 'RELIEFWEB_APPNAME',
  'AISSTREAM_API_KEY',
  'COINGECKO_API_KEY', 'WTO_API_KEY',
  'ABUSEIPDB_API_KEY', 'OTX_API_KEY', 'URLHAUS_AUTH_KEY', 'WINDY_API_KEY',
  'AIRLABS_API_KEY', 'GIEAGSI_API_KEY',
  'RESEND_API_KEY', 'RESEND_FROM_EMAIL', 'RESEND_FROM_BRIEF',
  'BRIEF_URL_SIGNING_SECRET',
  'CONSUMER_PRICES_DATABASE_URL',
  'EXA_API_KEY', 'FIRECRAWL_API_KEY',
];

// Variables that go to GitHub Actions secrets (seed workflows need these)
const GITHUB_SECRET_KEYS = [
  'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN',
  'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_KV_NAMESPACE_ID', 'CLOUDFLARE_API_TOKEN',
  'CLOUDFLARE_R2_ACCOUNT_ID', 'CLOUDFLARE_R2_BUCKET', 'CLOUDFLARE_R2_TRACE_BUCKET',
  'CLOUDFLARE_R2_ACCESS_KEY_ID', 'CLOUDFLARE_R2_SECRET_ACCESS_KEY',
  'CLOUDFLARE_R2_REGION', 'CLOUDFLARE_R2_TRACE_PREFIX',
  'FINNHUB_API_KEY', 'ALPHAVANTAGE_API_KEY', 'TWELVEDATA_API_KEY',
  'FRED_API_KEY', 'EIA_API_KEY',
  'NASA_FIRMS_API_KEY', 'ACLED_EMAIL', 'ACLED_PASSWORD', 'UCDP_ACCESS_TOKEN',
  'GROQ_API_KEY', 'OPENROUTER_API_KEY',
  'COINGECKO_API_KEY', 'WTO_API_KEY',
  'OPENAQ_API_KEY', 'WAQI_API_KEY',
  'AVIATIONSTACK_API', 'TRAVELPAYOUTS_API_TOKEN',
  'RELIEFWEB_APPNAME',
  'AISSTREAM_API_KEY',
  'ABUSEIPDB_API_KEY', 'OTX_API_KEY', 'URLHAUS_AUTH_KEY', 'WINDY_API_KEY',
  'AIRLABS_API_KEY', 'GIEAGSI_API_KEY',
  'CONSUMER_PRICES_DATABASE_URL',
  'EXA_API_KEY', 'FIRECRAWL_API_KEY',
  'PROXY_SOURCES',
  'RELAY_SHARED_SECRET', 'BRIEF_URL_SIGNING_SECRET',
];

// Variables for Render AIS Relay
const RENDER_KEYS = [
  'AISSTREAM_API_KEY', 'RELAY_SHARED_SECRET', 'RELAY_AUTH_HEADER',
  'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN',
];

// ─── Preflight ──────────────────────────────────────────────────────

function preflight() {
  console.log('\n🔍 Preflight checks\n');

  if (!CFG.vercelToken) err('VERCEL_TOKEN not set. Add to .env.local or set as env var.\n  Get one at: https://vercel.com/account/tokens');
  ok('VERCEL_TOKEN found');

  if (CFG.renderApiKey) ok('RENDER_API_KEY found');
  else warn('RENDER_API_KEY not set — Render AIS Relay deployment will be skipped');

  if (CFG.cfApiToken) ok('CLOUDFLARE_API_TOKEN found');
  else info('CLOUDFLARE_API_TOKEN not found — DNS setup will be skipped');

  if (CFG.customDomain && !CFG.cfZoneId) {
    warn('CUSTOM_DOMAIN set but CLOUDFLARE_ZONE_ID missing — DNS will be skipped');
  }

  if (!ENV.UPSTASH_REDIS_REST_URL || !ENV.UPSTASH_REDIS_REST_TOKEN) {
    err('UPSTASH_REDIS_REST_URL/TOKEN not found in .env.local');
  }
  ok(`Upstash: ${ENV.UPSTASH_REDIS_REST_URL}`);

  try { run('gh auth status', { silent: true }); ok('GitHub CLI authenticated'); }
  catch { err('GitHub CLI not authenticated. Run: gh auth login'); }

  // Count available variables
  const vercelCount = VERCEL_KEYS.filter(k => ENV[k]).length;
  const ghCount = GITHUB_SECRET_KEYS.filter(k => ENV[k]).length;
  info(`Found ${vercelCount}/${VERCEL_KEYS.length} Vercel env vars, ${ghCount}/${GITHUB_SECRET_KEYS.length} GitHub secrets`);

  if (DRY_RUN) warn('DRY RUN mode — no changes will be made');

  console.log(`\n  Repo:       ${CFG.repoName}`);
  console.log(`  Domain:     ${CFG.customDomain || '(will use .vercel.app)'}`);
  console.log(`  Upstash:    ${ENV.UPSTASH_REDIS_REST_URL}`);
  console.log(`  Convex:     ${ENV.CONVEX_URL ?? 'not set'}`);
  console.log(`  Render:     ${CFG.renderApiKey ? 'will deploy' : 'skipped'}`);
}

// ─── Phase 1: GitHub Repo ───────────────────────────────────────────

async function phase1_github() {
  step(1, 'GitHub Repository');

  const existing = run(`gh repo view ${CFG.repoName} --json name 2>&1`, { silent: true, allowFail: true });
  if (existing.includes('"name"')) {
    skip(`Repo ${CFG.repoName} already exists`);
    return;
  }

  if (DRY_RUN) {
    info(`Would create repo: ${CFG.repoName} (private) and push all code`);
    return;
  }

  run(`gh repo create ${CFG.repoName} --private --source=. --remote=origin --push`);
  ok(`Created repo ${CFG.repoName} and pushed`);
}

// ─── Phase 2: GitHub Actions Secrets ────────────────────────────────

async function phase2_github_secrets() {
  step(2, 'GitHub Actions Secrets');

  let setCount = 0;
  for (const key of GITHUB_SECRET_KEYS) {
    const value = ENV[key];
    if (!value) { skip(`${key} — not in .env.local`); continue; }
    if (DRY_RUN) { info(`Would set secret: ${key}`); setCount++; continue; }
    try {
      // Use --body with direct value. Wrap in single quotes for bash.
      // Escape single quotes in value: ' → '\''
      const escaped = value.replace(/'/g, "'\\''");
      run(`gh secret set ${key} --body '${escaped}'`, { silent: true });
      ok(key);
      setCount++;
    } catch (e) {
      warn(`${key} — failed: ${e.message.slice(0, 80)}`);
    }
  }
  info(`Set ${setCount} secrets`);
}

// ─── Phase 3: Vercel Project ────────────────────────────────────────

async function phase3_vercel() {
  step(3, 'Vercel Project');

  const vercelDomain = `${CFG.repoName}.vercel.app`;

  // Check if project exists
  let project;
  try {
    project = await api(`https://api.vercel.com/v9/projects/${CFG.repoName}`, {
      token: CFG.vercelToken,
    });
    skip(`Project ${CFG.repoName} already exists on Vercel`);
  } catch {
    if (DRY_RUN) {
      info(`Would create Vercel project: ${CFG.repoName}`);
      info(`Site would be at: https://${vercelDomain}`);
      return;
    }

    // Create project
    project = await api('https://api.vercel.com/v10/projects', {
      method: 'POST',
      token: CFG.vercelToken,
      body: { name: CFG.repoName, framework: 'vite' },
    });
    ok(`Created Vercel project: ${CFG.repoName}`);

    // Link GitHub repo
    try {
      const repoInfo = JSON.parse(run(`gh repo view --json owner,name`, { silent: true }));
      const owner = typeof repoInfo.owner === 'string' ? repoInfo.owner : repoInfo.owner.login;
      await api(`https://api.vercel.com/v1/projects/${project.id}/link`, {
        method: 'POST',
        token: CFG.vercelToken,
        body: { type: 'github', repo: repoInfo.name, org: owner },
      });
      ok(`Linked GitHub repo: ${owner}/${repoInfo.name}`);
    } catch (e) {
      warn(`GitHub link failed (${e.message.slice(0, 60)}) — link manually in Vercel Dashboard`);
    }
  }

  const projectId = project.id;

  // Set environment variables
  info(`Setting environment variables...`);
  let setCount = 0;
  for (const key of VERCEL_KEYS) {
    const value = ENV[key];
    if (!value) continue;
    if (DRY_RUN) { info(`Would set env: ${key}`); setCount++; continue; }
    try {
      await api(`https://api.vercel.com/v10/projects/${projectId}/env`, {
        method: 'POST',
        token: CFG.vercelToken,
        body: {
          key, value,
          type: 'encrypted',
          target: ['production', 'preview', 'development'],
        },
      });
      ok(key);
      setCount++;
    } catch (e) {
      if (e.message.includes('409') || e.message.includes('already exists')) {
        skip(`${key} — already exists`);
      } else {
        warn(`${key} — ${e.message.slice(0, 100)}`);
      }
    }
  }
  info(`Set ${setCount} environment variables`);

  // Add custom domain if provided
  if (CFG.customDomain && !DRY_RUN) {
    try {
      await api(`https://api.vercel.com/v10/projects/${projectId}/domains`, {
        method: 'POST',
        token: CFG.vercelToken,
        body: { name: CFG.customDomain },
      });
      ok(`Added domain: ${CFG.customDomain}`);
    } catch (e) {
      if (e.message.includes('already exists')) skip(`Domain ${CFG.customDomain} already added`);
      else warn(`Domain add failed: ${e.message.slice(0, 100)}`);
    }
  }

  // Trigger deployment
  if (!DRY_RUN) {
    info('Triggering deployment...');
    try {
      const deploy = await api('https://api.vercel.com/v13/deployments', {
        method: 'POST',
        token: CFG.vercelToken,
        body: { name: CFG.repoName, project: projectId, target: 'production' },
      });
      ok(`Deploying → https://${deploy.url ?? vercelDomain}`);
    } catch {
      info('Deploy will auto-trigger from GitHub push');
    }
  }

  return { projectId, vercelDomain };
}

// ─── Phase 4: Cloudflare DNS ────────────────────────────────────────

async function phase4_cloudflare(vercelDomain) {
  step(4, 'Cloudflare DNS');

  if (!CFG.customDomain) {
    skip('No CUSTOM_DOMAIN — using ' + (vercelDomain ?? '.vercel.app'));
    return;
  }
  if (!CFG.cfZoneId || !CFG.cfApiToken) {
    warn('CLOUDFLARE_ZONE_ID or CLOUDFLARE_API_TOKEN missing — manual DNS setup needed');
    info(`Add CNAME: ${CFG.customDomain} → cname.vercel-dns.com`);
    info('Set Cloudflare SSL/TLS mode to "Full"');
    return;
  }

  if (DRY_RUN) {
    info(`Would add CNAME: ${CFG.customDomain} → cname.vercel-dns.com`);
    return;
  }

  const records = await api(
    `https://api.cloudflare.com/client/v4/zones/${CFG.cfZoneId}/dns_records?name=${CFG.customDomain}`,
    { token: CFG.cfApiToken }
  );
  if (records.result?.length > 0) {
    skip(`DNS record for ${CFG.customDomain} already exists`);
  } else {
    await api(`https://api.cloudflare.com/client/v4/zones/${CFG.cfZoneId}/dns_records`, {
      method: 'POST', token: CFG.cfApiToken,
      body: { type: 'CNAME', name: CFG.customDomain, content: 'cname.vercel-dns.com', proxied: false, ttl: 1 },
    });
    ok(`CNAME: ${CFG.customDomain} → cname.vercel-dns.com`);
  }

  info('Reminder: Set Cloudflare SSL/TLS mode to "Full" (Dashboard → SSL/TLS → Overview)');
}

// ─── Phase 5: Render AIS Relay ──────────────────────────────────────

async function phase5_render() {
  step(5, 'Render AIS Relay');

  if (!CFG.renderApiKey) {
    skip('RENDER_API_KEY not set — skipping');
    info('To deploy later: set RENDER_API_KEY in .env.local and re-run');
    return;
  }

  const serviceName = `${CFG.repoName}-relay`;

  if (DRY_RUN) {
    info(`Would create Render service: ${serviceName}`);
    info(`Would set ${RENDER_KEYS.filter(k => ENV[k]).length} env vars`);
    return;
  }

  // Check if service exists
  let services;
  try {
    services = await api('https://api.render.com/v1/services', { token: CFG.renderApiKey });
  } catch (e) {
    warn(`Render API error: ${e.message.slice(0, 100)}`);
    return;
  }
  const existing = Array.isArray(services)
    ? services.find(s => s.service?.name === serviceName)
    : null;

  if (existing) {
    skip(`Render service ${serviceName} already exists`);
    return existing;
  }

  // Get owner ID
  const owners = await api('https://api.render.com/v1/owners', { token: CFG.renderApiKey });
  const ownerId = owners[0]?.owner?.id;
  if (!ownerId) { warn('Cannot determine Render owner ID'); return; }

  // Create web service
  const renderEnv = RENDER_KEYS
    .filter(k => ENV[k])
    .map(k => ({ key: k, value: ENV[k] }));

  renderEnv.push({ key: 'PORT', value: '3004' });

  // Derive repo URL from git remote (no network call needed)
  const remoteUrl = run('git remote get-url origin', { silent: true });
  const repoUrl = remoteUrl.replace(/\.git$/, '').replace(/^git@github\.com:/, 'https://github.com/');

  const service = await api('https://api.render.com/v1/services', {
    method: 'POST',
    token: CFG.renderApiKey,
    body: {
      type: 'web_service',
      name: serviceName,
      ownerID: ownerId,
      runtime: 'docker',
      repo: repoUrl,
      branch: 'main',
      plan: 'free',
      healthCheckPath: '/health',
      envVars: renderEnv,
      serviceDetails: {
        dockerfilePath: './Dockerfile.relay',
        env: 'docker',
      },
    },
  });
  ok(`Created Render service: ${serviceName}`);

  // Set RELAY_HEALTH_URL for keepalive workflow
  if (service.service?.url) {
    const healthUrl = `${service.service.url}/health`;
    try {
      run(`gh secret set RELAY_HEALTH_URL --body "${healthUrl}"`, { silent: true });
      ok(`Set RELAY_HEALTH_URL = ${healthUrl}`);
    } catch {
      warn(`Set RELAY_HEALTH_URL manually: ${healthUrl}`);
    }
  }

  return service;
}

// ─── Phase 6: Convex Check ──────────────────────────────────────────

async function phase6_convex() {
  step(6, 'Convex Environment Variables');

  if (!ENV.CONVEX_URL) { warn('CONVEX_URL not set'); return; }

  ok(`Convex: ${ENV.CONVEX_URL}`);
  ok(`Convex Site: ${ENV.CONVEX_SITE_URL ?? 'not set'}`);

  // Extract deployment name from URL (e.g. "ideal-snail-922" from "https://ideal-snail-922.convex.cloud")
  const deploymentMatch = ENV.CONVEX_URL.match(/https:\/\/([^.]+)\.convex\.cloud/);
  const deployment = deploymentMatch?.[1];

  if (!deployment) { warn('Cannot parse Convex deployment name'); return; }

  const convexEnvVars = {
    CLERK_JWT_ISSUER_DOMAIN: ENV.CLERK_JWT_ISSUER_DOMAIN ?? '',
    RELAY_SHARED_SECRET: ENV.RELAY_SHARED_SECRET ?? '',
    CONVEX_SERVER_SHARED_SECRET: ENV.CONVEX_SERVER_SHARED_SECRET ?? '',
  };

  for (const [key, value] of Object.entries(convexEnvVars)) {
    if (!value) { warn(`${key} not set — add to .env.local`); continue; }
    if (DRY_RUN) { info(`Would set Convex env: ${key}`); continue; }
    try {
      run(`npx convex env set ${key} "${value}" --deployment ${deployment}`, { silent: true, timeout: 30_000 });
      ok(`${key} → Convex`);
    } catch (e) {
      warn(`${key} — failed: ${e.message.slice(0, 80)}`);
    }
  }
}

// ─── Summary ────────────────────────────────────────────────────────

function summary(relayUrl) {
  console.log(`\n${'═'.repeat(60)}`);
  console.log('  Deployment Complete');
  console.log(`${'═'.repeat(60)}\n`);

  console.log(`  GitHub:    https://github.com/gtlwd/${CFG.repoName}`);
  console.log(`  Vercel:    https://${CFG.repoName}.vercel.app`);
  if (CFG.customDomain) console.log(`  Custom:    https://${CFG.customDomain}`);
  console.log(`  Upstash:   ${ENV.UPSTASH_REDIS_REST_URL}`);
  console.log(`  Convex:    ${ENV.CONVEX_URL ?? 'not set'}`);
  if (relayUrl) console.log(`  Relay:     ${relayUrl}`);

  console.log('\n  Verify:');
  console.log('  1. Vercel build logs — check for errors');
  console.log('  2. Open site — panels should have data');
  console.log('  3. /api/health — should return 200');
  console.log('  4. /api/seed-health — data freshness');
  console.log('  5. Clerk login — test sign-in flow');
  if (CFG.customDomain) {
    console.log('  6. Cloudflare SSL/TLS → set to "Full"');
  }
  console.log('');
}

// ─── Main ───────────────────────────────────────────────────────────

async function main() {
  console.log('\n🌍 World Monitor — One-Click Deployment\n');
  if (DRY_RUN) console.log('  🔍 DRY RUN — preview only\n');

  preflight();

  await phase1_github();
  await phase2_github_secrets();
  const { vercelDomain } = (await phase3_vercel()) ?? {};
  await phase4_cloudflare(vercelDomain);
  const relay = await phase5_render();
  await phase6_convex();

  summary(relay?.service?.url);
}

main().catch(e => {
  console.error(`\n❌ Fatal: ${e.message}`);
  process.exit(1);
});
