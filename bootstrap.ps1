param(
    [string]$TunnelA,
    [string]$TunnelB,
    [string]$ApiKey,
    [string]$AllowedRoots,
    [switch]$SkipToolDownload,
    [switch]$SkipBuild
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
    Write-Host "Downloading $Url"
    Invoke-WebRequest -Uri $Url -OutFile $Destination -UseBasicParsing
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
    if ((Test-Path -LiteralPath $NodeExe -PathType Leaf) -and
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
    if (Test-Path -LiteralPath $TunnelExe -PathType Leaf) {
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

if (-not $TunnelA) { $TunnelA = Read-Host 'Tunnel ID for @Boonray-A' }
if (-not $TunnelB) { $TunnelB = Read-Host 'Tunnel ID for @Boonray-B' }
Assert-TunnelId 'TunnelA' $TunnelA
Assert-TunnelId 'TunnelB' $TunnelB
if ($TunnelA -eq $TunnelB) { throw 'Tunnel A and Tunnel B must be different.' }

if (-not $ApiKey) { $ApiKey = Read-SecretPlainText 'OpenAI Control Plane API Key' }
if (-not $ApiKey) { throw 'API key is required.' }

if (-not $AllowedRoots) { $AllowedRoots = $RepoRoot }

New-Item -ItemType Directory -Path $P05Root -Force | Out-Null

if (-not $SkipToolDownload) {
    Install-Node
    Install-TunnelClient
}
if (-not (Test-Path -LiteralPath $NodeExe -PathType Leaf)) {
    throw "Repo-local Node is missing: $NodeExe"
}
if (-not (Test-Path -LiteralPath $NpmCmd -PathType Leaf)) {
    throw "Repo-local npm is missing: $NpmCmd"
}
if (-not (Test-Path -LiteralPath $TunnelExe -PathType Leaf)) {
    throw "Repo-local tunnel-client is missing: $TunnelExe"
}

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
    P05_RUNTIME_A_PROFILE = 'p05-a'
    P05_RUNTIME_B_PROFILE = 'p05-b'
    P05_TUNNEL_A_ID = $TunnelA
    P05_TUNNEL_B_ID = $TunnelB
    CONTROL_PLANE_API_KEY = $ApiKey
}
foreach ($name in $managed.Keys) {
    Set-DotEnvValue $EnvFile $name ([string]$managed[$name])
}

$matlabToolkit = Join-Path $env:USERPROFILE '.matlab\agentic-toolkits\bin\matlab-mcp-server.exe'
if (Test-Path -LiteralPath $matlabToolkit -PathType Leaf) {
    Set-DotEnvValue $EnvFile 'MATLAB_MCP_ENABLED' 'true'
}

foreach ($slot in @('a','b')) {
    $state = Join-Path $P05Root ("runtime-$slot\state")
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

& (Join-Path $RepoRoot 'scripts\deployment\write-runtime-profiles.ps1') -TunnelA $TunnelA -TunnelB $TunnelB

$nodeVersionText = (& $NodeExe --version).Trim()
$tunnelVersionText = (& $TunnelExe --version).Trim()

Write-Host ''
Write-Host 'P05 bootstrap complete.' -ForegroundColor Green
Write-Host "Repo: $RepoRoot"
Write-Host "Node: $nodeVersionText"
Write-Host "Tunnel client: $tunnelVersionText"
Write-Host 'Automatic startup: disabled'
Write-Host 'Runtime A/B: stopped until you enable them in Operator Console'
Write-Host ''
Write-Host 'Start manually with:'
Write-Host "  $RepoRoot\P05-Operator.cmd"
