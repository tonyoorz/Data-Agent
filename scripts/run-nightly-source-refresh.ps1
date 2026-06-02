param(
  [string]$PythonLauncher = "py",
  [string]$PythonVersion = "-3.11",
  [string]$Teams = "DTSV_China,[AT]CoC_EI_IuK,Plant-Tiexi FIT,[AT]FIT_LAENDER_CHINA,Plant-Dadong FIT,[AT]BBA_Basis-FIT,Spotlight_FIT",
  [string]$Years = "2025,2026",
  [string]$TeamName = "DTSV_China",
  [int]$HistoryMaxWorkers = 50,
  [string]$LogPath = ""
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

if ([string]::IsNullOrWhiteSpace($LogPath)) {
  $logDirectory = Join-Path $repoRoot "database\hot\logs"
  if (-not (Test-Path $logDirectory)) {
    New-Item -ItemType Directory -Path $logDirectory | Out-Null
  }
  $LogPath = Join-Path $logDirectory "nightly-source-refresh.log"
}

$startedAt = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
"[$startedAt] Starting refresh-all-sources" | Out-File -FilePath $LogPath -Append -Encoding utf8

$arguments = @(
  $PythonVersion,
  "-m",
  "backend.analytics_cli",
  "refresh-all-sources",
  "--teams",
  $Teams,
  "--years",
  $Years,
  "--team-name",
  $TeamName,
  "--history-max-workers",
  $HistoryMaxWorkers.ToString()
)

$temporaryCmdPath = Join-Path $env:TEMP ("vizion-lab-nightly-refresh-" + [guid]::NewGuid().ToString() + ".cmd")

@(
  "@echo off",
  'cd /d "' + $repoRoot + '"',
  '"' + $PythonLauncher + '" ' + ($arguments -join " ")
) | Set-Content -Path $temporaryCmdPath -Encoding ascii

$previousErrorActionPreference = $ErrorActionPreference
$ErrorActionPreference = "Continue"
try {
  cmd.exe /d /c "`"$temporaryCmdPath`" 2^>^&1" | Tee-Object -FilePath $LogPath -Append
}
finally {
  Remove-Item $temporaryCmdPath -ErrorAction SilentlyContinue
  $ErrorActionPreference = $previousErrorActionPreference
}

$exitCode = if ($null -ne $LASTEXITCODE) { [int]$LASTEXITCODE } else { 0 }
$finishedAt = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
"[$finishedAt] Finished refresh-all-sources exit_code=$exitCode" | Out-File -FilePath $LogPath -Append -Encoding utf8

exit $exitCode