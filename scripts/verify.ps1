# P05 Remote Agent - verification pipeline
#
# Runs everything section 20 of the execution plan asks for and prints one summary.
# The extra checks it lists (device id stable, allowed root escape denied, dangerous
# command denied, discovery/readonly tool lists correct) live inside the test suite,
# so a green run here means those assertions ran.
#
# Usage: powershell -ExecutionPolicy Bypass -File scripts\verify.ps1

[CmdletBinding()]
param()

$ErrorActionPreference = "Continue"
$RepoRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $RepoRoot

$results = New-Object System.Collections.ArrayList
$started = Get-Date

function Invoke-Step([string]$Name, [scriptblock]$Command, [string]$Marker) {
    Write-Host ""
    Write-Host "==> $Name" -ForegroundColor Cyan
    $output = & $Command 2>&1
    $code = $LASTEXITCODE
    $text = ($output | Out-String)
    $found = $true
    if ($Marker) { $found = $text -match [regex]::Escape($Marker) }
    $ok = ($code -eq 0) -and $found

    if ($ok) {
        Write-Host "    PASS" -ForegroundColor Green
    } else {
        Write-Host "    FAIL (exit $code)" -ForegroundColor Red
        ($text -split "`n" | Select-Object -Last 25) | ForEach-Object { Write-Host "    | $_" }
    }
    [void]$results.Add([pscustomobject]@{ Step = $Name; Pass = $ok })
    return $ok
}

$allPassed = $true

if (-not (Invoke-Step "npm run check"            { npm run check }            ""))                 { $allPassed = $false }
if (-not (Invoke-Step "npm run build"            { npm run build }            ""))                 { $allPassed = $false }
if (-not (Invoke-Step "npm run smoke:downstream" { npm run smoke:downstream } "DOWNSTREAM_SMOKE_OK")) { $allPassed = $false }
if (-not (Invoke-Step "npm run test:policy"      { npm run test:policy }      "POLICY_PROFILES_OK")) { $allPassed = $false }
if (-not (Invoke-Step "npm run test:exposure"    { npm run test:exposure }    "PROFILE_EXPOSURE_OK")) { $allPassed = $false }
if (-not (Invoke-Step "npm run test:temp-readonly" { npm run test:temp-readonly } "TEMP_READONLY_OK")) { $allPassed = $false }

# Working tree hygiene: a dirty tree after verification usually means generated output
# leaked into version control.
$dirty = (& git status --porcelain)
$treeClean = -not ($dirty | Where-Object { $_ -match '\S' })
if ($treeClean) {
    Write-Host ""
    Write-Host "==> git status" -ForegroundColor Cyan
    Write-Host "    clean" -ForegroundColor Green
} else {
    Write-Host ""
    Write-Host "==> git status" -ForegroundColor Yellow
    $dirty | ForEach-Object { Write-Host "    | $_" }
}

$elapsed = [int]((Get-Date) - $started).TotalSeconds
Write-Host ""
Write-Host "P05 verify summary" -ForegroundColor Cyan
$results | ForEach-Object {
    $label = if ($_.Pass) { "PASS" } else { "FAIL" }
    Write-Host ("  {0}  {1}" -f $label, $_.Step)
}
Write-Host "  elapsed: ${elapsed}s"

if ($allPassed) {
    Write-Host "VERIFY_OK" -ForegroundColor Green
    exit 0
}
Write-Host "VERIFY_FAILED" -ForegroundColor Red
exit 1
