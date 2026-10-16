# P05 Universal Deployment regression
#
# This test protects the V2 deployment contract:
# - active deployment assets are machine-neutral;
# - runtime/Operator paths are derived from the repository location;
# - secrets, tunnel identities and host-specific roots stay local;
# - the committed lockfile and bootstrap remain the source of reproducible dependencies.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\deployment\test-universal.ps1

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path

$required = @(
    'bootstrap.ps1',
    'P05-Operator.cmd',
    '.env.example',
    'package.json',
    'package-lock.json',
    'scripts\deployment\common.ps1',
    'scripts\deployment\launch-runtime.mjs',
    'scripts\deployment\run-runtime-slot.ps1',
    'scripts\deployment\write-runtime-profiles.ps1'
)

foreach ($relative in $required) {
    if (-not (Test-Path -LiteralPath (Join-Path $RepoRoot $relative) -PathType Leaf)) {
        throw "Required deployment asset is missing: $relative"
    }
}

$activeAssets = @(
    'bootstrap.ps1',
    'P05-Operator.cmd',
    '.env.example',
    'README.md',
    'scripts\deployment\README.md',
    'scripts\deployment\common.ps1',
    'scripts\deployment\launch-runtime.mjs',
    'scripts\deployment\run-runtime-slot.ps1',
    'scripts\deployment\write-runtime-profiles.ps1',
    'src\operator\runtime-control.ts',
    'src\operator\ui.ts'
)

$forbiddenIdentity = '(?i)(Boonray|XiaoiWu|F:\\Project_Git|C:\\Users\\EDY)'
foreach ($relative in $activeAssets) {
    $path = Join-Path $RepoRoot $relative
    $text = Get-Content -LiteralPath $path -Raw
    if ($text -match $forbiddenIdentity) {
        throw "Machine-specific identity/path found in active asset: $relative"
    }
}

$envText = Get-Content -LiteralPath (Join-Path $RepoRoot '.env.example') -Raw
foreach ($name in @(
    'REMOTE_AGENT_ALLOWED_ROOTS',
    'P05_TUNNEL_A_ID',
    'P05_TUNNEL_B_ID',
    'CONTROL_PLANE_API_KEY'
)) {
    $match = [regex]::Match($envText, '(?m)^#?\s*' + [regex]::Escape($name) + '=(.*)$')
    if (-not $match.Success) {
        throw "Portable .env.example entry is missing: $name"
    }
    if ($match.Groups[1].Value.Trim()) {
        throw ".env.example must not ship a machine-specific value for $name."
    }
}

$bootstrap = Get-Content -LiteralPath (Join-Path $RepoRoot 'bootstrap.ps1') -Raw
foreach ($needle in @(
    'tools\node',
    'tools\tunnel-client',
    'REMOTE_AGENT_ALLOWED_ROOTS = $AllowedRoots',
    'CONTROL_PLANE_API_KEY = $ApiKey'
)) {
    if ($bootstrap -notlike "*$needle*") {
        throw "Bootstrap is missing the machine-local deployment contract: $needle"
    }
}

$launcher = Get-Content -LiteralPath (Join-Path $RepoRoot 'scripts\deployment\launch-runtime.mjs') -Raw
if ($launcher -notmatch 'fileURLToPath\(import\.meta\.url\)' -or
    $launcher -notmatch 'path\.resolve\(here, "\.\.", "\.\."' -or
    $launcher -notmatch 'rawSlot !== "A" && rawSlot !== "B"') {
    throw 'Runtime launcher must derive its repository root from its own location and support A/B slots.'
}

$operatorCmd = Get-Content -LiteralPath (Join-Path $RepoRoot 'P05-Operator.cmd') -Raw
if ($operatorCmd -notmatch '%~dp0') {
    throw 'Operator launcher must resolve deployment scripts relative to its own repository location.'
}

$trackedMachineState = @(& git -C $RepoRoot ls-files -- .env .p05 dist node_modules)
if ($trackedMachineState.Count -gt 0) {
    throw ('Machine-local/generated state is tracked by Git: ' + ($trackedMachineState -join ', '))
}

$activeTracked = @(& git -C $RepoRoot ls-files)
if ($LASTEXITCODE -ne 0 -or $activeTracked.Count -lt 20) {
    throw 'Git repository does not contain the expected committed P05 source/deployment assets.'
}

Write-Host 'UNIVERSAL_DEPLOYMENT_OK' -ForegroundColor Green
