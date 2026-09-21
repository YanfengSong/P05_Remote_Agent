param(
    [Parameter(Mandatory=$true)]
    [ValidateSet('A','B')]
    [string]$Slot
)
$ErrorActionPreference = 'Stop'
$restart = Join-Path $PSScriptRoot 'restart-runtime-slot.ps1'
$args = @(
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy','Bypass',
    '-File',('"' + $restart + '"'),
    '-Slot',$Slot,
    '-DelayMilliseconds','1500'
)
Start-Process -FilePath 'powershell.exe' -ArgumentList $args -WindowStyle Hidden | Out-Null
Write-Output "Runtime $Slot restart scheduled."
