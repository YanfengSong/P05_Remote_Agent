$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

. (Join-Path $PSScriptRoot 'common.ps1')
. (Join-Path $PSScriptRoot 'preflight-lib.ps1')

$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$fixture = Join-Path $repo '.p05\test-preflight-fixture'
$checks = 0

function Check([string]$Label,[bool]$Condition,[string]$Detail='') {
    $script:checks += 1
    if (-not $Condition) {
        throw "FAIL $Label$(if($Detail){' -> '+$Detail}else{''})"
    }
}

try {
    if (Test-Path -LiteralPath $fixture) {
        [IO.Directory]::Delete($fixture,$true)
    }
    New-Item -ItemType Directory -Path $fixture -Force | Out-Null
    [IO.File]::WriteAllText((Join-Path $fixture '.env.example'), "REMOTE_AGENT_ALLOWED_ROOTS=`n", (New-Object Text.UTF8Encoding($false)))
    & git -C $fixture init --quiet
    if ($LASTEXITCODE -ne 0) { throw 'Could not initialize preflight test repository.' }

    $slots = ConvertTo-P05RuntimeSlots -Raw 'A,B'
    Check 'slot helper remains available beside preflight' (($slots -join ',') -eq 'A,B') ($slots -join ',')

    $pre = Invoke-P05Preflight -RepoRoot $fixture -AllowedRoots $fixture -Stage PreInstall
    Check 'missing managed tools are repairable before install' ($pre.overall -eq 'REPAIRABLE') $pre.overall
    foreach ($id in @('node','npm','tunnel-client')) {
        $entry = $pre.checks | Where-Object { $_.id -eq $id } | Select-Object -First 1
        Check "preinstall $id is repairable" ($entry.status -eq 'MISSING' -and $entry.repairable -and -not $entry.blocking) ($entry | ConvertTo-Json -Compress)
    }

    $required = Invoke-P05Preflight -RepoRoot $fixture -AllowedRoots $fixture -Stage PreInstall -ManagedRequired $true
    Check 'SkipToolDownload semantics fail closed on missing managed tools' ($required.overall -eq 'FAIL') $required.overall

    $post = Invoke-P05Preflight -RepoRoot $fixture -AllowedRoots $fixture -Stage PostInstall
    Check 'postinstall fails when managed tools are still missing' ($post.overall -eq 'FAIL') $post.overall

    $relative = Test-P05AllowedRootsValue -Value 'relative-path' -RequiredPath $fixture
    Check 'relative allowed root is rejected' (-not $relative.ok) $relative.detail

    $windowsRoot = [IO.Path]::GetPathRoot($fixture)
    $outside = Test-P05AllowedRootsValue -Value $windowsRoot -RequiredPath $fixture
    Check 'parent/root allowed root can contain repository' $outside.ok $outside.detail

    $other = Join-Path $fixture 'other'
    New-Item -ItemType Directory -Path $other -Force | Out-Null
    $nestedRepo = Join-Path $fixture 'nested-repo'
    New-Item -ItemType Directory -Path $nestedRepo -Force | Out-Null
    $notContained = Test-P05AllowedRootsValue -Value $other -RequiredPath $nestedRepo
    Check 'allowed roots must contain the P05 repository' (-not $notContained.ok) $notContained.detail

    Write-Output "DEPLOYMENT_PREFLIGHT_OK ($checks checks)"
} finally {
    if (Test-Path -LiteralPath $fixture) {
        try { [IO.Directory]::Delete($fixture,$true) } catch {}
    }
}
