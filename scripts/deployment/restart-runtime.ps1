$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot 'common.ps1')
$ctx = Get-P05DeploymentContext -ScriptRoot $PSScriptRoot
$runtimeTask = if ($env:P05_OPERATOR_RUNTIME_TASK) { $env:P05_OPERATOR_RUNTIME_TASK } else { 'P05-Runtime' }

function Get-P05RuntimeNode {
    $entryA = $ctx.McpEntry
    $entryB = $ctx.McpEntry -replace '\\','/'
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and ($_.CommandLine -like "*$entryA*" -or $_.CommandLine -like "*$entryB*") }
}

function Get-P05Tunnel {
    Get-CimInstance Win32_Process -Filter "Name='tunnel-client.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and ($_.CommandLine -like "*$($ctx.Profile)*" -or $_.CommandLine -like "*$($ctx.Alias)*") }
}

Write-Host "Stopping managed runtime alias $($ctx.Alias)"
& $ctx.TunnelClient runtimes stop $ctx.Alias 2>&1 | ForEach-Object { Write-Host "  $_" }
Get-P05Tunnel | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Get-P05RuntimeNode | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
if ($ctx.HealthUrlFile) { Remove-Item $ctx.HealthUrlFile -Force -ErrorAction SilentlyContinue }

Start-Sleep -Seconds 2
Start-ScheduledTask -TaskName $runtimeTask
Write-Host "Started task $runtimeTask"

$ready = $false
for ($i=0; $i -lt 40; $i++) {
    Start-Sleep -Seconds 3
    if ($ctx.HealthUrlFile -and (Test-Path $ctx.HealthUrlFile)) {
        $base = (Get-Content $ctx.HealthUrlFile -Raw).Trim()
        try {
            $r = Invoke-WebRequest "$base/readyz" -UseBasicParsing -TimeoutSec 4
            if ($r.StatusCode -eq 200) { $ready = $true; break }
        } catch {}
    }
}
if (-not $ready) { throw 'P05 runtime did not become ready within 120 seconds.' }
Write-Host 'P05 runtime restart complete.'
