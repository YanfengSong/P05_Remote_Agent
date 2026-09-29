Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function New-P05PreflightCheck {
    param(
        [string]$Id,
        [string]$Label,
        [ValidateSet('PASS','MISSING','FAIL')][string]$Status,
        [string]$Detail,
        [bool]$Blocking,
        [bool]$Repairable = $false
    )
    return [pscustomobject]@{
        id = $Id
        label = $Label
        status = $Status
        detail = $Detail
        blocking = $Blocking
        repairable = $Repairable
    }
}

function Test-P05PathInsideRoot {
    param([string]$Candidate,[string]$Root)
    $candidatePath = [IO.Path]::GetFullPath($Candidate).TrimEnd([char[]]@('\','/'))
    $rootPath = [IO.Path]::GetFullPath($Root).TrimEnd([char[]]@('\','/'))
    if ($env:OS -eq 'Windows_NT') {
        $candidatePath = $candidatePath.ToLowerInvariant()
        $rootPath = $rootPath.ToLowerInvariant()
    }
    return $candidatePath -eq $rootPath -or $candidatePath.StartsWith($rootPath + [IO.Path]::DirectorySeparatorChar)
}

function Test-P05AllowedRootsValue {
    param([string]$Value,[string]$RequiredPath)
    if (-not $Value -or -not $Value.Trim()) {
        return [pscustomobject]@{ ok = $false; detail = 'Allowed roots are empty.'; roots = @() }
    }

    $roots = @($Value.Split(';') | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    if ($roots.Count -eq 0) {
        return [pscustomobject]@{ ok = $false; detail = 'Allowed roots contain no usable path.'; roots = @() }
    }

    foreach ($root in $roots) {
        if (-not [IO.Path]::IsPathRooted($root)) {
            return [pscustomobject]@{ ok = $false; detail = "Allowed root must be absolute: $root"; roots = $roots }
        }
        if (-not (Test-Path -LiteralPath $root -PathType Container)) {
            return [pscustomobject]@{ ok = $false; detail = "Allowed root does not exist or is not a directory: $root"; roots = $roots }
        }
    }

    $requiredInside = $roots | Where-Object { Test-P05PathInsideRoot -Candidate $RequiredPath -Root $_ } | Select-Object -First 1
    if (-not $requiredInside) {
        return [pscustomobject]@{
            ok = $false
            detail = 'The P05 repository must be inside REMOTE_AGENT_ALLOWED_ROOTS because it is the platform/default workspace.'
            roots = $roots
        }
    }

    return [pscustomobject]@{ ok = $true; detail = "$($roots.Count) allowed root(s) validated."; roots = $roots }
}

function Invoke-P05VersionCommand {
    param([string]$Command,[string[]]$Arguments = @('--version'))
    try {
        $output = & $Command @Arguments 2>&1
        if ($LASTEXITCODE -ne 0) {
            return [pscustomobject]@{ ok = $false; output = (($output | Out-String).Trim()) }
        }
        return [pscustomobject]@{ ok = $true; output = (($output | Out-String).Trim()) }
    } catch {
        return [pscustomobject]@{ ok = $false; output = $_.Exception.Message }
    }
}

function Test-P05RepoWritable {
    param([string]$Path)
    $probe = Join-Path $Path ('.p05-preflight-' + [guid]::NewGuid().ToString('N') + '.tmp')
    try {
        [IO.File]::WriteAllText($probe, 'p05-preflight', (New-Object Text.UTF8Encoding($false)))
        [IO.File]::Delete($probe)
        return $true
    } catch {
        try { if ([IO.File]::Exists($probe)) { [IO.File]::Delete($probe) } } catch {}
        return $false
    }
}

function Invoke-P05Preflight {
    param(
        [Parameter(Mandatory=$true)][string]$RepoRoot,
        [Parameter(Mandatory=$true)][string]$AllowedRoots,
        [ValidateSet('PreInstall','PostInstall')][string]$Stage = 'PreInstall',
        [string]$ExpectedNodeVersion = '22.23.1',
        [string]$ExpectedTunnelVersion = '0.0.14',
        [bool]$ManagedRequired = $false
    )

    $repo = [IO.Path]::GetFullPath($RepoRoot)
    $p05 = Join-Path $repo '.p05'
    $node = Join-Path $p05 'tools\node\node.exe'
    $npm = Join-Path $p05 'tools\node\npm.cmd'
    $tunnel = Join-Path $p05 'tools\tunnel-client\tunnel-client.exe'
    $checks = New-Object System.Collections.ArrayList

    $isWindows = $env:OS -eq 'Windows_NT'
    [void]$checks.Add((New-P05PreflightCheck 'os' 'Windows' $(if($isWindows){'PASS'}else{'FAIL'}) $(if($isWindows){'Windows detected.'}else{'P05 V2 bootstrap currently supports Windows only.'}) (-not $isWindows)))

    $isX64 = $isWindows -and [Environment]::Is64BitOperatingSystem -and $env:PROCESSOR_ARCHITECTURE -eq 'AMD64'
    [void]$checks.Add((New-P05PreflightCheck 'arch' 'Architecture' $(if($isX64){'PASS'}else{'FAIL'}) $(if($isX64){'Windows x64 detected.'}else{'Windows x64 (AMD64) is required by the pinned V2 toolchain.'}) (-not $isX64)))

    $psOk = $PSVersionTable.PSVersion.Major -ge 5
    [void]$checks.Add((New-P05PreflightCheck 'powershell' 'PowerShell' $(if($psOk){'PASS'}else{'FAIL'}) ("PowerShell " + $PSVersionTable.PSVersion.ToString()) (-not $psOk)))

    $git = Get-Command git -ErrorAction SilentlyContinue
    if ($git) {
        $gitVersion = Invoke-P05VersionCommand -Command $git.Source
        [void]$checks.Add((New-P05PreflightCheck 'git' 'Git' $(if($gitVersion.ok){'PASS'}else{'FAIL'}) $(if($gitVersion.ok){$gitVersion.output}else{'Git exists but could not execute.'}) (-not $gitVersion.ok)))
    } else {
        [void]$checks.Add((New-P05PreflightCheck 'git' 'Git' 'FAIL' 'Git is required for the clone-based deployment flow.' $true))
    }

    $repoOk = $false
    try {
        $inside = & git -C $repo rev-parse --is-inside-work-tree 2>$null
        $repoOk = $LASTEXITCODE -eq 0 -and (($inside | Out-String).Trim() -eq 'true')
    } catch { $repoOk = $false }
    [void]$checks.Add((New-P05PreflightCheck 'repo' 'Git repository' $(if($repoOk){'PASS'}else{'FAIL'}) $(if($repoOk){'Repository is a valid Git worktree.'}else{'Bootstrap must run from a valid P05 Git worktree.'}) (-not $repoOk)))

    $writable = Test-P05RepoWritable -Path $repo
    [void]$checks.Add((New-P05PreflightCheck 'repo-write' 'Repo write access' $(if($writable){'PASS'}else{'FAIL'}) $(if($writable){'Repository-local state can be created.'}else{'Repository is not writable for repo-local P05 state.'}) (-not $writable)))

    $rootResult = Test-P05AllowedRootsValue -Value $AllowedRoots -RequiredPath $repo
    [void]$checks.Add((New-P05PreflightCheck 'allowed-roots' 'Allowed roots' $(if($rootResult.ok){'PASS'}else{'FAIL'}) $rootResult.detail (-not $rootResult.ok)))

    $envTemplate = Test-Path -LiteralPath (Join-Path $repo '.env.example') -PathType Leaf
    [void]$checks.Add((New-P05PreflightCheck 'env-template' '.env template' $(if($envTemplate){'PASS'}else{'FAIL'}) $(if($envTemplate){'.env.example is available.'}else{'.env.example is missing.'}) (-not $envTemplate)))

    $managedBlocking = $ManagedRequired -or $Stage -eq 'PostInstall'

    if (Test-Path -LiteralPath $node -PathType Leaf) {
        $nodeVersion = Invoke-P05VersionCommand -Command $node
        $versionOk = $nodeVersion.ok -and $nodeVersion.output -match ('^v' + [regex]::Escape($ExpectedNodeVersion) + '(\s|$)')
        [void]$checks.Add((New-P05PreflightCheck 'node' 'Repo-local Node' $(if($versionOk){'PASS'}else{'FAIL'}) $(if($versionOk){$nodeVersion.output}else{"Expected Node v$ExpectedNodeVersion; found '$($nodeVersion.output)'."}) $(if($versionOk){$false}else{$managedBlocking}) $(if($versionOk){$false}else{-not $managedBlocking})))
    } else {
        [void]$checks.Add((New-P05PreflightCheck 'node' 'Repo-local Node' $(if($managedBlocking){'FAIL'}else{'MISSING'}) 'Repo-local Node is not installed.' $managedBlocking (-not $managedBlocking)))
    }

    if (Test-Path -LiteralPath $npm -PathType Leaf) {
        $npmVersion = Invoke-P05VersionCommand -Command $npm
        [void]$checks.Add((New-P05PreflightCheck 'npm' 'Repo-local npm' $(if($npmVersion.ok){'PASS'}else{'FAIL'}) $(if($npmVersion.ok){("npm " + $npmVersion.output)}else{'Repo-local npm exists but could not execute.'}) $(if($npmVersion.ok){$false}else{$managedBlocking}) $(if($npmVersion.ok){$false}else{-not $managedBlocking})))
    } else {
        [void]$checks.Add((New-P05PreflightCheck 'npm' 'Repo-local npm' $(if($managedBlocking){'FAIL'}else{'MISSING'}) 'Repo-local npm is not installed.' $managedBlocking (-not $managedBlocking)))
    }

    if (Test-Path -LiteralPath $tunnel -PathType Leaf) {
        $tunnelVersion = Invoke-P05VersionCommand -Command $tunnel
        $versionOk = $tunnelVersion.ok -and $tunnelVersion.output -match ('^' + [regex]::Escape($ExpectedTunnelVersion) + '(\+|\s|$)')
        [void]$checks.Add((New-P05PreflightCheck 'tunnel-client' 'Tunnel client' $(if($versionOk){'PASS'}else{'FAIL'}) $(if($versionOk){$tunnelVersion.output}else{"Expected tunnel-client $ExpectedTunnelVersion; found '$($tunnelVersion.output)'."}) $(if($versionOk){$false}else{$managedBlocking}) $(if($versionOk){$false}else{-not $managedBlocking})))
    } else {
        [void]$checks.Add((New-P05PreflightCheck 'tunnel-client' 'Tunnel client' $(if($managedBlocking){'FAIL'}else{'MISSING'}) 'Repo-local tunnel-client is not installed.' $managedBlocking (-not $managedBlocking)))
    }

    $blockingFailures = @($checks | Where-Object { $_.blocking -and $_.status -ne 'PASS' })
    $repairable = @($checks | Where-Object { $_.repairable -and $_.status -ne 'PASS' })
    $overall = if ($blockingFailures.Count -gt 0) { 'FAIL' } elseif ($repairable.Count -gt 0) { 'REPAIRABLE' } else { 'PASS' }

    return [pscustomobject]@{
        stage = $Stage
        overall = $overall
        repoRoot = $repo
        checks = @($checks)
    }
}

function Write-P05PreflightReport {
    param([Parameter(Mandatory=$true)]$Report)
    Write-Host ''
    Write-Host ("P05 Preflight - " + $Report.stage) -ForegroundColor Cyan
    foreach ($check in $Report.checks) {
        $color = switch ($check.status) {
            'PASS' { 'Green' }
            'MISSING' { 'Yellow' }
            default { 'Red' }
        }
        Write-Host (("[{0}] {1}" -f $check.status,$check.label).PadRight(34) + $check.detail) -ForegroundColor $color
    }
    $resultColor = if ($Report.overall -eq 'PASS') { 'Green' } elseif ($Report.overall -eq 'REPAIRABLE') { 'Yellow' } else { 'Red' }
    Write-Host ("Preflight result: " + $Report.overall) -ForegroundColor $resultColor
}

function Assert-P05Preflight {
    param([Parameter(Mandatory=$true)]$Report)
    if ($Report.overall -eq 'FAIL') {
        $failed = @($Report.checks | Where-Object { $_.blocking -and $_.status -ne 'PASS' } | ForEach-Object { $_.label })
        throw ('P05 preflight failed: ' + ($failed -join ', ') + '.')
    }
}
