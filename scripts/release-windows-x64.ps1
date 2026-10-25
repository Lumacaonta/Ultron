<#
.SYNOPSIS
Build, verify and archive a native Windows x64 ULTRON release candidate.
#>

[CmdletBinding()]
param(
    [switch]$RequireSignature
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($env:OS -ne 'Windows_NT') {
    throw 'scripts/release-windows-x64.ps1 must run on Windows.'
}

$ScriptDirectory = Split-Path -Parent $PSCommandPath
$ProjectRoot = (Resolve-Path (Join-Path $ScriptDirectory '..')).Path
$DesktopRoot = Join-Path $ProjectRoot 'desktop'
$ReleaseDirectory = if ([string]::IsNullOrWhiteSpace($env:ULTRON_RELEASE_DIR)) {
    Join-Path $DesktopRoot 'release'
} else {
    $env:ULTRON_RELEASE_DIR
}
$PackageDirectory = Join-Path $DesktopRoot 'out\ULTRON ai-win32-x64'

if (Test-Path -LiteralPath $ReleaseDirectory) {
    Remove-Item -LiteralPath $ReleaseDirectory -Recurse -Force
}
New-Item -ItemType Directory -Path $ReleaseDirectory -Force | Out-Null

& (Join-Path $ScriptDirectory 'build-windows.ps1') -Architecture x64 -Make
if ($LASTEXITCODE -ne 0) {
    throw "Windows packaging failed with exit code $LASTEXITCODE."
}

$VerifyArguments = @{ PackageDirectory = $PackageDirectory }
if ($RequireSignature) {
    $VerifyArguments.RequireSignature = $true
}
& (Join-Path $ScriptDirectory 'verify-windows-package.ps1') @VerifyArguments
if ($LASTEXITCODE -ne 0) {
    throw "Windows package verification failed with exit code $LASTEXITCODE."
}

$Version = (& node -e "process.stdout.write(require(process.argv[1]).version)" (Join-Path $DesktopRoot 'package.json')).Trim()
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($Version)) {
    throw 'Could not read the desktop package version.'
}

$SetupSource = Get-ChildItem -LiteralPath (Join-Path $DesktopRoot 'out\make\squirrel.windows\x64') -Filter '*Setup.exe' -File | Select-Object -First 1
$ZipSource = Get-ChildItem -LiteralPath (Join-Path $DesktopRoot 'out\make\zip\win32\x64') -Filter '*.zip' -File | Select-Object -First 1
if ($null -eq $SetupSource) {
    throw 'Squirrel did not create a Windows Setup.exe installer.'
}
if ($null -eq $ZipSource) {
    throw 'Electron Forge did not create a portable Windows ZIP archive.'
}

$SetupArchive = Join-Path $ReleaseDirectory "ULTRON-ai-$Version-windows-x64-Setup.exe"
$ZipArchive = Join-Path $ReleaseDirectory "ULTRON-ai-$Version-windows-x64.zip"
Copy-Item -LiteralPath $SetupSource.FullName -Destination $SetupArchive -Force
Copy-Item -LiteralPath $ZipSource.FullName -Destination $ZipArchive -Force

# Verify that the portable download really contains the same self-contained
# app payload. This does not extract or execute anything from the archive.
Add-Type -AssemblyName System.IO.Compression.FileSystem
$Archive = [System.IO.Compression.ZipFile]::OpenRead($ZipArchive)
try {
    $ArchiveEntries = @($Archive.Entries | ForEach-Object { $_.FullName })
    foreach ($RequiredSuffix in @(
        '/ULTRON ai.exe',
        '/resources/app.asar',
        '/resources/backend/ultron-backend.exe',
        '/resources/frontend/index.html'
    )) {
        if (-not ($ArchiveEntries | Where-Object { $_.EndsWith($RequiredSuffix, [System.StringComparison]::OrdinalIgnoreCase) })) {
            throw "Portable archive is missing required payload: $RequiredSuffix"
        }
    }
}
finally {
    $Archive.Dispose()
}

if ($RequireSignature) {
    foreach ($Artifact in @($SetupArchive, $ZipArchive)) {
        if ($Artifact.EndsWith('.exe')) {
            $Signature = Get-AuthenticodeSignature -FilePath $Artifact
            if ($Signature.Status -ne 'Valid') {
                throw "Expected a valid Authenticode signature for $Artifact, found $($Signature.Status)."
            }
        }
    }
}

$SetupChecksum = "$SetupArchive.sha256"
$ZipChecksum = "$ZipArchive.sha256"
$Manifest = Join-Path $ReleaseDirectory "ULTRON-ai-$Version-windows-x64-SHA256SUMS.txt"
foreach ($Item in @(
    @{ Path = $SetupArchive; Destination = $SetupChecksum },
    @{ Path = $ZipArchive; Destination = $ZipChecksum }
)) {
    $Hash = (Get-FileHash -LiteralPath $Item.Path -Algorithm SHA256).Hash.ToLowerInvariant()
    $Line = "$Hash *$(Split-Path -Leaf $Item.Path)"
    Set-Content -LiteralPath $Item.Destination -Value $Line -Encoding ascii -NoNewline
}
@(
    Get-Content -LiteralPath $SetupChecksum
    Get-Content -LiteralPath $ZipChecksum
) | Set-Content -LiteralPath $Manifest -Encoding ascii

Write-Host "Release installer: $SetupArchive"
Write-Host "Release archive: $ZipArchive"
Write-Host "Checksums: $Manifest"
