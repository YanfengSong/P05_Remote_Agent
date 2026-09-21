param(
    [string]$TunnelA,
    [string]$TunnelB
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')
$repo = Get-P05RepoRoot -ScriptRoot $PSScriptRoot
Import-P05DotEnv -RepoRoot $repo

if (-not $TunnelA) { $TunnelA = $env:P05_TUNNEL_A_ID }
if (-not $TunnelB) { $TunnelB = $env:P05_TUNNEL_B_ID }
if (-not $TunnelA -or $TunnelA -notmatch '^tunnel_[A-Za-z0-9]+$') { throw 'Valid P05_TUNNEL_A_ID is required.' }
if (-not $TunnelB -or $TunnelB -notmatch '^tunnel_[A-Za-z0-9]+$') { throw 'Valid P05_TUNNEL_B_ID is required.' }

foreach ($slot in @('A','B')) {
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
