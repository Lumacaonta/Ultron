<#
.SYNOPSIS
Build a native Windows x64 ULTRON desktop package.

.DESCRIPTION
This script must run on Windows. It rebuilds the frontend, creates a native
Windows PyInstaller backend, copies only those generated runtime resources into
Electron, then packages or makes the Windows artifacts. A recipient of the
finished installer does not need Python, Node.js, Git, or a developer .env.
#>

[CmdletBinding()]
param(
    [ValidateSet('x64')]
    [string]$Architecture = 'x64',
    [switch]$Make
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($env:OS -ne 'Windows_NT') {
    throw 'scripts/build-windows.ps1 must run on Windows. PyInstaller cannot create a supported Windows backend from macOS or Linux.'
}

$ScriptDirectory = Split-Path -Parent $PSCommandPath
$ProjectRoot = (Resolve-Path (Join-Path $ScriptDirectory '..')).Path
$FrontendRoot = Join-Path $ProjectRoot 'frontend'
$DesktopRoot = Join-Path $ProjectRoot 'desktop'
$BackendRoot = Join-Path $ProjectRoot 'backend'
$FrontendSource = Join-Path $FrontendRoot 'dist'
$FrontendTarget = Join-Path $DesktopRoot 'resources\frontend'
$BackendSource = Join-Path $BackendRoot 'dist\ultron-backend.exe'
$BackendTargetDirectory = Join-Path $DesktopRoot 'resources\backend'
$DesktopOut = Join-Path $DesktopRoot 'out'
$DesktopMake = Join-Path $DesktopOut 'make'

$PythonExecutable = $env:PYTHON_BIN
if ([string]::IsNullOrWhiteSpace($PythonExecutable)) {
    $PythonExecutable = Join-Path $BackendRoot '.venv\Scripts\python.exe'
}

function Assert-Command {
    param([Parameter(Mandatory = $true)][string]$Name)

    if ($null -eq (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "Required command was not found: $Name"
    }
}

function Reset-GeneratedDirectory {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (Test-Path -LiteralPath $Path) {
        Remove-Item -LiteralPath $Path -Recurse -Force
    }
    New-Item -ItemType Directory -Path $Path -Force | Out-Null
}

function Invoke-Npm {
    param([Parameter(Mandatory = $true)][string[]]$Arguments)

    & npm @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "npm command failed with exit code $LASTEXITCODE."
    }
}

Assert-Command -Name 'npm'
Assert-Command -Name 'node'

if (-not (Test-Path -LiteralPath $PythonExecutable -PathType Leaf)) {
    throw "Python environment not found at $PythonExecutable. Run the Windows setup steps first."
}

if (-not (Test-Path -LiteralPath (Join-Path $FrontendRoot 'node_modules') -PathType Container) -or
    -not (Test-Path -LiteralPath (Join-Path $DesktopRoot 'node_modules') -PathType Container)) {
    throw 'Node dependencies are missing. Run npm ci in frontend and desktop before packaging.'
}

# Electron and PyInstaller must both be x64. An ARM64 Python backend paired
# with an x64 Electron shell would create an installer that cannot start.
$NodeArchitecture = (& node -p 'process.arch').Trim()
if ($LASTEXITCODE -ne 0 -or $NodeArchitecture -ne 'x64') {
    throw "The Windows x64 build requires an x64 Node.js process. Found $NodeArchitecture."
}
$PythonArchitecture = (& $PythonExecutable -c "import platform; print(platform.machine().lower())").Trim()
if ($LASTEXITCODE -ne 0 -or $PythonArchitecture -notin @('amd64', 'x86_64')) {
    throw "The Windows x64 build requires an x64 Python environment. Found $PythonArchitecture."
}

# Recreate only generated package folders. No account profile, .env, vault or
# selected model is ever copied into a public distributable.
Reset-GeneratedDirectory -Path $FrontendTarget
Reset-GeneratedDirectory -Path $BackendTargetDirectory
Reset-GeneratedDirectory -Path $DesktopOut
if ($Make) {
    Reset-GeneratedDirectory -Path $DesktopMake
}

Invoke-Npm -Arguments @('--prefix', $FrontendRoot, 'run', 'build')

if (-not (Test-Path -LiteralPath $FrontendSource -PathType Container)) {
    throw "Frontend build output was not created at $FrontendSource."
}
Copy-Item -Path (Join-Path $FrontendSource '*') -Destination $FrontendTarget -Recurse -Force

Push-Location $BackendRoot
try {
    & $PythonExecutable -m PyInstaller --noconfirm --clean ultron-backend.spec
    if ($LASTEXITCODE -ne 0) {
        throw "PyInstaller failed with exit code $LASTEXITCODE."
    }
}
finally {
    Pop-Location
}

if (-not (Test-Path -LiteralPath $BackendSource -PathType Leaf)) {
    throw "Windows backend bundle was not created at $BackendSource."
}
Copy-Item -LiteralPath $BackendSource -Destination (Join-Path $BackendTargetDirectory 'ultron-backend.exe') -Force

# Preserve the documented resource placeholders in a developer checkout while
# keeping the generated content ignored by source control.
New-Item -ItemType File -Path (Join-Path $FrontendTarget '.gitkeep') -Force | Out-Null
New-Item -ItemType File -Path (Join-Path $BackendTargetDirectory '.gitkeep') -Force | Out-Null

$ForgeAction = if ($Make) { 'make:win' } else { 'package:win' }
Invoke-Npm -Arguments @('--prefix', $DesktopRoot, 'run', $ForgeAction)

$PackageDirectory = Join-Path $DesktopOut "ULTRON ai-win32-$Architecture"
$PackageExecutable = Join-Path $PackageDirectory 'ULTRON ai.exe'
if (-not (Test-Path -LiteralPath $PackageExecutable -PathType Leaf)) {
    throw "Electron packaging did not create $PackageExecutable."
}

Write-Host "Windows package created: $PackageDirectory"
if ($Make) {
    Write-Host "Windows installer and portable archive created under $DesktopMake."
}
