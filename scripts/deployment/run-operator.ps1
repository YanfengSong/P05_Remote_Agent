$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')
$repo = Get-P05RepoRoot -ScriptRoot $PSScriptRoot
Import-P05DotEnv -RepoRoot $repo
$node = Resolve-P05Node -RepoRoot $repo
$port = if ($env:P05_OPERATOR_PORT) { [int]$env:P05_OPERATOR_PORT } else { 56301 }
$health = "http://127.0.0.1:$port/healthz"

try {
    $existing = Invoke-WebRequest $health -UseBasicParsing -TimeoutSec 2
    if ($existing.StatusCode -eq 200) { exit 0 }
} catch {}

$entry = Join-Path $repo 'dist\operator\server.js'
if (-not (Test-Path -LiteralPath $entry -PathType Leaf)) { throw "Operator build output not found: $entry" }
$state = Join-Path $repo '.p05'
New-Item -ItemType Directory -Path $state -Force | Out-Null
$stdout = Join-Path $state 'operator-console.log'
$stderr = Join-Path $state 'operator-console.err.log'
$envFile = Join-Path $repo '.env'

Start-Process -FilePath $node `
    -ArgumentList @("--env-file-if-exists=$envFile",$entry) `
    -WorkingDirectory $repo `
    -WindowStyle Hidden `
    -RedirectStandardOutput $stdout `
    -RedirectStandardError $stderr

for ($i=0; $i -lt 30; $i++) {
    Start-Sleep -Milliseconds 500
    try {
        $r = Invoke-WebRequest $health -UseBasicParsing -TimeoutSec 2
        if ($r.StatusCode -eq 200) { exit 0 }
    } catch {}
}
throw "Operator Console did not become ready at $health"
