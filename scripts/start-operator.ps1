param(
  [int]$Port = 56301
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$uri = "http://127.0.0.1:$Port"
$health = "$uri/healthz"

function Test-Operator {
  try {
    $r = Invoke-WebRequest -Uri $health -UseBasicParsing -TimeoutSec 2
    return $r.StatusCode -eq 200
  } catch {
    return $false
  }
}

if (Test-Operator) {
  Start-Process $uri
  exit 0
}

$node = $env:P05_NODE_PATH
if (-not $node) {
  $node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
}
if (-not $node -or -not (Test-Path $node)) {
  throw 'Node.js was not found. Set P05_NODE_PATH or put node.exe on PATH.'
}

$nodeDir = Split-Path -Parent $node
$npm = Join-Path $nodeDir 'npm.cmd'
if (-not (Test-Path $npm)) {
  $npm = (Get-Command npm.cmd -ErrorAction SilentlyContinue).Source
}
if (-not $npm) {
  throw 'npm.cmd was not found.'
}

Push-Location $repo
try {
  & $npm run build
  if ($LASTEXITCODE -ne 0) {
    throw "P05 build failed with exit code $LASTEXITCODE."
  }

  $state = Join-Path $repo '.p05'
  New-Item -ItemType Directory -Path $state -Force | Out-Null
  $stdout = Join-Path $state 'operator-console.log'
  $stderr = Join-Path $state 'operator-console.err.log'
  $envFile = Join-Path $repo '.env'
  $operator = Join-Path $repo 'dist\operator\server.js'

  $startArgs = @{
    FilePath = $node
    ArgumentList = @("--env-file-if-exists=$envFile", $operator)
    WorkingDirectory = $repo
    WindowStyle = 'Hidden'
    RedirectStandardOutput = $stdout
    RedirectStandardError = $stderr
  }
  Start-Process @startArgs
} finally {
  Pop-Location
}

for ($i = 0; $i -lt 30; $i++) {
  Start-Sleep -Milliseconds 500
  if (Test-Operator) {
    Start-Process $uri
    exit 0
  }
}

throw "P05 Operator Console did not become ready at $uri. Check .p05\operator-console.err.log."
