[CmdletBinding()]
param(
    [switch]$SkipVerify,
    [string]$Message = "chore: publish golden state"
)

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
Set-Location -LiteralPath $RepoRoot

function Fail([string]$Message) {
    Write-Host "FAIL: $Message" -ForegroundColor Red
    exit 1
}

function Step([string]$Message) {
    Write-Host "==> $Message" -ForegroundColor Cyan
}

$Node = Join-Path $RepoRoot ".p05\tools\node\node.exe"
$NpmCli = Join-Path $RepoRoot ".p05\tools\node\node_modules\npm\bin\npm-cli.js"
if (-not (Test-Path -LiteralPath $Node)) { Fail "Repo-local Node.js is missing. Run the deployment bootstrap first." }
if (-not (Test-Path -LiteralPath $NpmCli)) { Fail "Repo-local npm is missing. Run the deployment bootstrap first." }

Step "checking clean source tree"
$dirty = @(git status --porcelain)
if ($dirty.Count -gt 0) {
    $dirty | ForEach-Object { Write-Host "    $_" -ForegroundColor Yellow }
    Fail "Commit the code changes before publishing Golden State. This keeps the manifest tied to a known code commit."
}

if (-not $SkipVerify) {
    Step "running full verification"
    & $Node $NpmCli run verify
    if ($LASTEXITCODE -ne 0) { Fail "Verification failed." }
}

Step "exporting Golden State"
& $Node $NpmCli run sync:export
if ($LASTEXITCODE -ne 0) { Fail "Golden State export failed." }

$manifest = Join-Path $RepoRoot "sync\golden-state.json"
if (-not (Test-Path -LiteralPath $manifest)) { Fail "Golden State manifest was not generated." }

Step "validating manifest contains no host secrets or paths"
$raw = Get-Content -LiteralPath $manifest -Raw
if ($raw -match '(?i)(apiKey|apiSecret|clientSecret|accessToken|refreshToken|password|privateKey)') {
    Fail "Golden State contains a forbidden sensitive field."
}
if ($raw -match [regex]::Escape($env:USERPROFILE)) {
    Fail "Golden State contains the current user's profile path."
}

Step "staging Golden State only"
git add -- sync/golden-state.json
if ($LASTEXITCODE -ne 0) { Fail "git add failed." }

$staged = @(git diff --cached --name-only)
if (($staged | Where-Object { $_ -ne "sync/golden-state.json" }).Count -gt 0) {
    git reset -- sync/golden-state.json | Out-Null
    Fail "Publish would stage files other than sync/golden-state.json."
}

$cached = git diff --cached --quiet -- sync/golden-state.json
if ($LASTEXITCODE -eq 0) {
    Write-Host "Golden State is unchanged; nothing to commit." -ForegroundColor Green
    exit 0
}

Step "committing Golden State"
git commit -m $Message
if ($LASTEXITCODE -ne 0) { Fail "Golden State commit failed." }

Write-Host ""
Write-Host "GOLDEN_STATE_PUBLISHED" -ForegroundColor Green
Write-Host "Push the current V2 branch to origin to make this state available to other machines."
