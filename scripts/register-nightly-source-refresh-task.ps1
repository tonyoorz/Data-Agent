param(
  [string]$TaskName = "VizionLab Nightly Source Refresh",
  [string]$StartTime = "01:00",
  [string]$RunScriptPath = (Join-Path $PSScriptRoot "run-nightly-source-refresh.ps1"),
  [string]$RunAsUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name,
  [switch]$InteractiveOnly
)

$ErrorActionPreference = "Stop"

$resolvedRunScriptPath = (Resolve-Path $RunScriptPath).Path
$taskCommand = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "{0}"' -f $resolvedRunScriptPath

$schtasksArguments = @(
  "/Create",
  "/SC",
  "DAILY",
  "/ST",
  $StartTime,
  "/TN",
  $TaskName,
  "/TR",
  $taskCommand,
  "/F"
)

if ($InteractiveOnly) {
  $schtasksArguments += "/IT"
}
else {
  Write-Host "Task Scheduler will prompt for the Windows password of '$RunAsUser'."
  Write-Host "Type it directly in the terminal so the task can run whether you are logged on or not."
  $schtasksArguments += @(
    "/RU",
    $RunAsUser,
    "/RP",
    "*"
  )
}

$previousErrorActionPreference = $ErrorActionPreference
$ErrorActionPreference = "Continue"
try {
  $output = & schtasks.exe @schtasksArguments 2>&1
  $exitCode = $LASTEXITCODE
}
finally {
  $ErrorActionPreference = $previousErrorActionPreference
}

if ($exitCode -ne 0) {
  throw ($output | Out-String)
}

$output | Out-String | Write-Host
if ($InteractiveOnly) {
  Write-Host "Registered scheduled task '$TaskName' in interactive-only mode to run daily at $StartTime."
}
else {
  Write-Host "Registered scheduled task '$TaskName' to run daily at $StartTime whether you are logged on or not."
}