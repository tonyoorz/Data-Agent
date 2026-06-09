param(
  [string]$PythonLauncher = "py",
  [string]$PythonVersion = "-3.11",
  [string]$Teams = "DTSV_China,[AT]CoC_EI_IuK,Plant-Tiexi FIT,[AT]FIT_LAENDER_CHINA,Plant-Dadong FIT,[AT]BBA_Basis-FIT,Spotlight_FIT",
  [string]$Years = "2025,2026",
  [string]$ManualRunYears = "",
  [string]$TeamName = "DTSV_China",
  [int]$HistoryMaxWorkers = 50,
  [switch]$SkipComments,
  [string]$LogPath = "",
  [bool]$AutoRefreshCookieOnAuthFailure = $true,
  [bool]$CookieRefreshHeadless = $true
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

$latestLogPath = $null
$logEncoding = New-Object System.Text.UTF8Encoding($false)
$logWriteWarningShown = $false

if ([string]::IsNullOrWhiteSpace($LogPath)) {
  $logDirectory = Join-Path $repoRoot "database\hot\logs"
  if (-not (Test-Path $logDirectory)) {
    New-Item -ItemType Directory -Path $logDirectory | Out-Null
  }
  $timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $LogPath = Join-Path $logDirectory ("nightly-source-refresh-" + $timestamp + ".log")
  $latestLogPath = Join-Path $logDirectory "nightly-source-refresh.log"
}

function Write-LogLine {
  param(
    [string]$Message,
    [switch]$NoConsole
  )

  $lineText = $Message + [Environment]::NewLine

  foreach ($targetPath in @($LogPath, $latestLogPath)) {
    if ([string]::IsNullOrWhiteSpace($targetPath)) {
      continue
    }

    try {
      [System.IO.File]::AppendAllText($targetPath, $lineText, $logEncoding)
    }
    catch {
      if (-not $logWriteWarningShown) {
        $logWriteWarningShown = $true
        Write-Warning ("Failed to append nightly refresh log to " + $targetPath + ": " + $_.Exception.Message)
      }
    }
  }

  if (-not $NoConsole) {
    Write-Host $Message
  }
}

$startedAt = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
Write-LogLine -Message "[$startedAt] Starting refresh-all-sources"
Write-LogLine -Message ("[$startedAt] Log file: " + $LogPath)
Write-LogLine -Message ("[$startedAt] Runtime config teams=" + $Teams + " years=" + $Years + " manual_years=" + $ManualRunYears + " team_name=" + $TeamName + " history_max_workers=" + $HistoryMaxWorkers + " skip_comments=" + $SkipComments + " auto_refresh_cookie_on_auth_failure=" + $AutoRefreshCookieOnAuthFailure + " cookie_refresh_headless=" + $CookieRefreshHeadless)

if ([string]::IsNullOrWhiteSpace($ManualRunYears)) {
  $ManualRunYears = (Get-Date).Year.ToString()
}

function Format-CmdArgument {
  param([string]$Value)

  if ($null -eq $Value -or $Value.Length -eq 0) {
    return '""'
  }

  if ($Value -notmatch '[\s"&|<>^()]') {
    return $Value
  }

  return '"' + ($Value -replace '"', '""') + '"'
}

function Invoke-AnalyticsCli {
  param(
    [string[]]$CliArguments,
    [string]$CommandId
  )

  $previousPythonUtf8 = $env:PYTHONUTF8
  $previousPythonIoEncoding = $env:PYTHONIOENCODING
  $previousErrorActionPreference = $ErrorActionPreference
  $outputLines = New-Object 'System.Collections.Generic.List[string]'

  $env:PYTHONUTF8 = "1"
  $env:PYTHONIOENCODING = "utf-8"
  $ErrorActionPreference = "Continue"
  try {
    $started = Get-Date
    Write-LogLine -Message ("[" + ($started.ToString("yyyy-MM-dd HH:mm:ss")) + "] Running " + $CommandId + ": " + ($PythonLauncher + " " + (($CliArguments | ForEach-Object { Format-CmdArgument $_ }) -join " ")))
    & $PythonLauncher @CliArguments 2>&1 | ForEach-Object {
      if ($_ -is [System.Management.Automation.ErrorRecord]) {
        $line = $_.Exception.Message
      }
      else {
        $line = $_.ToString()
      }

      if (-not [string]::IsNullOrWhiteSpace($line)) {
        $outputLines.Add($line)
        # Keep operator visibility: show progress in terminal and append to log simultaneously.
        Write-LogLine -Message $line
      }
    }

    $commandExitCode = if ($null -ne $LASTEXITCODE) { [int]$LASTEXITCODE } else { 0 }
    $finished = Get-Date
    $durationSeconds = [Math]::Round((New-TimeSpan -Start $started -End $finished).TotalSeconds, 1)
    Write-LogLine -Message ("[" + ($finished.ToString("yyyy-MM-dd HH:mm:ss")) + "] Completed " + $CommandId + " exit_code=" + $commandExitCode + " duration_seconds=" + $durationSeconds)
  }
  finally {
    $ErrorActionPreference = $previousErrorActionPreference

    if ($null -eq $previousPythonUtf8) {
      Remove-Item Env:PYTHONUTF8 -ErrorAction SilentlyContinue
    }
    else {
      $env:PYTHONUTF8 = $previousPythonUtf8
    }

    if ($null -eq $previousPythonIoEncoding) {
      Remove-Item Env:PYTHONIOENCODING -ErrorAction SilentlyContinue
    }
    else {
      $env:PYTHONIOENCODING = $previousPythonIoEncoding
    }
  }

  return @{
    ExitCode = $commandExitCode
    OutputLines = $outputLines.ToArray()
  }
}

function Test-AuthFailure {
  param([string[]]$OutputLines)

  if ($null -eq $OutputLines -or $OutputLines.Count -eq 0) {
    return $false
  }

  $outputText = ($OutputLines -join "`n")
  return ($outputText -match "401") -or ($outputText -match "Failed to authenticate legacy Octane session") -or ($outputText -match "认证测试失败")
}

$refreshArguments = @(
  $PythonVersion,
  "-m",
  "backend.analytics_cli",
  "refresh-all-sources",
  "--teams",
  $Teams,
  "--years",
  $Years,
  "--manual-years",
  $ManualRunYears,
  "--team-name",
  $TeamName,
  "--history-max-workers",
  $HistoryMaxWorkers.ToString()
)

if ($SkipComments) {
  $refreshArguments += "--skip-comments"
}

$refreshResult = Invoke-AnalyticsCli -CliArguments $refreshArguments -CommandId "nightly-refresh"

if ($refreshResult.ExitCode -ne 0 -and $AutoRefreshCookieOnAuthFailure -and (Test-AuthFailure -OutputLines $refreshResult.OutputLines)) {
  $retryAt = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  Write-LogLine -Message "[$retryAt] Detected auth failure, refreshing Octane cookie and retrying refresh-all-sources once"

  $cookieArguments = @(
    $PythonVersion,
    "-m",
    "backend.analytics_cli",
    "refresh-octane-cookie"
  )
  if ($CookieRefreshHeadless) {
    $cookieArguments += "--headless"
  }

  $cookieResult = Invoke-AnalyticsCli -CliArguments $cookieArguments -CommandId "refresh-cookie"
  if ($cookieResult.ExitCode -eq 0) {
    $refreshResult = Invoke-AnalyticsCli -CliArguments $refreshArguments -CommandId "nightly-refresh-retry"
  }
  else {
    $cookieFailAt = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Write-LogLine -Message "[$cookieFailAt] Cookie refresh failed, skipping retry"
    $refreshResult = $cookieResult
  }
}

$exitCode = $refreshResult.ExitCode
$finishedAt = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
Write-LogLine -Message "[$finishedAt] Finished refresh-all-sources exit_code=$exitCode"

exit $exitCode