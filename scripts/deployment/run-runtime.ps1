$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')
$ctx = Get-P05DeploymentContext -ScriptRoot $PSScriptRoot

if (-not (Test-Path -LiteralPath $ctx.McpEntry -PathType Leaf)) {
    throw "P05 build output not found: $($ctx.McpEntry)"
}

$env:P05_STATE_DIR = $ctx.StateDir
$mcpCommand = (($ctx.Node -replace '\\','/') + ' --env-file-if-exists=' + ($ctx.EnvFile -replace '\\','/') + ' ' + ($ctx.McpEntry -replace '\\','/'))
$log = Join-Path $ctx.LogDir 'runtime-launcher.log'

"==== runtimes connect $(Get-Date -Format o) ====" | Add-Content -LiteralPath $log
& $ctx.TunnelClient runtimes connect `
    --alias $ctx.Alias `
    --tunnel-id $ctx.TunnelId `
    --runtime-api-key env:CONTROL_PLANE_API_KEY `
    --mcp-command $mcpCommand `
    --profile $ctx.Profile 2>&1 | Tee-Object -FilePath $log -Append
$exit = $LASTEXITCODE
"==== connect exited $exit $(Get-Date -Format o) ====" | Add-Content -LiteralPath $log
exit $exit
