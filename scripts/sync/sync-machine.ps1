[CmdletBinding()]
param(
    [string]$Branch = "V2",
    [switch]$SkipPull,
    [switch]$SkipRestart,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
Set-Location -LiteralPath $RepoRoot

function Step([string]$Message) { Write-Host "==> $Message" -ForegroundColor Cyan }
function Fail([string]$Message) {
    Write-Host "FAIL: $Message" -ForegroundColor Red
    exit 1
}
function Run-Native([string]$FilePath, [string[]]$Arguments) {
    & $FilePath @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$FilePath failed with exit code $LASTEXITCODE."
    }
}

$Node = Join-Path $RepoRoot ".p05\tools\node\node.exe"
$NpmCli = Join-Path $RepoRoot ".p05\tools\node\node_modules\npm\bin\npm-cli.js"
$EnvFile = Join-Path $RepoRoot ".env"
$Manifest = Join-Path $RepoRoot "sync\golden-state.json"

if (-not (Test-Path -LiteralPath $Node)) { Fail "Repo-local Node.js is missing. Run the deployment bootstrap first." }
if (-not (Test-Path -LiteralPath $NpmCli)) { Fail "Repo-local npm is missing. Run the deployment bootstrap first." }
if (-not (Test-Path -LiteralPath $EnvFile)) { Fail ".env is missing. Run the deployment bootstrap first." }

Step "checking Git working tree"
$dirty = @(git status --porcelain)
if ($dirty.Count -gt 0) {
    $dirty | ForEach-Object { Write-Host "    $_" -ForegroundColor Yellow }
    Fail "Working tree is not clean. State Sync refuses to overwrite local code/config changes."
}

$currentBranch = (git branch --show-current).Trim()
if ($currentBranch -ne $Branch) {
    Fail "Current branch is '$currentBranch'. State Sync expects '$Branch'."
}

$upstream = ""
try { $upstream = (git rev-parse --abbrev-ref --symbolic-full-name "@{u}").Trim() } catch {}
if (-not $upstream) {
    Fail "Branch '$Branch' has no upstream. Configure origin/$Branch before using State Sync."
}

$before = (git rev-parse HEAD).Trim()

if (-not $SkipPull) {
    Step "pulling latest Git state"
    if ($DryRun) {
        git pull --ff-only --dry-run
        if ($LASTEXITCODE -ne 0) { Fail "Git dry-run pull failed." }
    } else {
        Run-Native "git" @("pull", "--ff-only")
    }
}

$after = (git rev-parse HEAD).Trim()
Write-Host "    Git: $before -> $after"

if (-not (Test-Path -LiteralPath $Manifest)) {
    Fail "sync/golden-state.json is missing from the current Git revision. Publish Golden State on Boonray first."
}

$desired = Get-Content -LiteralPath $Manifest -Raw | ConvertFrom-Json
if ($desired.kind -ne "p05-golden-state" -or [int]$desired.schemaVersion -ne 1) {
    Fail "Unsupported Golden State schema."
}

Step "checking source commit relationship"
$sourceCommit = [string]$desired.source.gitCommit
if ($sourceCommit -and $sourceCommit -match '^[0-9a-fA-F]{40}$') {
    git merge-base --is-ancestor $sourceCommit HEAD
    if ($LASTEXITCODE -ne 0) {
        Fail "Current Git HEAD does not contain the Golden State source commit $sourceCommit."
    }
} else {
    Fail "Golden State has no valid source Git commit."
}

$changedDependencyFiles = @()
if ($before -ne $after) {
    $changedDependencyFiles = @(git diff --name-only $before $after -- package.json package-lock.json)
}

if ($DryRun) {
    Write-Host "DRY RUN: would build and apply revision $($desired.revision)." -ForegroundColor Yellow
    if ($changedDependencyFiles.Count -gt 0) {
        Write-Host "DRY RUN: would run npm ci because dependency files changed." -ForegroundColor Yellow
    }
    exit 0
}

if ($changedDependencyFiles.Count -gt 0 -or -not (Test-Path -LiteralPath (Join-Path $RepoRoot "node_modules"))) {
    Step "installing exact locked dependencies"
    Run-Native $Node @($NpmCli, "ci")
}

Step "building current Git revision"
Run-Native $Node @($NpmCli, "run", "build")

Step "applying Golden State"
Run-Native $Node @("--env-file-if-exists=$EnvFile", (Join-Path $RepoRoot "scripts\sync\apply-golden-state.mjs"), "sync/golden-state.json")

Step "regenerating local Runtime profiles"
& (Join-Path $RepoRoot "scripts\deployment\write-runtime-profiles.ps1")
if ($LASTEXITCODE -ne 0) { throw "Runtime profile generation failed with exit code $LASTEXITCODE." }

Step "verifying local state"
$driftOutput = & $Node "--env-file-if-exists=$EnvFile" (Join-Path $RepoRoot "scripts\sync\check-drift.mjs") "sync/golden-state.json"
$driftExit = $LASTEXITCODE
$driftOutput | ForEach-Object { Write-Host $_ }
if ($driftExit -ne 0) {
    Fail "State Sync completed with unresolved drift. Runtime restart was skipped."
}

if (-not $SkipRestart) {
    Step "restarting active Runtime slots"
    $slots = @()
    $slotRaw = ""
    foreach ($line in Get-Content -LiteralPath $EnvFile) {
        $trimmed = $line.Trim()
        if ($trimmed -match '^P05_RUNTIME_SLOTS\s*=\s*(.*)$') {
            $slotRaw = $Matches[1].Trim()
            break
        }
    }
    if ($slotRaw) {
        $slots = @($slotRaw.Split(',') | ForEach-Object { $_.Trim().ToUpperInvariant() } | Where-Object { $_ })
    }

    . (Join-Path $RepoRoot "scripts\deployment\common.ps1")
    Import-P05DotEnv -RepoRoot $RepoRoot
    foreach ($slot in $slots) {
        $ctx = Get-P05SlotContext -ScriptRoot (Join-Path $RepoRoot "scripts\sync") -Slot $slot
        $ready = $false
        if (Test-Path -LiteralPath $ctx.HealthUrlFile) {
            try {
                $base = (Get-Content -LiteralPath $ctx.HealthUrlFile -Raw).Trim()
                if ($base) {
                    $r = Invoke-WebRequest ($base + "/readyz") -UseBasicParsing -TimeoutSec 2
                    $ready = $r.StatusCode -eq 200
                }
            } catch {}
        }
        if ($ready) {
            & (Join-Path $RepoRoot "scripts\deployment\restart-runtime-slot.ps1") -Slot $slot
            if ($LASTEXITCODE -ne 0) { throw "Runtime $slot restart failed." }
        } else {
            Write-Host "    Runtime $slot is not currently ready; leaving it stopped." -ForegroundColor Yellow
        }
    }

    Step "restarting Operator Console when running"
    $operatorEntry = Join-Path $RepoRoot "dist\operator\server.js"
    $operators = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        $_.Name -eq "node.exe" -and $_.CommandLine -and
        $_.CommandLine.IndexOf($operatorEntry, [StringComparison]::OrdinalIgnoreCase) -ge 0
    })
    if ($operators.Count -gt 0) {
        foreach ($operator in $operators) {
            Stop-Process -Id $operator.ProcessId -Force -ErrorAction Stop
        }
        Start-Sleep -Milliseconds 500
        & (Join-Path $RepoRoot "scripts\deployment\run-operator.ps1")
        if ($LASTEXITCODE -ne 0) { throw "Operator Console restart failed." }
    } else {
        Write-Host "    Operator Console is not running; leaving it stopped." -ForegroundColor Yellow
    }
}

Write-Host ""
Write-Host "P05 STATE SYNC OK" -ForegroundColor Green
Write-Host "  Git HEAD:       $after"
Write-Host "  State revision: $($desired.revision)"
Write-Host "  Source commit:  $sourceCommit"
Write-Host "  Local identity: preserved"
