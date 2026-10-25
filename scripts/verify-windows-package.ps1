<#
.SYNOPSIS
Verify a completed native Windows ULTRON package without reading user data.
#>

[CmdletBinding()]
param(
    [string]$PackageDirectory,
    [switch]$RequireSignature
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($env:OS -ne 'Windows_NT') {
    throw 'scripts/verify-windows-package.ps1 must run on Windows.'
}

$ScriptDirectory = Split-Path -Parent $PSCommandPath
$ProjectRoot = (Resolve-Path (Join-Path $ScriptDirectory '..')).Path
$DesktopRoot = Join-Path $ProjectRoot 'desktop'
$DefaultPackage = Join-Path $DesktopRoot 'out\ULTRON ai-win32-x64'
if ([string]::IsNullOrWhiteSpace($PackageDirectory)) {
    $PackageDirectory = $DefaultPackage
}
$PackageDirectory = (Resolve-Path $PackageDirectory).Path

function Assert-File {
    param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$Description)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "$Description is missing: $Path"
    }
}

function Relative-FileRecords {
    param([Parameter(Mandatory = $true)][string]$Root)

    $rootPath = (Resolve-Path $Root).Path.TrimEnd('\')
    Get-ChildItem -LiteralPath $rootPath -File -Recurse | Where-Object {
        $_.Name -ne '.gitkeep'
    } | ForEach-Object {
        [PSCustomObject]@{
            Relative = $_.FullName.Substring($rootPath.Length).TrimStart('\')
            FullName = $_.FullName
        }
    }
}

$AppExecutable = Join-Path $PackageDirectory 'ULTRON ai.exe'
$ResourcesRoot = Join-Path $PackageDirectory 'resources'
$AppAsar = Join-Path $ResourcesRoot 'app.asar'
$PackagedBackend = Join-Path $ResourcesRoot 'backend\ultron-backend.exe'
$PackagedFrontend = Join-Path $ResourcesRoot 'frontend'
$PackagedIndex = Join-Path $PackagedFrontend 'index.html'
$AsarTool = Join-Path $DesktopRoot 'node_modules\.bin\asar.cmd'

Assert-File -Path $AppExecutable -Description 'ULTRON executable'
Assert-File -Path $AppAsar -Description 'Electron application archive'
Assert-File -Path $PackagedBackend -Description 'Bundled local backend'
Assert-File -Path $PackagedIndex -Description 'Packaged frontend entry point'
Assert-File -Path $AsarTool -Description 'asar verification tool'

$AsarContents = & $AsarTool list $AppAsar | Out-String
if ($LASTEXITCODE -ne 0) {
    throw "Could not inspect $AppAsar."
}
$AsarEntries = @(
    $AsarContents -split "`r?`n" | ForEach-Object {
        # The asar command can report either root-relative or plain paths.
        # Normalize both forms before checking the archive contract.
        $entry = $_.Trim().Replace('\', '/') -replace '^/+', ''
        if ($entry) {
            $entry = "/$entry"
        }
        $entry
    } | Where-Object { $_ }
)
foreach ($RequiredEntry in @('/main.cjs', '/preload.cjs', '/package.json')) {
    if ($AsarEntries -notcontains $RequiredEntry) {
        throw "The application archive is missing required desktop file: $RequiredEntry"
    }
}
$NormalizedAsarContents = $AsarEntries -join "`n"
if ($NormalizedAsarContents -match '(?i)(?:backup|before-|\.env(?:$|/)|\.db(?:$|/)|auth\.secret|node_modules|resources|assets|release(?:$|/)|forge\.config|ultron\.png)') {
    throw 'The Windows app archive contains an excluded development or private artifact.'
}

$ForbiddenResource = Get-ChildItem -LiteralPath $ResourcesRoot -File -Recurse | Where-Object {
    $_.Name -match '^(?:\.env(?:\..*)?|.*\.(?:db|sqlite|sqlite3)(?:-.*)?|auth\.secret|backend\.log)$'
} | Select-Object -First 1
if ($null -ne $ForbiddenResource) {
    throw "The package contains private runtime data: $($ForbiddenResource.FullName)"
}

$FrontendSource = Join-Path $ProjectRoot 'frontend\dist'
if (-not (Test-Path -LiteralPath $FrontendSource -PathType Container)) {
    throw "Current frontend build is missing at $FrontendSource."
}

$SourceFiles = @(Relative-FileRecords -Root $FrontendSource)
$PackagedFiles = @(Relative-FileRecords -Root $PackagedFrontend)
if ($SourceFiles.Count -ne $PackagedFiles.Count) {
    throw 'Packaged frontend file count does not match the current frontend build.'
}
foreach ($SourceFile in $SourceFiles) {
    $PackagedFile = Join-Path $PackagedFrontend $SourceFile.Relative
    Assert-File -Path $PackagedFile -Description "Packaged frontend file $($SourceFile.Relative)"
    $SourceHash = (Get-FileHash -LiteralPath $SourceFile.FullName -Algorithm SHA256).Hash
    $PackagedHash = (Get-FileHash -LiteralPath $PackagedFile -Algorithm SHA256).Hash
    if ($SourceHash -ne $PackagedHash) {
        throw "Packaged frontend file differs from the current build: $($SourceFile.Relative)"
    }
}

$PersonalPathPattern = '(?i)(?:/Users/|/home/|C:\\Users\\)'
$PersonalReference = Get-ChildItem -LiteralPath $PackagedFrontend -File -Recurse | Select-String -Pattern $PersonalPathPattern -List -ErrorAction SilentlyContinue | Select-Object -First 1
if ($null -ne $PersonalReference) {
    throw "A personal path was found in packaged frontend resources: $($PersonalReference.Path)"
}

$Version = (& node -e "process.stdout.write(require(process.argv[1]).version)" (Join-Path $DesktopRoot 'package.json')).Trim()
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($Version)) {
    throw 'Could not read the expected desktop package version.'
}

$ExecutableMetadata = (Get-Item -LiteralPath $AppExecutable).VersionInfo
if ($ExecutableMetadata.ProductName -and $ExecutableMetadata.ProductName -ne 'ULTRON ai') {
    throw "Unexpected Windows ProductName: $($ExecutableMetadata.ProductName)"
}
if ($ExecutableMetadata.ProductVersion -and -not $ExecutableMetadata.ProductVersion.StartsWith($Version)) {
    throw "Unexpected Windows ProductVersion: $($ExecutableMetadata.ProductVersion)"
}

$Executables = @($AppExecutable, $PackagedBackend)
foreach ($Executable in $Executables) {
    $Signature = Get-AuthenticodeSignature -FilePath $Executable
    if ($RequireSignature -and $Signature.Status -ne 'Valid') {
        throw "Expected a valid Authenticode signature for $Executable, found $($Signature.Status)."
    }
    Write-Host "Signature $($Signature.Status): $Executable"
}

Write-Host "ULTRON Windows package verified: io.ultronai.desktop ($Version)"
