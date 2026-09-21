param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')
$repo = Get-P05RepoRoot -ScriptRoot $PSScriptRoot
Import-P05DotEnv -RepoRoot $repo

$port = if ($env:P05_OPERATOR_PORT) { [int]$env:P05_OPERATOR_PORT } else { 56301 }
$url = "http://127.0.0.1:$port/"
$health = $url + 'healthz'

function Test-OperatorOnline {
    try {
        $r = Invoke-WebRequest $health -UseBasicParsing -TimeoutSec 2
        return $r.StatusCode -eq 200
    } catch { return $false }
}

if (-not (Test-OperatorOnline)) {
    & (Join-Path $PSScriptRoot 'run-operator.ps1')
}

if (-not (Test-OperatorOnline)) {
    throw "P05 Operator Console did not become ready at $url"
}
if (-not $NoBrowser) { Start-Process $url }
Write-Output $url
