param(
    [int]$WaitSeconds = 20,
    [int]$DelayMilliseconds = 500
)
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'common.ps1')
$repo = Get-P05RepoRoot -ScriptRoot $PSScriptRoot
Import-P05DotEnv -RepoRoot $repo

$stateRoot = Join-Path $repo '.p05'
$statusPath = Join-Path $stateRoot 'operator-restart-status.json'
$stdout = Join-Path $stateRoot 'operator-restart.log'
$stderr = Join-Path $stateRoot 'operator-restart.err.log'
$restart = Join-Path $PSScriptRoot 'restart-operator.ps1'
$requestId = [guid]::NewGuid().ToString()
New-Item -ItemType Directory -Path $stateRoot -Force | Out-Null

$args = @(
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy','Bypass',
    '-File',('"' + $restart + '"'),
    '-RequestId',$requestId,
    '-DelayMilliseconds',[string]$DelayMilliseconds
)

Start-Process -FilePath 'powershell.exe' -ArgumentList $args -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr | Out-Null

$deadline = [DateTime]::UtcNow.AddSeconds([Math]::Max(1,$WaitSeconds))
do {
    Start-Sleep -Milliseconds 250
    if (Test-Path -LiteralPath $statusPath -PathType Leaf) {
        try {
            $status = Get-Content -LiteralPath $statusPath -Raw | ConvertFrom-Json
            if ($status.requestId -eq $requestId) {
                if ($status.state -eq 'succeeded') {
                    Write-Output "OPERATOR_RESTARTED: $($status.message)"
                    exit 0
                }
                if ($status.state -eq 'failed') {
                    throw "Operator restart failed: $($status.message)"
                }
            }
        } catch {
            if ($_.Exception.Message -like 'Operator restart failed:*') {
                throw
            }
        }
    }
} while ([DateTime]::UtcNow -lt $deadline)

Write-Output "OPERATOR_RESTART_SCHEDULED: requestId=$requestId; completion is still pending in the background."
