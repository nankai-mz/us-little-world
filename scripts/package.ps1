$ErrorActionPreference = 'Stop'
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$package = Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw | ConvertFrom-Json
$version = $package.version
if ($version -notmatch '^\d+\.\d+\.\d+(-[a-zA-Z0-9.-]+)?$') { throw 'Invalid release version' }
$readiness = Get-Content -LiteralPath (Join-Path $projectRoot 'docs/release-readiness.json') -Raw | ConvertFrom-Json
if (-not $readiness.localBuildReady -or $readiness.version -ne $version) { throw 'Run npm run release to produce a passing local readiness report first' }
foreach ($item in $readiness.outputSha256.PSObject.Properties) {
  $actual = (Get-FileHash -LiteralPath (Join-Path $projectRoot $item.Name) -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $item.Value) { throw "Build output changed after preflight: $($item.Name)" }
}
$releaseDirectory = Join-Path $projectRoot 'release'
New-Item -ItemType Directory -Path $releaseDirectory -Force | Out-Null
$archivePath = Join-Path $releaseDirectory "Us-little-world-$version.zip"
if (Test-Path -LiteralPath $archivePath) { $archivePath = Join-Path $releaseDirectory ("Us-little-world-$version-{0}.zip" -f (Get-Date -Format 'yyyyMMdd-HHmmss')) }
Add-Type -AssemblyName System.IO.Compression
$stream = [System.IO.File]::Open($archivePath, [System.IO.FileMode]::CreateNew)
$zip = [System.IO.Compression.ZipArchive]::new($stream, [System.IO.Compression.ZipArchiveMode]::Create)
$count = 0
try {
  foreach ($path in [System.IO.Directory]::EnumerateFiles($projectRoot, '*', [System.IO.SearchOption]::AllDirectories)) {
    $relative = [System.IO.Path]::GetRelativePath($projectRoot, $path).Replace('\', '/')
    if ($relative -match '(^|/)(node_modules|\.git|artifacts|release|coverage)/' -or $relative -match '(^|/)\.env' -or $relative -match '(^|/)project\.private\.config\.json$' -or $relative -match '(\.local\.json|\.log|\.tmp)$') { continue }
    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $path, $relative, [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
    $count++
  }
} finally { $zip.Dispose(); $stream.Dispose() }
$archiveHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
[System.IO.File]::WriteAllText("$archivePath.sha256", "$archiveHash  $([System.IO.Path]::GetFileName($archivePath))`n")
Write-Output "Packaged $count files: $archivePath"
Write-Output "SHA256: $archiveHash"
