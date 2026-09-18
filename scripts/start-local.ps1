# P05 Remote Agent - local startup script
#
# Checks the toolchain, builds, resolves the tool profile, prints the startup banner
# and starts the local Streamable HTTP gateway (stdio -> Supergateway -> 127.0.0.1).
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts\start-local.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\start-local.ps1 -Profile readonly
#   powershell -ExecutionPolicy Bypass -File scripts\start-local.ps1 -Probe
#
#   -Profile <name>  override P05_TOOL_PROFILE for this run (discovery|readonly|developer|full)
#   -Port <n>        gateway port (default 8765)
#   -Probe           start, wait for /healthz, report, then stop (a pre-tunnel check)

[CmdletBinding()]
param(
    [string]$Profile = "",
    [int]$Port = 8765,
    [switch]$Probe
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $RepoRoot

function Write-Step([string]$Message) { Write-Host "==> $Message" -ForegroundColor Cyan }
function Fail([string]$Message) {
    Write-Host "FAIL: $Message" -ForegroundColor Red
    exit 1
}

# --- 1. Node ------------------------------------------------------------------
Write-Step "checking Node.js"
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCommand) { Fail "node was not found on PATH. Install Node.js 22 or newer." }
$nodeVersion = (& node --version).Trim()
Write-Host "    node $nodeVersion"

# --- 2. dependencies ----------------------------------------------------------
Write-Step "checking dependencies"
if (-not (Test-Path (Join-Path $RepoRoot "node_modules"))) {
    Write-Host "    node_modules missing, running npm install"
    & npm install
    if ($LASTEXITCODE -ne 0) { Fail "npm install failed (exit $LASTEXITCODE)" }
} else {
    Write-Host "    node_modules present"
}

# --- 3. build -----------------------------------------------------------------
Write-Step "building"
& npm run build
if ($LASTEXITCODE -ne 0) { Fail "npm run build failed (exit $LASTEXITCODE)" }

# --- 4. tool profile ----------------------------------------------------------
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

# Validate before starting: the server refuses an unknown value, and so does this banner.
$knownProfiles = @("discovery", "readonly", "developer", "full")
if (-not ($knownProfiles -contains $effectiveProfile.ToLower())) {
    Fail "unknown tool profile '$effectiveProfile'. Expected one of: $($knownProfiles -join ', ')"
}
$effectiveProfile = $effectiveProfile.ToLower()

# --- 5. identity --------------------------------------------------------------
$hostName = (& node -e "process.stdout.write(require('os').hostname())").Trim()
$deviceId = "unknown"
$identityPath = Join-Path $RepoRoot ".p05\device.json"
if (Test-Path $identityPath) {
    $deviceId = (Get-Content -LiteralPath $identityPath -Raw | ConvertFrom-Json).deviceId
} else {
    Write-Host "    .p05\device.json not found; it will be created on first run" -ForegroundColor Yellow
}

$mcpUrl = "http://127.0.0.1:$Port/mcp"
$healthUrl = "http://127.0.0.1:$Port/healthz"

# --- 6. port availability -----------------------------------------------------
# Without this the health probe below can be answered by a gateway that was already
# listening, which would report success for a start that never happened.
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

$supergatewayArgs = @(
    "-y", "supergateway@4.0.0-rc.1",
    "--stdio", "node --env-file-if-exists=.env dist/index.js",
    "--outputTransport", "streamableHttp",
    "--port", "$Port",
    "--streamableHttpPath", "/mcp",
    "--healthEndpoint", "/healthz"
)

if ($Probe) {
    Write-Step "probe mode: starting gateway and waiting for $healthUrl"
    # Start-Process cannot launch the npx.cmd shim directly, and this keeps the probe on
    # exactly the same command line the normal start uses.
    $quotedArgs = ($supergatewayArgs | ForEach-Object { if ($_ -match '\s') { "'$_'" } else { $_ } }) -join " "
    $process = Start-Process -FilePath "powershell.exe" `
        -ArgumentList @("-NoProfile", "-Command", "npx $quotedArgs") `
        -PassThru -WindowStyle Hidden
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
        # Kill only this process tree; never touch other node processes on the machine.
        if (-not $process.HasExited) {
            & taskkill /PID $process.Id /T /F | Out-Null
        }
    }
}

Write-Step "starting gateway on port $Port (Ctrl+C to stop)"
& npx @supergatewayArgs
exit $LASTEXITCODE
