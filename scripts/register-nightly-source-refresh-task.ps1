param(
  [string]$TaskName = "VizionLab Nightly Source Refresh",
  [string]$StartTime = "01:00",
  [string]$RunScriptPath = (Join-Path $PSScriptRoot "run-nightly-source-refresh.ps1")
)

$ErrorActionPreference = "Stop"

$resolvedRunScriptPath = (Resolve-Path $RunScriptPath).Path
$taskCommand = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "{0}"' -f $resolvedRunScriptPath

$output = schtasks.exe /Create /SC DAILY /ST $StartTime /TN $TaskName /TR $taskCommand /F 2>&1

if ($LASTEXITCODE -ne 0) {
  throw ($output | Out-String)
}

$output | Out-String | Write-Host
Write-Host "Registered scheduled task '$TaskName' to run daily at $StartTime."