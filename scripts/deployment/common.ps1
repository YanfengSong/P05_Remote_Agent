# P05 deployment helpers. Machine-local values come from .env and tunnel-client metadata.
Set-StrictMode -Version Latest

function Get-P05RepoRoot {
    param([string]$ScriptRoot)
    return (Resolve-Path (Join-Path $ScriptRoot '..\..')).Path
}

function Import-P05DotEnv {
    param([string]$RepoRoot)
    $path = Join-Path $RepoRoot '.env'
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return }
    foreach ($line in Get-Content -LiteralPath $path) {
        $trimmed = $line.Trim()
        if (-not $trimmed -or $trimmed.StartsWith('#')) { continue }
        $eq = $trimmed.IndexOf('=')
        if ($eq -lt 1) { continue }
        $name = $trimmed.Substring(0,$eq).Trim()
        $value = $trimmed.Substring($eq+1)
        if ($name -match '^[A-Za-z_][A-Za-z0-9_]*$') {
            [Environment]::SetEnvironmentVariable($name,$value,'Process')
        }
    }
}

function Import-P05RuntimeKey {
    if ($env:CONTROL_PLANE_API_KEY) { return }
    $reg = Get-ItemProperty -Path 'HKCU:\Environment' -Name 'CONTROL_PLANE_API_KEY' -ErrorAction SilentlyContinue
    if ($reg -and $reg.CONTROL_PLANE_API_KEY) {
        $env:CONTROL_PLANE_API_KEY = [string]$reg.CONTROL_PLANE_API_KEY
    }
    if (-not $env:CONTROL_PLANE_API_KEY) {
        throw 'CONTROL_PLANE_API_KEY is not available in process or HKCU environment.'
    }
}

function Resolve-P05Node {
    param([string]$RepoRoot)
    if ($env:P05_NODE_PATH -and (Test-Path -LiteralPath $env:P05_NODE_PATH -PathType Leaf)) {
        return (Resolve-Path $env:P05_NODE_PATH).Path
    }
    $command = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    throw 'Node.js was not found. Set P05_NODE_PATH in .env or put node.exe on PATH.'
}

function Resolve-P05TunnelClient {
    param([string]$RepoRoot)
    if ($env:P05_OPERATOR_TUNNEL_CLIENT -and (Test-Path -LiteralPath $env:P05_OPERATOR_TUNNEL_CLIENT -PathType Leaf)) {
        return (Resolve-Path $env:P05_OPERATOR_TUNNEL_CLIENT).Path
    }
    $command = Get-Command tunnel-client.exe -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    $candidate = Get-ChildItem -LiteralPath $RepoRoot -Filter tunnel-client.exe -Recurse -File -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -match 'tunnel-client-' } |
        Select-Object -First 1
    if ($candidate) { return $candidate.FullName }
    throw 'tunnel-client.exe was not found. Set P05_OPERATOR_TUNNEL_CLIENT in .env or put it on PATH.'
}

function Get-P05RuntimeMetadata {
    param([string]$TunnelClient,[string]$Alias)
    if (-not $Alias) { throw 'P05_OPERATOR_TUNNEL_ALIAS is required in .env.' }
    $raw = & $TunnelClient runtimes list --json
    if ($LASTEXITCODE -ne 0) { throw 'tunnel-client runtimes list failed.' }
    $parsed = $raw | ConvertFrom-Json
    $entry = @($parsed.aliases) | Where-Object { $_.alias -eq $Alias } | Select-Object -First 1
    if (-not $entry) { throw "Runtime alias '$Alias' was not found in tunnel-client metadata." }
    if (-not $entry.tunnel_id) { throw "Runtime alias '$Alias' has no tunnel_id." }
    if (-not $entry.profile_name) { throw "Runtime alias '$Alias' has no profile_name." }
    return $entry
}

function Get-P05DeploymentContext {
    param([string]$ScriptRoot)
    $repo = Get-P05RepoRoot -ScriptRoot $ScriptRoot
    Import-P05DotEnv -RepoRoot $repo
    Import-P05RuntimeKey
    $node = Resolve-P05Node -RepoRoot $repo
    $tunnel = Resolve-P05TunnelClient -RepoRoot $repo
    $alias = $env:P05_OPERATOR_TUNNEL_ALIAS
    $meta = Get-P05RuntimeMetadata -TunnelClient $tunnel -Alias $alias
    $state = Join-Path $repo '.p05'
    $logs = Join-Path $state 'logs'
    New-Item -ItemType Directory -Path $logs -Force | Out-Null
    return [pscustomobject]@{
        RepoRoot = $repo
        Node = $node
        TunnelClient = $tunnel
        Alias = $alias
        Profile = [string]$meta.profile_name
        TunnelId = [string]$meta.tunnel_id
        ProfileDir = Split-Path -Parent ([string]$meta.profile_path)
        HealthUrlFile = [string]$meta.health_url_file
        TunnelLog = Join-Path $env:USERPROFILE ".local\state\tunnel-client\logs\$alias.log"
        StateDir = $state
        LogDir = $logs
        McpEntry = Join-Path $repo 'dist\index.js'
        EnvFile = Join-Path $repo '.env'
    }
}
