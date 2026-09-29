param(
    [Parameter(Mandatory=$true)]
    [ValidateSet('A','B')]
    [string]$Slot
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')
. (Join-Path $PSScriptRoot 'network-lib.ps1')

$repo = Get-P05RepoRoot -ScriptRoot $PSScriptRoot
Import-P05DotEnv -RepoRoot $repo
Set-P05RuntimeNetworkFromEnvironment | Out-Null
if (-not (Test-P05SlotConfigured -Slot $Slot)) {
    throw "Runtime $Slot is not configured. Add $Slot to P05_RUNTIME_SLOTS and run bootstrap.ps1 again."
}

$ctx = Get-P05SlotContext -ScriptRoot $PSScriptRoot -Slot $Slot
Import-P05RuntimeKey

if (-not (Test-Path -LiteralPath $ctx.ProfilePath -PathType Leaf)) {
    throw "Runtime $Slot profile not found: $($ctx.ProfilePath). Run bootstrap.ps1 first."
}
if (-not (Test-Path -LiteralPath $ctx.McpEntry -PathType Leaf)) {
    throw "P05 build output not found: $($ctx.McpEntry). Run bootstrap.ps1 first."
}

function Test-Ready {
    if (-not (Test-Path -LiteralPath $ctx.HealthUrlFile -PathType Leaf)) { return $false }
    $base = (Get-Content -LiteralPath $ctx.HealthUrlFile -Raw).Trim()
    if (-not $base) { return $false }
    try {
        $r = Invoke-WebRequest ($base + '/readyz') -UseBasicParsing -TimeoutSec 2
        return $r.StatusCode -eq 200
    } catch { return $false }
}

if (Test-Ready) {
    Write-Output "Runtime $Slot already ready."
    exit 0
}

$args = @('run','--profile-dir',('"' + $ctx.ProfileDir + '"'),'--profile',$ctx.ProfileName)
Start-Process -FilePath $ctx.TunnelClient -ArgumentList $args -WorkingDirectory $ctx.RepoRoot -WindowStyle Hidden | Out-Null

for ($i=0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 500
    if (Test-Ready) {
        Write-Output "Runtime $Slot ready."
        exit 0
    }
}
throw "Runtime $Slot did not become ready."
