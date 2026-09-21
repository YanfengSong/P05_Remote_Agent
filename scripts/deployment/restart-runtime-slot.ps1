param(
    [Parameter(Mandatory=$true)]
    [ValidateSet('A','B')]
    [string]$Slot,
    [int]$DelayMilliseconds = 0
)
$ErrorActionPreference = 'Stop'
if ($DelayMilliseconds -gt 0) {
    Start-Sleep -Milliseconds $DelayMilliseconds
}
& (Join-Path $PSScriptRoot 'stop-runtime-slot.ps1') -Slot $Slot
Start-Sleep -Milliseconds 500
& (Join-Path $PSScriptRoot 'run-runtime-slot.ps1') -Slot $Slot
