param(
    [string]$RuntimeSlots,
    [string]$TunnelA,
    [string]$TunnelB
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')
$repo = Get-P05RepoRoot -ScriptRoot $PSScriptRoot
Import-P05DotEnv -RepoRoot $repo

$slots = @(Get-P05ConfiguredSlots -Raw $RuntimeSlots)
if ($slots.Count -eq 0) { throw 'No runtime slots are configured.' }

if (-not $TunnelA) { $TunnelA = $env:P05_TUNNEL_A_ID }
if (-not $TunnelB) { $TunnelB = $env:P05_TUNNEL_B_ID }
if (($slots -contains 'A') -and -not (Test-P05TunnelId -Value $TunnelA)) {
    throw 'Valid P05_TUNNEL_A_ID is required for configured Runtime A.'
}
if (($slots -contains 'B') -and -not (Test-P05TunnelId -Value $TunnelB)) {
    throw 'Valid P05_TUNNEL_B_ID is required for configured Runtime B.'
}
if (($slots -contains 'A') -and ($slots -contains 'B') -and $TunnelA -eq $TunnelB) {
    throw 'Tunnel A and Tunnel B must be different.'
}

$p05 = Join-Path $repo '.p05'
$profileDir = Join-Path $p05 'tunnel\profiles'
$healthDir = Join-Path $p05 'tunnel\health'
New-Item -ItemType Directory -Path $profileDir -Force | Out-Null
New-Item -ItemType Directory -Path $healthDir -Force | Out-Null

foreach ($slot in @('A','B')) {
    $profileName = Get-P05SlotProfileName -Slot $slot
    $profilePath = Join-Path $profileDir ($profileName + '.yaml')
    $healthPath = Join-Path $healthDir ($profileName + '.url')

    if ($slots -notcontains $slot) {
        Remove-Item -LiteralPath $profilePath -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $healthPath -Force -ErrorAction SilentlyContinue
        Write-Output "Runtime $slot profile: NOT_CONFIGURED"
        continue
    }

    $ctx = Get-P05SlotContext -ScriptRoot $PSScriptRoot -Slot $slot
    $tunnelId = if ($slot -eq 'A') { $TunnelA } else { $TunnelB }
    $node = ($ctx.Node -replace '\\','/')
    $envFile = ((Join-Path $repo '.env') -replace '\\','/')
    $launcher = ($ctx.Launcher -replace '\\','/')
    $command = ('"' + $node + '" --env-file-if-exists="' + $envFile + '" "' + $launcher + '" ' + $slot)

    $profile = [ordered]@{
        admin_ui = [ordered]@{ open_browser = $false }
        config_version = 1
        control_plane = [ordered]@{
            api_key = 'env:CONTROL_PLANE_API_KEY'
            base_url = 'https://api.openai.com'
            tunnel_id = $tunnelId
        }
        health = [ordered]@{
            listen_addr = '127.0.0.1:0'
            url_file = $ctx.HealthUrlFile
        }
        log = [ordered]@{
            file = $ctx.TunnelLog
            format = 'json'
            level = 'info'
        }
        mcp = [ordered]@{
            commands = @(
                [ordered]@{
                    channel = 'main'
                    command = $command
                }
            )
        }
    }
    $profile | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $ctx.ProfilePath -Encoding UTF8
    Write-Output "Runtime $slot profile: $($ctx.ProfilePath)"
}
