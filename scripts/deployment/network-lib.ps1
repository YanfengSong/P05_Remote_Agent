Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function ConvertTo-P05NetworkMode {
    param([string]$Raw)
    $mode = if ($Raw -and $Raw.Trim()) { $Raw.Trim().ToLowerInvariant() } else { 'auto' }
    if ($mode -notin @('auto','direct','proxy')) {
        throw "Invalid P05 network mode '$Raw'. Supported values: auto, direct, proxy."
    }
    return $mode
}

function ConvertTo-P05ProxyUri {
    param(
        [Parameter(Mandatory=$true)][string]$Value,
        [string]$Name = 'proxy'
    )

    $candidate = $Value.Trim()
    if (-not $candidate) { throw "$Name is empty." }
    if ($candidate -notmatch '^[A-Za-z][A-Za-z0-9+.-]*://') {
        $candidate = 'http://' + $candidate
    }

    [Uri]$uri = $null
    if (-not [Uri]::TryCreate($candidate,[UriKind]::Absolute,[ref]$uri)) {
        throw "$Name is not a valid absolute proxy URI."
    }
    if ($uri.Scheme -notin @('http','https') -or -not $uri.Host) {
        throw "$Name must use http:// or https:// and include a host."
    }
    if ($uri.Port -lt 1 -or $uri.Port -gt 65535) {
        throw "$Name contains an invalid port."
    }
    return $uri.AbsoluteUri.TrimEnd('/')
}

function Get-P05SafeProxyDisplay {
    param([string]$Proxy)
    if (-not $Proxy) { return '' }
    try {
        $uri = [Uri](ConvertTo-P05ProxyUri -Value $Proxy)
        return ('{0}://{1}:{2}' -f $uri.Scheme,$uri.Host,$uri.Port)
    } catch {
        return '<invalid-proxy>'
    }
}

function Get-P05DotEnvValue {
    param(
        [string]$Path,
        [string]$Name
    )
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    foreach ($line in Get-Content -LiteralPath $Path) {
        if ($line -match ('^' + [regex]::Escape($Name) + '=(.*)$')) {
            return [string]$Matches[1]
        }
    }
    return $null
}

function ConvertFrom-P05WindowsProxyServer {
    param([string]$Raw)
    if (-not $Raw -or -not $Raw.Trim()) { return @() }

    $value = $Raw.Trim()
    $parts = @($value.Split(';') | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    $ordered = New-Object System.Collections.ArrayList

    foreach ($scheme in @('https','http')) {
        foreach ($part in $parts) {
            if ($part -match ('^(?i)' + $scheme + '=(.+)$')) {
                try { [void]$ordered.Add((ConvertTo-P05ProxyUri -Value $Matches[1] -Name 'Windows proxy')) } catch {}
            }
        }
    }

    if ($ordered.Count -eq 0 -and $parts.Count -eq 1 -and $parts[0] -notmatch '=') {
        try { [void]$ordered.Add((ConvertTo-P05ProxyUri -Value $parts[0] -Name 'Windows proxy')) } catch {}
    }

    return @($ordered)
}

function Get-P05WindowsProxyCandidates {
    $items = New-Object System.Collections.ArrayList

    try {
        $settings = Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' -ErrorAction Stop
        if ([int]$settings.ProxyEnable -eq 1 -and $settings.ProxyServer) {
            foreach ($proxy in @(ConvertFrom-P05WindowsProxyServer -Raw ([string]$settings.ProxyServer))) {
                [void]$items.Add([pscustomobject]@{ source = 'windows-internet-settings'; proxy = $proxy })
            }
        }
    } catch {}

    try {
        $netsh = (& netsh winhttp show proxy 2>$null | Out-String)
        $matches = [regex]::Matches(
            $netsh,
            '(?i)(?:https?://)?(?:[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?|\[[0-9a-f:]+\]):[0-9]{2,5}'
        )
        foreach ($match in $matches) {
            try {
                $proxy = ConvertTo-P05ProxyUri -Value $match.Value -Name 'WinHTTP proxy'
                [void]$items.Add([pscustomobject]@{ source = 'winhttp'; proxy = $proxy })
            } catch {}
        }
    } catch {}

    $seen = @{}
    return @($items | Where-Object {
        $key = $_.proxy.ToLowerInvariant()
        if ($seen.ContainsKey($key)) { return $false }
        $seen[$key] = $true
        return $true
    })
}

function Get-P05ProxyCandidates {
    param([string]$ExplicitProxy)

    $items = New-Object System.Collections.ArrayList
    if ($ExplicitProxy -and $ExplicitProxy.Trim()) {
        $normalized = ConvertTo-P05ProxyUri -Value $ExplicitProxy -Name 'P05_PROXY'
        [void]$items.Add([pscustomobject]@{ source = 'P05_PROXY'; proxy = $normalized })
    }

    foreach ($entry in @(
        [pscustomobject]@{ source = 'HTTPS_PROXY'; value = $env:HTTPS_PROXY },
        [pscustomobject]@{ source = 'HTTP_PROXY'; value = $env:HTTP_PROXY }
    )) {
        if (-not $entry.value -or -not $entry.value.Trim()) { continue }
        try {
            $normalized = ConvertTo-P05ProxyUri -Value ([string]$entry.value) -Name $entry.source
            [void]$items.Add([pscustomobject]@{ source = $entry.source; proxy = $normalized })
        } catch {}
    }

    foreach ($item in @(Get-P05WindowsProxyCandidates)) {
        [void]$items.Add($item)
    }

    $seen = @{}
    return @($items | Where-Object {
        $key = $_.proxy.ToLowerInvariant()
        if ($seen.ContainsKey($key)) { return $false }
        $seen[$key] = $true
        return $true
    })
}

function New-P05WebProxy {
    param([string]$Proxy)
    $normalized = ConvertTo-P05ProxyUri -Value $Proxy
    $uri = [Uri]$normalized
    $webProxy = New-Object Net.WebProxy($normalized)
    if ($uri.UserInfo) {
        $parts = $uri.UserInfo.Split(':',2)
        $user = [Uri]::UnescapeDataString($parts[0])
        $password = if ($parts.Count -gt 1) { [Uri]::UnescapeDataString($parts[1]) } else { '' }
        $webProxy.Credentials = New-Object Net.NetworkCredential($user,$password)
    }
    return $webProxy
}

function Invoke-P05NetworkProbe {
    param(
        [ValidateSet('direct','proxy')][string]$Path,
        [string]$Proxy,
        [string]$Uri = 'https://api.openai.com/',
        [int]$TimeoutSec = 8
    )

    $safeProxy = if ($Path -eq 'proxy') { Get-P05SafeProxyDisplay -Proxy $Proxy } else { '' }
    try {
        $request = [Net.HttpWebRequest][Net.WebRequest]::Create($Uri)
        $request.Method = 'HEAD'
        $request.AllowAutoRedirect = $true
        $request.Timeout = $TimeoutSec * 1000
        $request.ReadWriteTimeout = $TimeoutSec * 1000
        $request.UserAgent = 'P05-V2-Network-Probe/1.0'
        if ($Path -eq 'direct') {
            $request.Proxy = $null
        } else {
            $request.Proxy = New-P05WebProxy -Proxy $Proxy
        }

        try {
            $response = $request.GetResponse()
            try {
                $status = [int]$response.StatusCode
                return [pscustomobject]@{
                    ok = $true
                    category = 'CONTROL_PLANE_REACHABLE'
                    detail = "HTTP response received ($status)."
                }
            } finally {
                $response.Close()
            }
        } catch [Net.WebException] {
            $exception = $_.Exception
            if ($exception.Response) {
                try { $exception.Response.Close() } catch {}
                return [pscustomobject]@{
                    ok = $true
                    category = 'CONTROL_PLANE_REACHABLE'
                    detail = 'Control plane returned an HTTP response.'
                }
            }

            $status = [string]$exception.Status
            $category = if ($status -eq 'NameResolutionFailure') {
                'DNS_FAILURE'
            } elseif ($status -in @('TrustFailure','SecureChannelFailure')) {
                'TLS_FAILURE'
            } elseif ($Path -eq 'proxy') {
                'PROXY_CONNECT_FAILURE'
            } else {
                'DIRECT_CONNECT_FAILURE'
            }

            return [pscustomobject]@{
                ok = $false
                category = $category
                detail = $(if ($safeProxy) { "$status via $safeProxy" } else { $status })
            }
        }
    } catch {
        return [pscustomobject]@{
            ok = $false
            category = $(if ($Path -eq 'proxy') { 'PROXY_CONNECT_FAILURE' } else { 'DIRECT_CONNECT_FAILURE' })
            detail = $(if ($safeProxy) { "Probe failed via $safeProxy." } else { 'Direct probe failed.' })
        }
    }
}

function Resolve-P05NetworkPath {
    param(
        [string]$Mode = 'auto',
        [string]$Proxy,
        [string]$ProbeUri = 'https://api.openai.com/',
        [scriptblock]$Probe
    )

    $configuredMode = ConvertTo-P05NetworkMode -Raw $Mode
    if (-not $Probe) {
        $Probe = {
            param($Path,$ProxyValue,$UriValue)
            Invoke-P05NetworkProbe -Path $Path -Proxy $ProxyValue -Uri $UriValue
        }
    }

    if ($configuredMode -eq 'direct') {
        $result = & $Probe 'direct' $null $ProbeUri
        if (-not $result.ok) {
            throw "Direct network probe failed: $($result.category)."
        }
        return [pscustomobject]@{
            configuredMode = 'direct'
            selectedPath = 'direct'
            proxy = ''
            source = 'direct'
            category = $result.category
            detail = $result.detail
        }
    }

    if ($configuredMode -eq 'proxy') {
        if (-not $Proxy -or -not $Proxy.Trim()) {
            throw 'P05_NETWORK_MODE=proxy requires P05_PROXY.'
        }
        $normalized = ConvertTo-P05ProxyUri -Value $Proxy -Name 'P05_PROXY'
        $result = & $Probe 'proxy' $normalized $ProbeUri
        if (-not $result.ok) {
            throw "Explicit proxy network probe failed: $($result.category)."
        }
        return [pscustomobject]@{
            configuredMode = 'proxy'
            selectedPath = 'proxy'
            proxy = $normalized
            source = 'P05_PROXY'
            category = $result.category
            detail = $result.detail
        }
    }

    if ($Proxy -and $Proxy.Trim()) {
        $null = ConvertTo-P05ProxyUri -Value $Proxy -Name 'P05_PROXY'
    }

    $directResult = & $Probe 'direct' $null $ProbeUri
    if ($directResult.ok) {
        return [pscustomobject]@{
            configuredMode = 'auto'
            selectedPath = 'direct'
            proxy = ''
            source = 'direct'
            category = $directResult.category
            detail = $directResult.detail
        }
    }

    foreach ($candidate in @(Get-P05ProxyCandidates -ExplicitProxy $Proxy)) {
        $result = & $Probe 'proxy' $candidate.proxy $ProbeUri
        if ($result.ok) {
            return [pscustomobject]@{
                configuredMode = 'auto'
                selectedPath = 'proxy'
                proxy = $candidate.proxy
                source = $candidate.source
                category = $result.category
                detail = $result.detail
            }
        }
    }

    throw "No usable network path found. Direct probe failed with $($directResult.category), and no detected proxy passed the connectivity probe."
}

function Set-P05ProcessNetwork {
    param([Parameter(Mandatory=$true)]$Selection)

    $mode = ConvertTo-P05NetworkMode -Raw ([string]$Selection.configuredMode)
    [Environment]::SetEnvironmentVariable('P05_NETWORK_MODE',$mode,'Process')

    if ([string]$Selection.selectedPath -eq 'proxy') {
        $proxy = ConvertTo-P05ProxyUri -Value ([string]$Selection.proxy) -Name 'Selected proxy'
        foreach ($name in @('P05_PROXY','CONTROL_PLANE_HTTP_PROXY','HTTPS_PROXY','HTTP_PROXY')) {
            [Environment]::SetEnvironmentVariable($name,$proxy,'Process')
        }
        return
    }

    foreach ($name in @('P05_PROXY','CONTROL_PLANE_HTTP_PROXY','HTTPS_PROXY','HTTP_PROXY')) {
        [Environment]::SetEnvironmentVariable($name,'','Process')
    }
}

function Get-P05RuntimeNetworkSelection {
    $mode = ConvertTo-P05NetworkMode -Raw $env:P05_NETWORK_MODE

    if ($mode -eq 'proxy') {
        if (-not $env:P05_PROXY -or -not $env:P05_PROXY.Trim()) {
            throw 'P05_NETWORK_MODE=proxy requires P05_PROXY in .env.'
        }
        $proxy = ConvertTo-P05ProxyUri -Value $env:P05_PROXY -Name 'P05_PROXY'
        return [pscustomobject]@{
            configuredMode = 'proxy'
            selectedPath = 'proxy'
            proxy = $proxy
            source = 'P05_PROXY'
        }
    }

    if ($mode -eq 'direct') {
        return [pscustomobject]@{
            configuredMode = 'direct'
            selectedPath = 'direct'
            proxy = ''
            source = 'direct'
        }
    }

    foreach ($value in @($env:P05_PROXY,$env:CONTROL_PLANE_HTTP_PROXY,$env:HTTPS_PROXY,$env:HTTP_PROXY)) {
        if ($value -and $value.Trim()) {
            try {
                $proxy = ConvertTo-P05ProxyUri -Value $value -Name 'runtime proxy'
                return [pscustomobject]@{
                    configuredMode = 'auto'
                    selectedPath = 'proxy'
                    proxy = $proxy
                    source = 'persisted'
                }
            } catch {}
        }
    }

    return [pscustomobject]@{
        configuredMode = 'auto'
        selectedPath = 'direct'
        proxy = ''
        source = 'direct'
    }
}

function Set-P05RuntimeNetworkFromEnvironment {
    $selection = Get-P05RuntimeNetworkSelection
    Set-P05ProcessNetwork -Selection $selection
    return $selection
}

function Write-P05NetworkReport {
    param([Parameter(Mandatory=$true)]$Selection)
    Write-Host ''
    Write-Host 'P05 Network' -ForegroundColor Cyan
    Write-Host ("Mode:          " + $Selection.configuredMode)
    Write-Host ("Selected path: " + $Selection.selectedPath)
    if ($Selection.selectedPath -eq 'proxy') {
        Write-Host ("Proxy source:  " + $Selection.source)
        Write-Host ("Proxy:         " + (Get-P05SafeProxyDisplay -Proxy $Selection.proxy))
    }
    Write-Host ("Probe:         " + $Selection.category)
}

function Invoke-P05Download {
    param(
        [Parameter(Mandatory=$true)][string]$Url,
        [Parameter(Mandatory=$true)][string]$Destination,
        [Parameter(Mandatory=$true)]$Selection,
        [int]$TimeoutSec = 120
    )

    $request = [Net.HttpWebRequest][Net.WebRequest]::Create($Url)
    $request.Method = 'GET'
    $request.AllowAutoRedirect = $true
    $request.Timeout = $TimeoutSec * 1000
    $request.ReadWriteTimeout = $TimeoutSec * 1000
    $request.UserAgent = 'P05-V2-Bootstrap/1.0'

    if ([string]$Selection.selectedPath -eq 'proxy') {
        $request.Proxy = New-P05WebProxy -Proxy ([string]$Selection.proxy)
    } else {
        $request.Proxy = $null
    }

    $response = $null
    $input = $null
    $output = $null
    try {
        $response = $request.GetResponse()
        $input = $response.GetResponseStream()
        $output = New-Object IO.FileStream($Destination,[IO.FileMode]::Create,[IO.FileAccess]::Write,[IO.FileShare]::None)
        $input.CopyTo($output)
    } finally {
        if ($output) { $output.Dispose() }
        if ($input) { $input.Dispose() }
        if ($response) { $response.Close() }
    }
}
