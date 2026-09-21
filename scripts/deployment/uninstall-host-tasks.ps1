$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')
$repo = Get-P05RepoRoot -ScriptRoot $PSScriptRoot
Import-P05DotEnv -RepoRoot $repo
$names=@(
  $(if ($env:P05_OPERATOR_RUNTIME_TASK) { $env:P05_OPERATOR_RUNTIME_TASK } else { 'P05-Runtime' }),
  $(if ($env:P05_OPERATOR_RESTART_TASK) { $env:P05_OPERATOR_RESTART_TASK } else { 'P05-RestartBroker' }),
  $(if ($env:P05_OPERATOR_TASK) { $env:P05_OPERATOR_TASK } else { 'P05-Operator' })
)
foreach($name in $names){ Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue }
