$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'restart-runtime-slot.ps1') -Slot A
