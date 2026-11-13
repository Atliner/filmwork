$ErrorActionPreference = 'Stop'
# Official mpv release, pinned to an immutable version and verified before use.
$version = 'v0.41.0'
$archive = 'mpv-v0.41.0-x86_64-pc-windows-msvc.zip'
$sha256 = '4e197f729f5071c6772f35fffd96e0f36e3e8a044bd9479b136bb09b7c6a80ff'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$destination = Join-Path $here 'src-tauri/resources/mpv'
$temp = Join-Path ([System.IO.Path]::GetTempPath()) ('vizosten-mpv-' + [guid]::NewGuid().ToString())
New-Item -ItemType Directory -Force $temp | Out-Null
try {
  $zip = Join-Path $temp $archive
  Invoke-WebRequest -Uri "https://github.com/mpv-player/mpv/releases/download/$version/$archive" -OutFile $zip
  if ((Get-FileHash -Algorithm SHA256 $zip).Hash.ToLowerInvariant() -ne $sha256) { throw 'mpv archive checksum does not match.' }
  $unpacked = Join-Path $temp 'unpacked'
  Expand-Archive -Path $zip -DestinationPath $unpacked
  $exe = @(Get-ChildItem $unpacked -Filter mpv.exe -Recurse -File)
  if ($exe.Count -ne 1) { throw 'Expected exactly one mpv.exe in the official archive.' }
  New-Item -ItemType Directory -Force $destination | Out-Null
  Copy-Item -Path (Join-Path $exe[0].DirectoryName '*') -Destination $destination -Recurse -Force
  if (!(Test-Path (Join-Path $destination 'mpv.exe'))) { throw 'mpv.exe missing from bundle.' }
  # This notice and license accompany the unmodified GPL mpv executable.
  Copy-Item (Join-Path $here 'MPV-LICENSE.GPL') (Join-Path $destination 'LICENSE.GPL') -Force
  Copy-Item (Join-Path $here 'MPV-NOTICE.txt') (Join-Path $destination 'VIZOSTEN-MPV-NOTICE.txt') -Force
} finally {
  Remove-Item $temp -Recurse -Force -ErrorAction SilentlyContinue
}
