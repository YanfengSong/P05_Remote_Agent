param(
    [Parameter(Mandatory=$true)]
    [ValidateSet('A','B')]
    [string]$Slot
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')

$ctx = Get-P05SlotContext -ScriptRoot $PSScriptRoot -Slot $Slot
$profileNeedle = '--profile ' + $ctx.ProfileName
$profileNeedleQuoted = '--profile "' + $ctx.ProfileName + '"'
$profilePathNeedle = $ctx.ProfileDir
$childPattern = '(?i)launch-runtime\.mjs"?\s+' + [regex]::Escape($Slot) + '(?:\s|$)'

$procs = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue
$tunnels = @($procs | Where-Object {
    $_.Name -eq 'tunnel-client.exe' -and
    $_.CommandLine -and
    ($_.CommandLine.Contains($profileNeedle) -or $_.CommandLine.Contains($profileNeedleQuoted)) -and
    $_.CommandLine.Contains($profilePathNeedle)
})
foreach ($p in $tunnels) {
    Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
}

Start-Sleep -Milliseconds 400
$children = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    $_.Name -eq 'node.exe' -and
    $_.CommandLine -and
    $_.CommandLine -match $childPattern
})
foreach ($p in $children) {
    Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
}

Remove-Item -LiteralPath $ctx.HealthUrlFile -Force -ErrorAction SilentlyContinue
Write-Output "Runtime $Slot stopped."
