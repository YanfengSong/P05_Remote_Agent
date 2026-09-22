Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
. (Join-Path $PSScriptRoot 'network-lib.ps1')

$checks = 0
function Check([string]$Name,[bool]$Condition) {
    if (-not $Condition) { throw "CHECK FAILED: $Name" }
    $script:checks++
}

function Expect-Throw([string]$Name,[scriptblock]$Command,[string]$Pattern) {
    try {
        & $Command
        throw "CHECK FAILED: $Name did not throw"
    } catch {
        if ($_.Exception.Message -like 'CHECK FAILED:*') { throw }
        if ($Pattern -and $_.Exception.Message -notmatch $Pattern) {
            throw "CHECK FAILED: $Name threw unexpected message: $($_.Exception.Message)"
        }
        $script:checks++
    }
}

Check 'mode auto' ((ConvertTo-P05NetworkMode 'auto') -eq 'auto')
Check 'mode direct' ((ConvertTo-P05NetworkMode 'DIRECT') -eq 'direct')
Check 'mode proxy' ((ConvertTo-P05NetworkMode 'proxy') -eq 'proxy')
Expect-Throw 'invalid network mode' { ConvertTo-P05NetworkMode 'magic' } 'Supported values'
Expect-Throw 'proxy mode requires P05_PROXY' {
    Resolve-P05NetworkPath -Mode proxy -Proxy ''
} 'requires P05_PROXY'
Expect-Throw 'invalid proxy URI' {
    ConvertTo-P05ProxyUri -Value 'ftp://127.0.0.1:21' -Name 'P05_PROXY'
} 'http:// or https://'

$directWinsProbe = {
    param($Path,$ProxyValue,$UriValue)
    [pscustomobject]@{
        ok = ($Path -eq 'direct')
        category = $(if ($Path -eq 'direct') { 'CONTROL_PLANE_REACHABLE' } else { 'PROXY_CONNECT_FAILURE' })
        detail = 'test'
    }
}
$direct = Resolve-P05NetworkPath -Mode auto -Proxy 'http://127.0.0.1:7892' -Probe $directWinsProbe
Check 'auto chooses direct when direct works' ($direct.selectedPath -eq 'direct')

$proxyWinsProbe = {
    param($Path,$ProxyValue,$UriValue)
    [pscustomobject]@{
        ok = ($Path -eq 'proxy' -and $ProxyValue -eq 'http://127.0.0.1:7892')
        category = $(if ($Path -eq 'proxy') { 'CONTROL_PLANE_REACHABLE' } else { 'DIRECT_CONNECT_FAILURE' })
        detail = 'test'
    }
}
$proxy = Resolve-P05NetworkPath -Mode auto -Proxy 'http://127.0.0.1:7892' -Probe $proxyWinsProbe
Check 'auto falls back to working proxy' ($proxy.selectedPath -eq 'proxy')
Check 'auto records proxy source' ($proxy.source -eq 'P05_PROXY')

$deadProxyProbe = {
    param($Path,$ProxyValue,$UriValue)
    [pscustomobject]@{ ok = $false; category = 'PROXY_CONNECT_FAILURE'; detail = 'test' }
}
Expect-Throw 'explicit proxy unavailable' {
    Resolve-P05NetworkPath -Mode proxy -Proxy 'http://127.0.0.1:7892' -Probe $deadProxyProbe
} 'Explicit proxy network probe failed'

$old = @{}
foreach ($name in @('P05_NETWORK_MODE','P05_PROXY','CONTROL_PLANE_HTTP_PROXY','HTTPS_PROXY','HTTP_PROXY')) {
    $old[$name] = [Environment]::GetEnvironmentVariable($name,'Process')
}
try {
    Set-P05ProcessNetwork -Selection ([pscustomobject]@{
        configuredMode = 'proxy'
        selectedPath = 'proxy'
        proxy = 'http://127.0.0.1:7892'
    })
    Check 'proxy exports P05_PROXY' ($env:P05_PROXY -eq 'http://127.0.0.1:7892')
    Check 'proxy exports control-plane proxy' ($env:CONTROL_PLANE_HTTP_PROXY -eq 'http://127.0.0.1:7892')
    Check 'proxy exports HTTPS_PROXY' ($env:HTTPS_PROXY -eq 'http://127.0.0.1:7892')
    Check 'proxy exports HTTP_PROXY' ($env:HTTP_PROXY -eq 'http://127.0.0.1:7892')

    $childCommand = "Write-Output (`$env:P05_PROXY + '|' + `$env:HTTPS_PROXY)"
    $child = & powershell -NoProfile -Command $childCommand
    Check 'child runtime inherits selected proxy' (($child | Out-String).Trim() -eq 'http://127.0.0.1:7892|http://127.0.0.1:7892')

    Set-P05ProcessNetwork -Selection ([pscustomobject]@{
        configuredMode = 'direct'
        selectedPath = 'direct'
        proxy = ''
    })
    Check 'direct clears P05_PROXY' (-not $env:P05_PROXY)
    Check 'direct clears HTTPS_PROXY' (-not $env:HTTPS_PROXY)
    Check 'direct clears HTTP_PROXY' (-not $env:HTTP_PROXY)
} finally {
    foreach ($name in $old.Keys) {
        [Environment]::SetEnvironmentVariable($name,$old[$name],'Process')
    }
}

Write-Host "DEPLOYMENT_NETWORK_OK ($checks checks)" -ForegroundColor Green
