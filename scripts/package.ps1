param(
  [string]$OutputDirectory = "dist",
  [string]$ExpectedVersion = ""
)

$ErrorActionPreference = "Stop"

$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$manifestPath = Join-Path $projectRoot "manifest.json"
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$version = [string]$manifest.version

if ($version -notmatch '^\d+\.\d+\.\d+(\.\d+)?$') {
  throw "manifest.json の version がChrome拡張の形式ではありません: $version"
}
if ($ExpectedVersion -and $ExpectedVersion -ne $version) {
  throw "タグのバージョン ($ExpectedVersion) と manifest.json ($version) が一致しません。"
}

if ([System.IO.Path]::IsPathRooted($OutputDirectory)) {
  $outputPath = [System.IO.Path]::GetFullPath($OutputDirectory)
} else {
  $outputPath = [System.IO.Path]::GetFullPath((Join-Path $projectRoot $OutputDirectory))
}
[System.IO.Directory]::CreateDirectory($outputPath) | Out-Null

$packageName = "korochin-pageshot-v$version"
$archivePath = Join-Path $outputPath "$packageName.zip"
$temporaryRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("korochin-pageshot-package-" + [guid]::NewGuid().ToString("N"))
$packageRoot = Join-Path $temporaryRoot $packageName

$packageFiles = @(
  "README.md",
  "manifest.json",
  "background.js",
  "capture.js",
  "clipboard.js",
  "image-analysis.js",
  "offscreen.html",
  "offscreen.js",
  "popup.css",
  "popup.html",
  "popup.js"
)

try {
  [System.IO.Directory]::CreateDirectory($packageRoot) | Out-Null
  foreach ($relativePath in $packageFiles) {
    $sourcePath = Join-Path $projectRoot $relativePath
    if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
      throw "パッケージ対象ファイルが見つかりません: $relativePath"
    }
    Copy-Item -LiteralPath $sourcePath -Destination (Join-Path $packageRoot $relativePath)
  }

  if (Test-Path -LiteralPath $archivePath) {
    Remove-Item -LiteralPath $archivePath -Force
  }
  Compress-Archive -LiteralPath $packageRoot -DestinationPath $archivePath -CompressionLevel Optimal
} finally {
  $resolvedTemporaryRoot = [System.IO.Path]::GetFullPath($temporaryRoot)
  $systemTemporaryRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
  if ($resolvedTemporaryRoot.StartsWith($systemTemporaryRoot, [System.StringComparison]::OrdinalIgnoreCase) -and
      (Split-Path -Leaf $resolvedTemporaryRoot).StartsWith("korochin-pageshot-package-")) {
    Remove-Item -LiteralPath $resolvedTemporaryRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}

Write-Output $archivePath
