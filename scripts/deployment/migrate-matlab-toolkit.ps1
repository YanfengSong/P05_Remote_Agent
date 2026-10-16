[CmdletBinding()]
param(
    [switch]$RemoveLegacy
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$TargetRoot = Join-Path $RepoRoot ".p05\tools\matlab\agentic-toolkits"
$TargetServer = Join-Path $TargetRoot "bin\matlab-mcp-server.exe"
$LegacyRoot = Join-Path $env:USERPROFILE ".matlab\agentic-toolkits"

if (Test-Path -LiteralPath $TargetServer -PathType Leaf) {
    Write-Host "Repo-local MATLAB Agentic Toolkit already exists: $TargetRoot" -ForegroundColor Green
    if ($RemoveLegacy -and (Test-Path -LiteralPath $LegacyRoot -PathType Container)) {
        Remove-Item -LiteralPath $LegacyRoot -Recurse -Force
        Write-Host "Removed legacy MATLAB Agentic Toolkit: $LegacyRoot" -ForegroundColor Green
    }
    exit 0
}

if (-not (Test-Path -LiteralPath $LegacyRoot -PathType Container)) {
    throw "Legacy MATLAB Agentic Toolkit was not found at $LegacyRoot. Install it first, then rerun this migration."
}

New-Item -ItemType Directory -Path $TargetRoot -Force | Out-Null
Get-ChildItem -LiteralPath $LegacyRoot -Force | ForEach-Object {
    if ($_.Name -ieq "config.json") { return }
    Copy-Item -LiteralPath $_.FullName -Destination $TargetRoot -Recurse -Force
}

if (-not (Test-Path -LiteralPath $TargetServer -PathType Leaf)) {
    throw "Migration finished but repo-local MATLAB MCP Server was not found at $TargetServer."
}

Write-Host "Repo-local MATLAB Agentic Toolkit ready: $TargetRoot" -ForegroundColor Green
Write-Host "The host-specific legacy config.json was intentionally not copied." -ForegroundColor Yellow

if ($RemoveLegacy) {
    Remove-Item -LiteralPath $LegacyRoot -Recurse -Force
    Write-Host "Removed legacy MATLAB Agentic Toolkit: $LegacyRoot" -ForegroundColor Green
} else {
    Write-Host "Legacy toolkit remains at $LegacyRoot." -ForegroundColor Yellow
    Write-Host "After verification, rerun with -RemoveLegacy to delete the old P05 toolkit." -ForegroundColor Yellow
}
