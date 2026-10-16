[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$RepoNorm = $RepoRoot.TrimEnd("\/").ToLowerInvariant()

function Assert-RepoPath {
    param([string]$Path,[string]$Label)
    $resolved = [IO.Path]::GetFullPath($Path)
    $norm = $resolved.TrimEnd("\/").ToLowerInvariant()
    if ($norm -ne $RepoNorm -and -not $norm.StartsWith($RepoNorm + "\")) {
        throw "$Label is outside the P05 repository: $resolved"
    }
}

$violations = New-Object System.Collections.Generic.List[string]

# Runtime source must not discover P05 persistence from the user profile or
# global application-data directories. Tests and docs are excluded because
# they intentionally contain fixtures and negative security cases.
$sourceFiles = @()
$sourceFiles += Get-ChildItem -LiteralPath $RepoRoot -File -Filter "*.ps1"
$sourceFiles += Get-ChildItem -LiteralPath (Join-Path $RepoRoot "src") -Recurse -File -Include "*.ts","*.tsx","*.js","*.mjs","*.json"
$sourceFiles += Get-ChildItem -LiteralPath (Join-Path $RepoRoot "scripts") -Recurse -File -Include "*.ps1","*.psm1","*.mjs","*.js","*.json"

$excluded = @(
    "\src\test\",
    "\scripts\test\",
    "\docs\",
    "\node_modules\",
    "\dist\",
    "\.p05\"
)

$forbiddenPatterns = @(
    "os\.homedir\(",
    "process\.env\.(USERPROFILE|APPDATA|LOCALAPPDATA|PROGRAMDATA)\b",
    "\$env:(USERPROFILE|APPDATA|LOCALAPPDATA|PROGRAMDATA)\b",
    "(?i)~[/\\]\.matlab[/\\]agentic-toolkits",
    "(?i)[A-Z]:\\Users\\.+\\\.p05(?:\\|$)"
)

foreach ($file in $sourceFiles) {
    $full = $file.FullName
    if ($excluded | Where-Object { $full -match [regex]::Escape($_) }) { continue }

    $relative = $full.Substring($RepoRoot.Length).TrimStart("\/")
    foreach ($pattern in $forbiddenPatterns) {
        $matches = Select-String -LiteralPath $full -Pattern $pattern -AllMatches -ErrorAction SilentlyContinue
        if ($matches) {
            # This script only reads USERPROFILE to detect host-path leakage in
            # Golden State; it never uses the value as a P05 storage location.
            if ($relative -ieq "scripts\sync\publish-golden-state.ps1" -and
                $pattern -match "USERPROFILE") {
                continue
            }
            foreach ($match in $matches) {
                $violations.Add("$relative:$($match.LineNumber) matched forbidden global path pattern.")
            }
        }
    }
}

# Check existing machine-local configuration without printing secret values.
$envFile = Join-Path $RepoRoot ".env"
if (Test-Path -LiteralPath $envFile -PathType Leaf) {
    $pathKeys = @(
        "P05_STATE_DIR",
        "P05_HTTP_REVIEWER_STATE_DIR",
        "MATLAB_AGENTIC_TOOLKIT_ROOT",
        "MATLAB_MCP_COMMAND",
        "P05_NODE_PATH",
        "P05_OPERATOR_TUNNEL_CLIENT",
        "NPM_CONFIG_CACHE"
    )
    foreach ($line in Get-Content -LiteralPath $envFile) {
        if ($line -match "^([A-Za-z_][A-Za-z0-9_]*)=(.*)$") {
            $name = $Matches[1]
            $value = $Matches[2].Trim()
            if ($pathKeys -contains $name -and $value) {
                try { Assert-RepoPath -Path $value -Label $name }
                catch { $violations.Add($_.Exception.Message) }
            }
        }
    }
}

$managedRoots = @(
    (Join-Path $RepoRoot ".p05"),
    (Join-Path $RepoRoot "node_modules"),
    (Join-Path $RepoRoot "dist")
)
foreach ($root in $managedRoots) {
    Assert-RepoPath -Path $root -Label "Managed root"
}

if ($violations.Count -gt 0) {
    Write-Host "P05 PATH AUDIT FAILED" -ForegroundColor Red
    $violations | ForEach-Object { Write-Host " - $_" -ForegroundColor Red }
    exit 1
}

Write-Host "P05 PATH AUDIT OK" -ForegroundColor Green
Write-Host "Repo root: $RepoRoot"
Write-Host "Managed state root: $(Join-Path $RepoRoot '.p05')"
Write-Host "NPM cache: $(Join-Path $RepoRoot '.p05\npm-cache')"
Write-Host "MATLAB toolkit root: $(Join-Path $RepoRoot '.p05\tools\matlab\agentic-toolkits')"
