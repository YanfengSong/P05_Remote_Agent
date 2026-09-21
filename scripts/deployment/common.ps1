# P05 repo-local deployment helpers.
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

    # Backward-compatible migration fallback. Fresh bootstrap stores the key
    # in the Git-ignored repo-local .env, so new installs do not require HKCU.
    $reg = Get-ItemProperty -Path 'HKCU:\Environment' -Name 'CONTROL_PLANE_API_KEY' -ErrorAction SilentlyContinue
    if ($reg -and $reg.CONTROL_PLANE_API_KEY) {
        $env:CONTROL_PLANE_API_KEY = [string]$reg.CONTROL_PLANE_API_KEY
    }
    if (-not $env:CONTROL_PLANE_API_KEY) {
        throw 'CONTROL_PLANE_API_KEY is unavailable. Run bootstrap.ps1 or set it in .env.'
    }
}

function Resolve-P05Node {
    param([string]$RepoRoot)
    $local = Join-Path $RepoRoot '.p05\tools\node\node.exe'
    if (Test-Path -LiteralPath $local -PathType Leaf) {
        return (Resolve-Path $local).Path
    }
    if ($env:P05_NODE_PATH -and (Test-Path -LiteralPath $env:P05_NODE_PATH -PathType Leaf)) {
        return (Resolve-Path $env:P05_NODE_PATH).Path
    }
    throw 'Repo-local Node.js is missing. Run bootstrap.ps1.'
}

function Resolve-P05TunnelClient {
    param([string]$RepoRoot)
    $local = Join-Path $RepoRoot '.p05\tools\tunnel-client\tunnel-client.exe'
    if (Test-Path -LiteralPath $local -PathType Leaf) {
        return (Resolve-Path $local).Path
    }
    if ($env:P05_OPERATOR_TUNNEL_CLIENT -and (Test-Path -LiteralPath $env:P05_OPERATOR_TUNNEL_CLIENT -PathType Leaf)) {
        return (Resolve-Path $env:P05_OPERATOR_TUNNEL_CLIENT).Path
    }
    throw 'Repo-local tunnel-client is missing. Run bootstrap.ps1.'
}

function Get-P05SlotContext {
    param(
        [string]$ScriptRoot,
        [ValidateSet('A','B')][string]$Slot
    )
    $repo = Get-P05RepoRoot -ScriptRoot $ScriptRoot
    Import-P05DotEnv -RepoRoot $repo
    $node = Resolve-P05Node -RepoRoot $repo
    $tunnel = Resolve-P05TunnelClient -RepoRoot $repo
    $slotLower = $Slot.ToLowerInvariant()
    $profileName = if ($Slot -eq 'A') {
        if ($env:P05_RUNTIME_A_PROFILE) { $env:P05_RUNTIME_A_PROFILE } else { 'p05-a' }
    } else {
        if ($env:P05_RUNTIME_B_PROFILE) { $env:P05_RUNTIME_B_PROFILE } else { 'p05-b' }
    }
    if ($profileName -notmatch '^[A-Za-z0-9._-]{1,64}$') {
        throw "Invalid runtime profile name: $profileName"
    }

    $p05 = Join-Path $repo '.p05'
    $profileDir = Join-Path $p05 'tunnel\profiles'
    $healthDir = Join-Path $p05 'tunnel\health'
    $logDir = Join-Path $p05 'tunnel\logs'
    $stateDir = Join-Path $p05 ("runtime-$slotLower\state")
    foreach ($dir in @($profileDir,$healthDir,$logDir,$stateDir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }

    return [pscustomobject]@{
        Slot = $Slot
        RepoRoot = $repo
        Node = $node
        TunnelClient = $tunnel
        ProfileName = $profileName
        ProfileDir = $profileDir
        ProfilePath = Join-Path $profileDir ($profileName + '.yaml')
        HealthUrlFile = Join-Path $healthDir ($profileName + '.url')
        TunnelLog = Join-Path $logDir ($profileName + '.log')
        StateDir = $stateDir
        Launcher = Join-Path $repo 'scripts\deployment\launch-runtime.mjs'
        McpEntry = Join-Path $repo 'dist\index.js'
        EnvFile = Join-Path $repo '.env'
    }
}
