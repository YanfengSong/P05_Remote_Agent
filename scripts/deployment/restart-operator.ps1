param(
    [Parameter(Mandatory=$true)]
    [string]$RequestId,
    [int]$DelayMilliseconds = 500
)
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'common.ps1')
$repo = Get-P05RepoRoot -ScriptRoot $PSScriptRoot
Import-P05DotEnv -RepoRoot $repo

$stateRoot = Join-Path $repo '.p05'
$statusPath = Join-Path $stateRoot 'operator-restart-status.json'
$entry = Join-Path $repo 'dist\operator\server.js'
New-Item -ItemType Directory -Path $stateRoot -Force | Out-Null

function Write-RestartStatus([string]$State,[string]$Message,[switch]$Finished) {
    $payload = [ordered]@{
        version = 1
        requestId = $RequestId
        state = $State
        message = $Message
        startedAt = $script:StartedAt
    }
    if ($Finished) {
        $payload.finishedAt = [DateTime]::UtcNow.ToString('o')
    }
    $temp = $statusPath + '.tmp-' + $PID
    $payload | ConvertTo-Json | Set-Content -LiteralPath $temp -Encoding UTF8
    Move-Item -LiteralPath $temp -Destination $statusPath -Force
}

$script:StartedAt = [DateTime]::UtcNow.ToString('o')
Write-RestartStatus 'running' 'Operator restart is running.'

try {
    if ($DelayMilliseconds -gt 0) {
        Start-Sleep -Milliseconds $DelayMilliseconds
    }

    $operators = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object {
        $_.CommandLine -and $_.CommandLine.IndexOf($entry,[StringComparison]::OrdinalIgnoreCase) -ge 0
    }

    foreach ($operator in $operators) {
        Stop-Process -Id $operator.ProcessId -Force -ErrorAction Stop
    }

    Start-Sleep -Milliseconds 500
    & (Join-Path $PSScriptRoot 'run-operator.ps1')
    if ($LASTEXITCODE -ne 0) {
        throw "run-operator.ps1 failed with exit code $LASTEXITCODE."
    }

    Write-RestartStatus 'succeeded' 'Operator Console restarted and health check passed.' -Finished
} catch {
    Write-RestartStatus 'failed' $_.Exception.Message -Finished
    throw
}
