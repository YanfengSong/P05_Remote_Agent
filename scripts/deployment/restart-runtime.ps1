# P05 Remote Agent - restart the managed tunnel/MCP runtime without touching Operator Console.
$ErrorActionPreference = 'Continue'

$P05Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$TunnelClient = 'D:\Tools\tunnel-client\tunnel-client.exe'
$Alias = 'p05-boonray'
$Profile = 'p05-boonray5cd6065z9h'
$RuntimeTask = 'P05-Runtime'
$Log = "$env:USERPROFILE\.local\state\tunnel-client\logs\p05-boonray.log"
$UrlFile = "$env:USERPROFILE\.local\state\tunnel-client\health\p05-boonray.url"
$McpEntry = Join-Path $P05Root 'dist\index.js'
$McpEntryForward = $McpEntry -replace '\\','/'

$env:CONTROL_PLANE_HTTP_PROXY = 'http://127.0.0.1:7892'
$env:HTTPS_PROXY = 'http://127.0.0.1:7892'
$reg = Get-ItemProperty -Path 'HKCU:\Environment' -Name 'CONTROL_PLANE_API_KEY' -ErrorAction SilentlyContinue
if ($reg) { $env:CONTROL_PLANE_API_KEY = "$($reg.CONTROL_PLANE_API_KEY)" }

function Get-P05RuntimeNode {
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
        Where-Object {
            $_.CommandLine -and (
                $_.CommandLine -like "*$McpEntry*" -or
                $_.CommandLine -like "*$McpEntryForward*"
            )
        }
}

function Get-P05Tunnel {
    Get-CimInstance Win32_Process -Filter "Name='tunnel-client.exe'" -ErrorAction SilentlyContinue |
        Where-Object {
            $_.CommandLine -and (
                $_.CommandLine -like "*--profile $Profile*" -or
                $_.CommandLine -like "*--alias $Alias*"
            )
        }
}

Write-Host "== 1. before =="
Write-Host "   now: $(Get-Date -Format 'HH:mm:ss')"
@(
    Get-P05Tunnel | Select-Object @{N='Id';E={$_.ProcessId}}, @{N='ProcessName';E={'tunnel-client'}}, CommandLine
    Get-P05RuntimeNode | Select-Object @{N='Id';E={$_.ProcessId}}, @{N='ProcessName';E={'node'}}, CommandLine
) | Format-Table -AutoSize
$logLinesBefore = (Get-Content $Log -ErrorAction SilentlyContinue | Measure-Object).Count
Write-Host "   alias log lines before: $logLinesBefore"

Write-Host ""
Write-Host "== 2. stop only the managed P05 runtime =="
& $TunnelClient runtimes stop $Alias 2>&1 | ForEach-Object { Write-Host "   $_" }

Get-P05Tunnel | ForEach-Object {
    Write-Host "   killing stale P05 tunnel-client pid $($_.ProcessId)"
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
}

Get-P05RuntimeNode | ForEach-Object {
    Write-Host "   killing stale P05 MCP node pid $($_.ProcessId)"
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
}

Remove-Item $UrlFile -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 3
Start-ScheduledTask -TaskName $RuntimeTask
Write-Host "   task started at $(Get-Date -Format 'HH:mm:ss')"

Write-Host ""
Write-Host "== 3. wait for the new runtime to come up =="
$up = $false
for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Seconds 3
    if (Test-Path $UrlFile) {
        $base = (Get-Content $UrlFile -Raw).Trim()
        try {
            $h = Invoke-WebRequest -Uri "$base/healthz" -UseBasicParsing -TimeoutSec 4
            $r = Invoke-WebRequest -Uri "$base/readyz" -UseBasicParsing -TimeoutSec 4
            Write-Host "   $base/healthz -> $($h.StatusCode) $($h.Content.Trim()) | /readyz -> $($r.StatusCode) $($r.Content.Trim())"
            if ($r.StatusCode -eq 200) { $up = $true; break }
        } catch { }
    }
    if ($i % 4 -eq 3) { Write-Host "   t+$((($i + 1) * 3))s ..." }
}
Write-Host "   ready = $up"

Write-Host ""
Write-Host "== 4. managed processes after restart =="
@(
    Get-P05Tunnel | Select-Object @{N='Id';E={$_.ProcessId}}, @{N='ProcessName';E={'tunnel-client'}}, CommandLine
    Get-P05RuntimeNode | Select-Object @{N='Id';E={$_.ProcessId}}, @{N='ProcessName';E={'node'}}, CommandLine
) | Format-Table -AutoSize

Write-Host ""
Write-Host "== 5. newest managed-runtime log lines =="
Get-Content $Log -ErrorAction SilentlyContinue |
    Where-Object { $_ -match '"msg":"(stdio MCP command started|mcp session initialized|tunnel-client started|tunnel metadata fetched|forwarded command to MCP server|OnStart hook failed|start failed)"' } |
    Select-Object -Last 5 |
    ForEach-Object {
        $line = $_
        if ($line.Length -gt 420) { $line = $line.Substring(0, 420) + ' ...' }
        Write-Host "   $line"
    }

Write-Host ""
Write-Host "== 6. tool profile report =="
$report = Get-Content $Log -ErrorAction SilentlyContinue |
    Where-Object { $_ -match 'p05.tool_profile' } |
    Select-Object -Last 1
if ($report) {
    $line = $report
    if ($line.Length -gt 700) { $line = $line.Substring(0, 700) + ' ...' }
    Write-Host "   $line"
} else {
    Write-Host "   (tool profile banner not present in tunnel log)"
}

Write-Host ""
Write-Host "== 7. identity unchanged? =="
Get-Content (Join-Path $P05Root '.p05\device.json') -ErrorAction SilentlyContinue |
    ForEach-Object { Write-Host "   $_" }

Write-Host ""
Write-Host "RUNTIME_RESTART_DONE $(Get-Date -Format 'HH:mm:ss')"
