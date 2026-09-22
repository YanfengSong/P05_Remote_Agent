param(
    [string]$RepoRoot,
    [string]$AllowedRoots,
    [ValidateSet('PreInstall','PostInstall')]
    [string]$Stage = 'PreInstall',
    [string]$ExpectedNodeVersion = '22.23.1',
    [string]$ExpectedTunnelVersion = '0.0.14',
    [switch]$ManagedRequired,
    [switch]$Json
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'preflight-lib.ps1')

if (-not $RepoRoot) {
    $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
}
if (-not $AllowedRoots) { $AllowedRoots = $RepoRoot }

$report = Invoke-P05Preflight -RepoRoot $RepoRoot -AllowedRoots $AllowedRoots -Stage $Stage -ExpectedNodeVersion $ExpectedNodeVersion -ExpectedTunnelVersion $ExpectedTunnelVersion -ManagedRequired:$ManagedRequired
if ($Json) {
    $report | ConvertTo-Json -Depth 6
} else {
    Write-P05PreflightReport -Report $report
}
if ($report.overall -eq 'FAIL') { exit 1 }
