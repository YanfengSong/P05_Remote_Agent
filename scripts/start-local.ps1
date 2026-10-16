# P05 Remote Agent - local startup compatibility script
#
# The canonical V2 deployment path is bootstrap.ps1 + Runtime/Operator scripts.
# This script remains for local Streamable HTTP gateway diagnostics, but it uses
# the same repo-local Node/npm/npx toolchain as the deployment path.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts\start-local.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\start-local.ps1 -Profile readonly
#   powershell -ExecutionPolicy Bypass -File scripts\start-local.ps1 -Probe

[CmdletBinding()]
param(
    [string]$Profile = "",
    [int]$Port = 8765,
    [switch]$Probe
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $RepoRoot

. (Join-Path $RepoRoot 'scripts\deployment\common.ps1')

function Write-Step([string]$Message) { Write-Host "==> $Message" -ForegroundColor Cyan }
function Fail([string]$Message) {
    Write-Host "FAIL: $Message" -ForegroundColor Red
    exit 1
}

# --- 1. repo-local toolchain ---------------------------------------------------
Write-Step "checking repo-local Node.js"
try {
    $node = Resolve-P05Node -RepoRoot $RepoRoot
} catch {
    Fail $_.Exception.Message
}
$nodeVersion = (& $node --version).Trim()
Write-Host "    node $nodeVersion"

$nodeDir = Split-Path -Parent $node
$npm = Join-Path $nodeDir "npm.cmd"
$npx = Join-Path $nodeDir "npx.cmd"
if (-not (Test-Path -LiteralPath $npm -PathType Leaf) -or
    -not (Test-Path -LiteralPath $npx -PathType Leaf)) {
    Fail "Repo-local npm/npx is missing. Run bootstrap.ps1."
}

# --- 2. dependencies ----------------------------------------------------------
Write-Step "checking dependencies"
if (-not (Test-Path (Join-Path $RepoRoot "node_modules"))) {
    Write-Host "    node_modules missing, running repo-local npm ci"
    & $npm ci
    if ($LASTEXITCODE -ne 0) { Fail "npm ci failed (exit $LASTEXITCODE)" }
} else {
    Write-Host "    node_modules present"
}

# --- 3. build -----------------------------------------------------------------
Write-Step "building"
& $npm run build
if ($LASTEXITCODE -ne 0) { Fail "npm run build failed (exit $LASTEXITCODE)" }

# --- 4. tool profile -----------------------------------------------------------
$envFile = Join-Path $RepoRoot ".env"
$envProfile = $null
if (Test-Path $envFile) {
    $line = Select-String -Path $envFile -Pattern '^\s*P05_TOOL_PROFILE\s*=\s*(.+)$' | Select-Object -First 1
    if ($line) { $envProfile = $line.Matches[0].Groups[1].Value.Trim() }
}
if ($Profile) {
    $effectiveProfile = $Profile
    $profileSource = "command line"
} elseif ($env:P05_TOOL_PROFILE) {
    $effectiveProfile = $env:P05_TOOL_PROFILE
    $profileSource = "environment"
} elseif ($envProfile) {
    $effectiveProfile = $envProfile
    $profileSource = ".env"
} else {
    $effectiveProfile = "discovery"
    $profileSource = "default"
}
$env:P05_TOOL_PROFILE = $effectiveProfile

$knownProfiles = @("discovery", "readonly", "developer", "full")
if (-not ($knownProfiles -contains $effectiveProfile.ToLower())) {
    Fail "unknown tool profile '$effectiveProfile'. Expected one of: $($knownProfiles -join ', ')"
}
$effectiveProfile = $effectiveProfile.ToLower()

# --- 5. identity --------------------------------------------------------------
$hostName = (& $node -e "process.stdout.write(require('os').hostname())").Trim()
$deviceId = "unknown"
$identityPath = Join-Path $RepoRoot ".p05\device.json"
if (Test-Path $identityPath) {
    $deviceId = (Get-Content -LiteralPath $identityPath -Raw | ConvertFrom-Json).deviceId
} else {
    Write-Host "    .p05\device.json not found; it will be created on first run" -ForegroundColor Yellow
}

$entry = Join-Path $RepoRoot "dist\index.js"
$mcpUrl = "http://127.0.0.1:$Port/mcp"
$healthUrl = "http://127.0.0.1:$Port/healthz"

# --- 6. port availability -----------------------------------------------------
Write-Step "checking port $Port"
$listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($listener) {
    $owner = Get-Process -Id $listener.OwningProcess -ErrorAction SilentlyContinue
    $ownerName = if ($owner) { "$($owner.ProcessName) (started $($owner.StartTime))" } else { "unknown" }
    Fail "port $Port is already in use by PID $($listener.OwningProcess) - $ownerName. Stop that process or pass -Port <other>."
}
Write-Host "    port $Port is free"

# --- 7. banner ----------------------------------------------------------------
Write-Host ""
Write-Host "P05 Remote Agent" -ForegroundColor Green
Write-Host "  Device:"
Write-Host "    hostname: $hostName"
Write-Host "    deviceId: $deviceId"
Write-Host "  Tool profile:"
Write-Host "    $effectiveProfile ($profileSource)"
Write-Host "  MCP:"
Write-Host "    $mcpUrl"
Write-Host "  Health:"
Write-Host "    $healthUrl"
Write-Host ""

$stdioCommand = '"' + $node + '" --env-file-if-exists="' + $envFile + '" "' + $entry + '"'
$supergatewayArgs = @(
    "-y", "supergateway@4.0.0-rc.1",
    "--stdio", $stdioCommand,
    "--outputTransport", "streamableHttp",
    "--port", "$Port",
    "--streamableHttpPath", "/mcp",
    "--healthEndpoint", "/healthz"
)

if ($Probe) {
    Write-Step "probe mode: starting gateway and waiting for $healthUrl"
    $process = Start-Process -FilePath $npx -ArgumentList $supergatewayArgs -PassThru -WindowStyle Hidden
    try {
        $ready = $false
        for ($i = 0; $i -lt 30; $i++) {
            Start-Sleep -Seconds 1
            try {
                $response = Invoke-WebRequest -Uri $healthUrl -UseBasicParsing -TimeoutSec 2
                if ($response.StatusCode -eq 200) { $ready = $true; break }
            } catch { }
        }
        if ($ready) {
            Write-Host "OK: $healthUrl returned 200 (profile $effectiveProfile, $hostName)" -ForegroundColor Green
            exit 0
        }
        Write-Host "FAIL: $healthUrl did not become ready within 30s" -ForegroundColor Red
        exit 1
    } finally {
        if ($process -and -not $process.HasExited) {
            & taskkill /PID $process.Id /T /F | Out-Null
        }
    }
}

Write-Step "starting gateway on port $Port (Ctrl+C to stop)"
& $npx @supergatewayArgs
exit $LASTEXITCODE
