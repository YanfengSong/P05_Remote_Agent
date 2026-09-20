param([switch]$StartNow)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')
$repo = Get-P05RepoRoot -ScriptRoot $PSScriptRoot
Import-P05DotEnv -RepoRoot $repo

$runtimeName = if ($env:P05_OPERATOR_RUNTIME_TASK) { $env:P05_OPERATOR_RUNTIME_TASK } else { 'P05-Runtime' }
$restartName = if ($env:P05_OPERATOR_RESTART_TASK) { $env:P05_OPERATOR_RESTART_TASK } else { 'P05-RestartBroker' }
$operatorName = if ($env:P05_OPERATOR_TASK) { $env:P05_OPERATOR_TASK } else { 'P05-Operator' }
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name

$runtimeScript = Join-Path $PSScriptRoot 'run-runtime.ps1'
$restartScript = Join-Path $PSScriptRoot 'restart-runtime.ps1'
$operatorScript = Join-Path $PSScriptRoot 'run-operator.ps1'
foreach ($script in @($runtimeScript,$restartScript,$operatorScript)) {
    if (-not (Test-Path -LiteralPath $script -PathType Leaf)) { throw "Deployment script missing: $script" }
}

function New-P05PowerShellAction([string]$script) {
    $args = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $script + '"'
    return New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $args -WorkingDirectory $repo
}

$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -StartWhenAvailable

$runtimeTrigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$runtimeTrigger.Delay = 'PT8S'
$runtimeTask = New-ScheduledTask -Action (New-P05PowerShellAction $runtimeScript) -Trigger $runtimeTrigger -Principal $principal -Settings $settings -Description 'P05 tunnel/MCP runtime. Source-controlled action; starts at user logon.'
Register-ScheduledTask -TaskName $runtimeName -InputObject $runtimeTask -Force | Out-Null

$restartSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 5)
$restartTask = New-ScheduledTask -Action (New-P05PowerShellAction $restartScript) -Principal $principal -Settings $restartSettings -Description 'P05 fixed restart broker. No trigger; callable on demand.'
Register-ScheduledTask -TaskName $restartName -InputObject $restartTask -Force | Out-Null

$operatorTrigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$operatorTrigger.Delay = 'PT12S'
$operatorTask = New-ScheduledTask -Action (New-P05PowerShellAction $operatorScript) -Trigger $operatorTrigger -Principal $principal -Settings $settings -Description 'P05 local Operator Console on loopback.'
Register-ScheduledTask -TaskName $operatorName -InputObject $operatorTask -Force | Out-Null

if ($StartNow) {
    Start-ScheduledTask -TaskName $operatorName
    $ctx = Get-P05DeploymentContext -ScriptRoot $PSScriptRoot
    $statusRaw = & $ctx.TunnelClient runtimes status $ctx.Alias --json
    $running = $false
    if ($LASTEXITCODE -eq 0) {
        try { $running = [bool](($statusRaw | ConvertFrom-Json).process_running) } catch {}
    }
    if (-not $running) { Start-ScheduledTask -TaskName $runtimeName }
}

Get-ScheduledTask -TaskName $runtimeName,$restartName,$operatorName |
    ForEach-Object {
        [pscustomobject]@{
            TaskName=$_.TaskName
            State=[string]$_.State
            Actions=@($_.Actions | ForEach-Object { $_.Execute + ' ' + $_.Arguments })
            TriggerCount=@($_.Triggers | Where-Object { $_ }).Count
        }
    } | ConvertTo-Json -Depth 5
