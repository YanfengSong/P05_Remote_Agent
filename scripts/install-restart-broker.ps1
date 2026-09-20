#Requires -RunAsAdministrator
$ErrorActionPreference = 'Stop'

$TaskName = 'P05-RestartBroker'
$RestartScript = 'D:\Project_Git\_p05_deploy\44_restart_runtime.ps1'

if (-not (Test-Path -LiteralPath $RestartScript -PathType Leaf)) {
    throw "Restart script not found: $RestartScript"
}

$ActionArgs = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $RestartScript + '"'
$Action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $ActionArgs

$Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -MultipleInstances IgnoreNew

$Principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

$Task = New-ScheduledTask -Action $Action -Principal $Principal -Settings $Settings -Description 'P05 external restart broker. Fixed action; no automatic trigger.'

Register-ScheduledTask -TaskName $TaskName -InputObject $Task -Force | Out-Null

Write-Host 'P05-RestartBroker installed.'
Write-Host "Action: powershell.exe ... -File $RestartScript"
Write-Host 'Trigger: none (manual/on-demand only)'
