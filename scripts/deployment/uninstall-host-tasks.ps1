$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')
$repo = Get-P05RepoRoot -ScriptRoot $PSScriptRoot
Import-P05DotEnv -RepoRoot $repo

$activeNames = @(
  $(if ($env:P05_OPERATOR_RUNTIME_TASK) { $env:P05_OPERATOR_RUNTIME_TASK } else { 'P05-Runtime' }),
  $(if ($env:P05_OPERATOR_TASK) { $env:P05_OPERATOR_TASK } else { 'P05-Operator' })
)

# Upgrade cleanup only: current P05 no longer installs or invokes RestartBroker,
# but remove the historical task when uninstalling an older host setup.
$legacyNames = @('P05-RestartBroker')
if ($env:P05_OPERATOR_RESTART_TASK) {
  $legacyNames += $env:P05_OPERATOR_RESTART_TASK
}

foreach($name in @($activeNames + $legacyNames | Select-Object -Unique)){
  Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue
}
