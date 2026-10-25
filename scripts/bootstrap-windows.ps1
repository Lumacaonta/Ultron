<#
.SYNOPSIS
Prepare a local ULTRON source checkout on Windows.

.DESCRIPTION
This is for contributors building from source. People installing the published
Setup.exe do not need to run it: the installer already includes the frontend
and local backend.
#>

[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($env:OS -ne 'Windows_NT') {
    throw 'scripts/bootstrap-windows.ps1 must run on Windows.'
}

$ScriptDirectory = Split-Path -Parent $PSCommandPath
$ProjectRoot = (Resolve-Path (Join-Path $ScriptDirectory '..')).Path
$BackendRoot = Join-Path $ProjectRoot 'backend'
$VenvDirectory = Join-Path $BackendRoot '.venv'
$VenvPython = Join-Path $VenvDirectory 'Scripts\python.exe'

$PythonExecutable = $env:PYTHON_BIN
if ([string]::IsNullOrWhiteSpace($PythonExecutable)) {
    $PythonExecutable = 'python'
}

if ($null -eq (Get-Command $PythonExecutable -ErrorAction SilentlyContinue)) {
    throw "Python was not found. Install Python 3.11+ or set PYTHON_BIN."
}
if ($null -eq (Get-Command 'npm' -ErrorAction SilentlyContinue)) {
    throw 'npm was not found. Install Node.js 22.13+ and run this script again.'
}

& node -e "const [major, minor] = process.versions.node.split('.').map(Number); if (major < 22 || (major === 22 && minor < 13)) { process.stderr.write('ULTRON requires Node.js 22.13 or later. Found ' + process.versions.node + '.\\n'); process.exit(1) }"
if ($LASTEXITCODE -ne 0) {
    throw 'The installed Node.js version is not supported.'
}

& $PythonExecutable -c "import sys; raise SystemExit('ULTRON requires Python 3.11 or later.') if sys.version_info < (3, 11) else None"
if ($LASTEXITCODE -ne 0) {
    throw 'The installed Python version is not supported.'
}

$EnvironmentFile = Join-Path $BackendRoot '.env'
if (-not (Test-Path -LiteralPath $EnvironmentFile -PathType Leaf)) {
    Copy-Item -LiteralPath (Join-Path $BackendRoot '.env.example') -Destination $EnvironmentFile
    Write-Host 'Created backend/.env from the safe example. Review it before use.'
}

& $PythonExecutable -m venv $VenvDirectory
if ($LASTEXITCODE -ne 0) {
    throw "Could not create the virtual environment at $VenvDirectory."
}
& $VenvPython -m pip install --upgrade pip
if ($LASTEXITCODE -ne 0) {
    throw 'Could not update pip.'
}
& $VenvPython -m pip install -r (Join-Path $ProjectRoot 'requirements.txt')
if ($LASTEXITCODE -ne 0) {
    throw 'Could not install backend dependencies.'
}

& npm --prefix (Join-Path $ProjectRoot 'frontend') ci
if ($LASTEXITCODE -ne 0) {
    throw 'Could not install frontend dependencies.'
}
& npm --prefix (Join-Path $ProjectRoot 'desktop') ci
if ($LASTEXITCODE -ne 0) {
    throw 'Could not install desktop dependencies.'
}

Write-Host 'ULTRON dependencies are ready. Start the backend with backend\.venv\Scripts\python.exe backend\launcher.py.'
