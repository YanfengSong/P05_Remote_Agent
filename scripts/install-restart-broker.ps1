$ErrorActionPreference = 'Stop'

$repo = Split-Path -Parent $PSScriptRoot
$deployment = Join-Path $repo 'scripts\deployment'
. (Join-Path $deployment 'common.ps1')
Import-P05DotEnv -RepoRoot $repo

$taskName = if ($env:P05_OPERATOR_RESTART_TASK) {
  $env:P05_OPERATOR_RESTART_TASK
} else {
  'P05-RestartBroker'
}
$restartScript = Join-Path $deployment 'restart-runtime.ps1'
if (-not (Test-Path -LiteralPath $restartScript -PathType Leaf)) {
  throw "Restart script not found: $restartScript"
}

$actionArgs = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $restartScript + '"'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $actionArgs -WorkingDirectory $repo

$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -MultipleInstances IgnoreNew
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited

$task = New-ScheduledTask -Action $action -Principal $principal -Settings $settings -Description 'P05 fixed restart broker. Source-controlled action; no automatic trigger.'
Register-ScheduledTask -TaskName $taskName -InputObject $task -Force | Out-Null

Write-Host "Installed $taskName"
Write-Host "Action: $restartScript"
Write-Host 'Trigger: none (manual/on-demand only)'
