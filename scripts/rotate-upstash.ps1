<#
.SYNOPSIS
    One-click Upstash Redis credential rotation.
    Updates .env.local, GitHub Secrets, Netlify, and Render in one go.

.PARAMETER Url
    New UPSTASH_REDIS_REST_URL value.

.PARAMETER Token
    New UPSTASH_REDIS_REST_TOKEN value.

.PARAMETER SkipNetlify
    Skip Netlify env var update.

.PARAMETER SkipGithub
    Skip GitHub Secrets update.

.PARAMETER SkipRender
    Skip Render env var update.

.EXAMPLE
    .\scripts\rotate-upstash.ps1 -Url "https://xxx.upstash.io" -Token "AYxxx"
#>

param(
    [Parameter(Mandatory = $true)]
    [string]$Url,

    [Parameter(Mandatory = $true)]
    [string]$Token,

    [switch]$SkipNetlify,
    [switch]$SkipGithub,
    [switch]$SkipRender
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$EnvFile = Join-Path $Root ".env.local"

Write-Host "=== Upstash Redis Credential Rotation ===" -ForegroundColor Cyan
Write-Host ""

# ─── 1. Update .env.local ───────────────────────────────────────────

Write-Host "[1/4] Updating .env.local ..." -ForegroundColor Yellow

if (-not (Test-Path $EnvFile)) {
    Write-Host "  WARN: .env.local not found, creating new one" -ForegroundColor DarkYellow
    New-Item -ItemType File -Path $EnvFile -Force | Out-Null
}

$content = Get-Content $EnvFile -Raw

# Replace or append UPSTASH_REDIS_REST_URL
if ($content -match '(?m)^UPSTASH_REDIS_REST_URL=') {
    $content = $content -replace '(?m)^UPSTASH_REDIS_REST_URL=.*', "UPSTASH_REDIS_REST_URL=`"$Url`""
} else {
    $content = $content.TrimEnd() + "`nUPSTASH_REDIS_REST_URL=`"$Url`"`n"
}

# Replace or append UPSTASH_REDIS_REST_TOKEN
if ($content -match '(?m)^UPSTASH_REDIS_REST_TOKEN=') {
    $content = $content -replace '(?m)^UPSTASH_REDIS_REST_TOKEN=.*', "UPSTASH_REDIS_REST_TOKEN=`"$Token`""
} else {
    $content = $content.TrimEnd() + "`nUPSTASH_REDIS_REST_TOKEN=`"$Token`"`n"
}

Set-Content -Path $EnvFile -Value $content -NoNewline
Write-Host "  OK" -ForegroundColor Green

# ─── 2. Update GitHub Secrets ───────────────────────────────────────

if (-not $SkipGithub) {
    Write-Host "[2/4] Updating GitHub Secrets ..." -ForegroundColor Yellow

    $ghCheck = Get-Command gh -ErrorAction SilentlyContinue
    if (-not $ghCheck) {
        Write-Host "  SKIP: gh CLI not found" -ForegroundColor DarkYellow
    } else {
        try {
            $Url | gh secret set UPSTASH_REDIS_REST_URL 2>&1 | Out-Null
            $Token | gh secret set UPSTASH_REDIS_REST_TOKEN 2>&1 | Out-Null
            Write-Host "  OK" -ForegroundColor Green
        } catch {
            Write-Host "  FAIL: $($_.Exception.Message)" -ForegroundColor Red
        }
    }
} else {
    Write-Host "[2/4] Skipped GitHub Secrets (--SkipGithub)" -ForegroundColor DarkGray
}

# ─── 3. Update Netlify env vars ─────────────────────────────────────

if (-not $SkipNetlify) {
    Write-Host "[3/4] Updating Netlify env vars ..." -ForegroundColor Yellow

    $nlCheck = Get-Command npx -ErrorAction SilentlyContinue
    if (-not $nlCheck) {
        Write-Host "  SKIP: npx not found" -ForegroundColor DarkYellow
    } else {
        # Try to find auth token from .env.local
        $nlAuth = ""
        if ($content -match '(?m)^NETLIFY_AUTH_TOKEN=(.+)') {
            $nlAuth = $Matches[1].Trim('"')
        }

        # Try to find site id from netlify.toml or .netlify/state.json
        $siteId = ""
        $stateFile = Join-Path $Root ".netlify\state.json"
        if (Test-Path $stateFile) {
            $state = Get-Content $stateFile -Raw | ConvertFrom-Json
            $siteId = $state.siteId
        }

        $nlArgs = @()
        if ($nlAuth) { $nlArgs += "--auth"; $nlArgs += $nlAuth }
        if ($siteId) { $nlArgs += "--site"; $nlArgs += $siteId }

        if (-not $nlAuth -and -not $siteId) {
            Write-Host "  SKIP: no NETLIFY_AUTH_TOKEN or .netlify/state.json found" -ForegroundColor DarkYellow
            Write-Host "  Set manually: npx netlify env:set UPSTASH_REDIS_REST_URL $Url" -ForegroundColor DarkGray
        } else {
            try {
                & npx netlify env:set UPSTASH_REDIS_REST_URL $Url @nlArgs 2>&1 | Out-Null
                & npx netlify env:set UPSTASH_REDIS_REST_TOKEN $Token @nlArgs 2>&1 | Out-Null
                Write-Host "  OK (redeploy required)" -ForegroundColor Green
            } catch {
                Write-Host "  FAIL: $($_.Exception.Message)" -ForegroundColor Red
            }
        }
    }
} else {
    Write-Host "[3/4] Skipped Netlify (--SkipNetlify)" -ForegroundColor DarkGray
}

# ─── 4. Update Render env vars (AIS Relay) ──────────────────────────

if (-not $SkipRender) {
    Write-Host "[4/4] Updating Render (AIS Relay) env vars ..." -ForegroundColor Yellow

    $renderKey = ""
    if ($content -match '(?m)^RENDER_API_KEY=(.+)') {
        $renderKey = $Matches[1].Trim('"')
    }

    if (-not $renderKey) {
        Write-Host "  SKIP: no RENDER_API_KEY found in .env.local" -ForegroundColor DarkYellow
    } else {
        try {
            # Find wm-relay service
            $services = Invoke-RestMethod -Uri "https://api.render.com/v1/services?limit=10" `
                -Headers @{ Authorization = "Bearer $renderKey"; Accept = "application/json" } `
                -Method Get
            $relay = $services | Where-Object { $_.service.name -eq "wm-relay" } | Select-Object -First 1

            if (-not $relay) {
                Write-Host "  SKIP: wm-relay service not found" -ForegroundColor DarkYellow
            } else {
                $serviceId = $relay.service.id
                Invoke-RestMethod -Uri "https://api.render.com/v1/services/$serviceId/env-vars/UPSTASH_REDIS_REST_URL" `
                    -Method Put `
                    -Headers @{ Authorization = "Bearer $renderKey"; "Content-Type" = "application/json" } `
                    -Body (@{ value = $Url } | ConvertTo-Json) | Out-Null
                Invoke-RestMethod -Uri "https://api.render.com/v1/services/$serviceId/env-vars/UPSTASH_REDIS_REST_TOKEN" `
                    -Method Put `
                    -Headers @{ Authorization = "Bearer $renderKey"; "Content-Type" = "application/json" } `
                    -Body (@{ value = $Token } | ConvertTo-Json) | Out-Null

                # Trigger redeploy
                Invoke-RestMethod -Uri "https://api.render.com/v1/services/$serviceId/deploys" `
                    -Method Post `
                    -Headers @{ Authorization = "Bearer $renderKey"; "Content-Type" = "application/json" } `
                    -Body '{}' | Out-Null
                Write-Host "  OK (redeploy triggered)" -ForegroundColor Green
            }
        } catch {
            Write-Host "  FAIL: $($_.Exception.Message)" -ForegroundColor Red
        }
    }
} else {
    Write-Host "[4/4] Skipped Render (--SkipRender)" -ForegroundColor DarkGray
}

# ─── Done ───────────────────────────────────────────────────────────

Write-Host ""
Write-Host "=== Done ===" -ForegroundColor Cyan
Write-Host "New URL:   $Url" -ForegroundColor DarkGray
Write-Host "New Token: $($Token.Substring(0, [Math]::Min(8, $Token.Length)))..." -ForegroundColor DarkGray
Write-Host ""
Write-Host "NOTE: Netlify and Render changes require a redeploy to take effect." -ForegroundColor DarkYellow
