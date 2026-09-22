param(
    [string]$TunnelA,
    [string]$TunnelB,
    [string]$ConnectorA,
    [string]$ConnectorB,
    [string]$RuntimeSlots,
    [string]$ApiKey,
    [string]$AllowedRoots,
    [string]$NetworkMode,
    [string]$Proxy,
    [switch]$SkipToolDownload,
    [switch]$SkipBuild,
    [switch]$SkipCoreStart
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$RepoRoot = (Resolve-Path $PSScriptRoot).Path
$P05Root = Join-Path $RepoRoot '.p05'
$NodeVersion = '22.23.1'
$TunnelVersion = '0.0.14'
$NodeDir = Join-Path $P05Root 'tools\node'
$TunnelDir = Join-Path $P05Root 'tools\tunnel-client'
$NodeExe = Join-Path $NodeDir 'node.exe'
$NpmCmd = Join-Path $NodeDir 'npm.cmd'
$TunnelExe = Join-Path $TunnelDir 'tunnel-client.exe'
$EnvFile = Join-Path $RepoRoot '.env'
. (Join-Path $RepoRoot 'scripts\deployment\common.ps1')
. (Join-Path $RepoRoot 'scripts\deployment\preflight-lib.ps1')
. (Join-Path $RepoRoot 'scripts\deployment\network-lib.ps1')

function Read-SecretPlainText([string]$Prompt) {
    $secure = Read-Host $Prompt -AsSecureString
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try {
        return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
    } finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    }
}

function Assert-TunnelId([string]$Name,[string]$Value) {
    if (-not $Value -or $Value -notmatch '^tunnel_[A-Za-z0-9]+$') {
        throw "$Name must be a valid tunnel_... identifier."
    }
}

function Set-DotEnvValue([string]$Path,[string]$Name,[string]$Value) {
    $lines = if (Test-Path -LiteralPath $Path) { @(Get-Content -LiteralPath $Path) } else { @() }
    $found = $false
    for ($i=0; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -match ('^' + [regex]::Escape($Name) + '=')) {
            $lines[$i] = $Name + '=' + $Value
            $found = $true
            break
        }
    }
    if (-not $found) { $lines += ($Name + '=' + $Value) }
    Set-Content -LiteralPath $Path -Value $lines -Encoding UTF8
}

function Download-File([string]$Url,[string]$Destination) {
    if (-not $script:P05NetworkSelection) {
        throw 'Network path has not been selected.'
    }
    Write-Host "Downloading $Url via $($script:P05NetworkSelection.selectedPath)"
    Invoke-P05Download -Url $Url -Destination $Destination -Selection $script:P05NetworkSelection
}

function Expected-Checksum(
    [string]$ChecksumFile,
    [string]$AssetName
) {
    $line = Get-Content -LiteralPath $ChecksumFile |
        Where-Object { $_ -match ('(?i)^[a-f0-9]{64}\s+\*?' + [regex]::Escape($AssetName) + '$') } |
        Select-Object -First 1
    if (-not $line) { throw "Checksum for $AssetName was not found." }
    return ($line -split '\s+')[0].ToLowerInvariant()
}

function Assert-Checksum(
    [string]$File,
    [string]$Expected
) {
    $actual = (Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $Expected) {
        throw "SHA-256 mismatch for $File. Expected $Expected, got $actual."
    }
}

function Install-Node {
    param([switch]$Force)
    if (-not $Force -and (Test-Path -LiteralPath $NodeExe -PathType Leaf) -and
        (Test-Path -LiteralPath $NpmCmd -PathType Leaf)) {
        Write-Host "Repo-local Node already installed."
        return
    }

    $asset = "node-v$NodeVersion-win-x64.zip"
    $base = "https://nodejs.org/dist/v$NodeVersion"
    $temp = Join-Path ([IO.Path]::GetTempPath()) ("p05-node-" + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $temp -Force | Out-Null
    try {
        $zip = Join-Path $temp $asset
        $sums = Join-Path $temp 'SHASUMS256.txt'
        Download-File "$base/$asset" $zip
        Download-File "$base/SHASUMS256.txt" $sums
        Assert-Checksum $zip (Expected-Checksum $sums $asset)

        $extract = Join-Path $temp 'extract'
        Expand-Archive -LiteralPath $zip -DestinationPath $extract -Force
        $source = Get-ChildItem -LiteralPath $extract -Directory | Select-Object -First 1
        if (-not $source) { throw 'Node archive did not contain a top-level directory.' }

        Remove-Item -LiteralPath $NodeDir -Recurse -Force -ErrorAction SilentlyContinue
        New-Item -ItemType Directory -Path $NodeDir -Force | Out-Null
        Copy-Item (Join-Path $source.FullName '*') $NodeDir -Recurse -Force
    } finally {
        Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function Install-TunnelClient {
    param([switch]$Force)
    if (-not $Force -and (Test-Path -LiteralPath $TunnelExe -PathType Leaf)) {
        Write-Host "Repo-local tunnel-client already installed."
        return
    }

    $asset = "tunnel-client-v$TunnelVersion-windows-amd64.zip"
    $base = "https://github.com/openai/tunnel-client/releases/download/v$TunnelVersion"
    $temp = Join-Path ([IO.Path]::GetTempPath()) ("p05-tunnel-" + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $temp -Force | Out-Null
    try {
        $zip = Join-Path $temp $asset
        $sums = Join-Path $temp 'SHA256SUMS.txt'
        Download-File "$base/$asset" $zip
        Download-File "$base/SHA256SUMS.txt" $sums
        Assert-Checksum $zip (Expected-Checksum $sums $asset)

        $extract = Join-Path $temp 'extract'
        Expand-Archive -LiteralPath $zip -DestinationPath $extract -Force
        $source = Get-ChildItem -LiteralPath $extract -Filter 'tunnel-client.exe' -Recurse -File |
            Select-Object -First 1
        if (-not $source) { throw 'tunnel-client archive did not contain tunnel-client.exe.' }

        Remove-Item -LiteralPath $TunnelDir -Recurse -Force -ErrorAction SilentlyContinue
        New-Item -ItemType Directory -Path $TunnelDir -Force | Out-Null
        Copy-Item -LiteralPath $source.FullName -Destination $TunnelExe -Force
    } finally {
        Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
    }
}

if ($env:OS -ne 'Windows_NT') {
    throw 'This bootstrap currently supports Windows only.'
}

if (-not $RuntimeSlots) {
    Write-Host ''
    Write-Host 'Runtime topology:' -ForegroundColor Cyan
    Write-Host '  1. Single Runtime (A) [default]'
    Write-Host '  2. Dual Runtime (A + B)'
    $choice = (Read-Host 'Select 1 or 2').Trim()
    $RuntimeSlots = if ($choice -eq '2') { 'A,B' } elseif (-not $choice -or $choice -eq '1') { 'A' } else {
        throw 'Runtime topology selection must be 1 or 2.'
    }
}
$slots = @(ConvertTo-P05RuntimeSlots -Raw $RuntimeSlots)
if ($slots.Count -eq 0) { throw 'At least one runtime slot must be configured.' }
$RuntimeSlots = ($slots -join ',')

$existingConnectorA = Get-P05DotEnvValue -Path $EnvFile -Name 'P05_RUNTIME_A_CONNECTOR'
$existingConnectorB = Get-P05DotEnvValue -Path $EnvFile -Name 'P05_RUNTIME_B_CONNECTOR'
if (-not $ConnectorA) {
    $ConnectorA = $(if ($existingConnectorA) { $existingConnectorA } elseif ($env:P05_RUNTIME_A_CONNECTOR) { $env:P05_RUNTIME_A_CONNECTOR } else { '@Runtime-A' })
}
if (-not $ConnectorB) {
    $ConnectorB = $(if ($existingConnectorB) { $existingConnectorB } elseif ($env:P05_RUNTIME_B_CONNECTOR) { $env:P05_RUNTIME_B_CONNECTOR } else { '@Runtime-B' })
}

if ($slots -contains 'A') {
    if (-not $TunnelA) { $TunnelA = Read-Host 'Tunnel ID for Runtime A' }
    Assert-TunnelId 'TunnelA' $TunnelA
}
if ($slots -contains 'B') {
    if (-not $TunnelB) { $TunnelB = Read-Host 'Tunnel ID for Runtime B' }
    Assert-TunnelId 'TunnelB' $TunnelB
}
if (($slots -contains 'A') -and ($slots -contains 'B') -and $TunnelA -eq $TunnelB) {
    throw 'Tunnel A and Tunnel B must be different.'
}

if (-not $ApiKey) { $ApiKey = Read-SecretPlainText 'OpenAI Control Plane API Key' }
if (-not $ApiKey) { throw 'API key is required.' }

if (-not $AllowedRoots) { $AllowedRoots = $RepoRoot }

$existingNetworkMode = Get-P05DotEnvValue -Path $EnvFile -Name 'P05_NETWORK_MODE'
$existingProxy = Get-P05DotEnvValue -Path $EnvFile -Name 'P05_PROXY'
if (-not $NetworkMode) {
    $NetworkMode = $(if ($existingNetworkMode) { $existingNetworkMode } elseif ($env:P05_NETWORK_MODE) { $env:P05_NETWORK_MODE } else { 'auto' })
}
if (-not $Proxy) {
    $Proxy = $(if ($existingProxy) { $existingProxy } elseif ($env:P05_PROXY) { $env:P05_PROXY } else { '' })
}

$script:P05NetworkSelection = Resolve-P05NetworkPath -Mode $NetworkMode -Proxy $Proxy
Set-P05ProcessNetwork -Selection $script:P05NetworkSelection
Write-P05NetworkReport -Selection $script:P05NetworkSelection

$preflight = Invoke-P05Preflight -RepoRoot $RepoRoot -AllowedRoots $AllowedRoots -Stage PreInstall -ExpectedNodeVersion $NodeVersion -ExpectedTunnelVersion $TunnelVersion -ManagedRequired:$SkipToolDownload
Write-P05PreflightReport -Report $preflight
Assert-P05Preflight -Report $preflight

New-Item -ItemType Directory -Path $P05Root -Force | Out-Null

if (-not $SkipToolDownload) {
    $nodeCheck = $preflight.checks | Where-Object { $_.id -eq 'node' } | Select-Object -First 1
    $npmCheck = $preflight.checks | Where-Object { $_.id -eq 'npm' } | Select-Object -First 1
    $tunnelCheck = $preflight.checks | Where-Object { $_.id -eq 'tunnel-client' } | Select-Object -First 1
    if ($nodeCheck.status -ne 'PASS' -or $npmCheck.status -ne 'PASS') {
        Write-Host 'Repairing repo-local Node/npm installation...' -ForegroundColor Yellow
        Install-Node -Force
    } else {
        Write-Host 'Repo-local Node/npm already validated.'
    }
    if ($tunnelCheck.status -ne 'PASS') {
        Write-Host 'Repairing repo-local tunnel-client installation...' -ForegroundColor Yellow
        Install-TunnelClient -Force
    } else {
        Write-Host 'Repo-local tunnel-client already validated.'
    }
}

$postflight = Invoke-P05Preflight -RepoRoot $RepoRoot -AllowedRoots $AllowedRoots -Stage PostInstall -ExpectedNodeVersion $NodeVersion -ExpectedTunnelVersion $TunnelVersion -ManagedRequired:$true
Write-P05PreflightReport -Report $postflight
Assert-P05Preflight -Report $postflight

if (-not (Test-Path -LiteralPath $EnvFile -PathType Leaf)) {
    Copy-Item -LiteralPath (Join-Path $RepoRoot '.env.example') -Destination $EnvFile
}

$managed = [ordered]@{
    REMOTE_AGENT_ALLOWED_ROOTS = $AllowedRoots
    REMOTE_AGENT_DEFAULT_CWD = $RepoRoot
    P05_TOOL_PROFILE = 'developer'
    P05_OPERATOR_PORT = '56301'
    P05_NODE_PATH = $NodeExe
    P05_OPERATOR_TUNNEL_CLIENT = $TunnelExe
    P05_NETWORK_MODE = [string]$script:P05NetworkSelection.configuredMode
    P05_PROXY = $(if ($script:P05NetworkSelection.selectedPath -eq 'proxy') { [string]$script:P05NetworkSelection.proxy } else { '' })
    CONTROL_PLANE_HTTP_PROXY = $(if ($script:P05NetworkSelection.selectedPath -eq 'proxy') { [string]$script:P05NetworkSelection.proxy } else { '' })
    HTTPS_PROXY = $(if ($script:P05NetworkSelection.selectedPath -eq 'proxy') { [string]$script:P05NetworkSelection.proxy } else { '' })
    HTTP_PROXY = $(if ($script:P05NetworkSelection.selectedPath -eq 'proxy') { [string]$script:P05NetworkSelection.proxy } else { '' })
    P05_RUNTIME_SLOTS = $RuntimeSlots
    P05_RUNTIME_A_PROFILE = 'p05-a'
    P05_RUNTIME_B_PROFILE = 'p05-b'
    P05_RUNTIME_A_CONNECTOR = $ConnectorA
    P05_RUNTIME_B_CONNECTOR = $ConnectorB
    P05_TUNNEL_A_ID = $(if ($slots -contains 'A') { $TunnelA } else { '' })
    P05_TUNNEL_B_ID = $(if ($slots -contains 'B') { $TunnelB } else { '' })
    CONTROL_PLANE_API_KEY = $ApiKey
}
foreach ($name in $managed.Keys) {
    Set-DotEnvValue $EnvFile $name ([string]$managed[$name])
}

$matlabToolkit = Join-Path $env:USERPROFILE '.matlab\agentic-toolkits\bin\matlab-mcp-server.exe'
if (Test-Path -LiteralPath $matlabToolkit -PathType Leaf) {
    Set-DotEnvValue $EnvFile 'MATLAB_MCP_ENABLED' 'true'
}

foreach ($slot in $slots) {
    $slotLower = $slot.ToLowerInvariant()
    $state = Join-Path $P05Root ("runtime-$slotLower\state")
    New-Item -ItemType Directory -Path $state -Force | Out-Null
}

if (-not $SkipBuild) {
    Push-Location $RepoRoot
    try {
        & $NpmCmd ci
        if ($LASTEXITCODE -ne 0) { throw "npm ci failed with exit code $LASTEXITCODE." }
        & $NpmCmd run build
        if ($LASTEXITCODE -ne 0) { throw "npm run build failed with exit code $LASTEXITCODE." }
    } finally {
        Pop-Location
    }
}

& (Join-Path $RepoRoot 'scripts\deployment\write-runtime-profiles.ps1') -RuntimeSlots $RuntimeSlots -TunnelA $TunnelA -TunnelB $TunnelB

if (-not $SkipCoreStart) {
    foreach ($slot in $slots) {
        Write-Host ("Starting Core Runtime " + $slot + "...") -ForegroundColor Cyan
        $runtimeScript = Join-Path $RepoRoot 'scripts\deployment\run-runtime-slot.ps1'
        & powershell -NoProfile -ExecutionPolicy Bypass -File $runtimeScript -Slot $slot
        if ($LASTEXITCODE -ne 0) {
            throw "Core Runtime $slot failed to start with exit code $LASTEXITCODE."
        }
    }
}

$nodeVersionText = (& $NodeExe --version).Trim()
$tunnelVersionText = (& $TunnelExe --version).Trim()

Write-Host ''
Write-Host 'P05 bootstrap complete.' -ForegroundColor Green
Write-Host "Repo: $RepoRoot"
Write-Host "Node: $nodeVersionText"
Write-Host "Tunnel client: $tunnelVersionText"
Write-Host "Configured Runtime slots: $RuntimeSlots"
if ($SkipCoreStart) {
    Write-Host 'Core startup: skipped by -SkipCoreStart'
} else {
    Write-Host 'Core startup: configured Runtime slots READY'
}
Write-Host 'Operator Console: optional post-deployment control surface'
Write-Host ''
Write-Host 'Open Operator manually with:'
Write-Host "  $RepoRoot\P05-Operator.cmd"
