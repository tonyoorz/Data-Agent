param(
  [string]$PythonExecutable = "",
  [string]$Teams = "DTSV_China,[AT]CoC_EI_IuK,Plant-Tiexi FIT,[AT]FIT_LAENDER_CHINA,Plant-Dadong FIT,[AT]BBA_Basis-FIT,Spotlight_FIT",
  [string]$Years = "2025,2026",
  [string]$ManualRunYears = "",
  [string]$TeamName = "DTSV_China",
  [int]$HistoryMaxWorkers = 8,
  [int]$TeamMaxWorkers = 2,
  [int]$ForceDefectRefresh = 0,
  [ValidateSet("include", "skip")]
  [string]$CommentMode = "include",
  [int]$IncludeComments = 0,
  [int]$PrepareDuplicateIndex = 1,
  [string]$LogPath = "",
  [bool]$AutoRefreshCookieOnAuthFailure = $true,
  [bool]$CookieRefreshHeadless = $false
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

if ([string]::IsNullOrWhiteSpace($PythonExecutable)) {
  $PythonExecutable = Join-Path $repoRoot ".venv\Scripts\python.exe"
}
if (-not [System.IO.Path]::IsPathRooted($PythonExecutable)) {
  throw "PYTHON_RUNTIME_OVERRIDE_INVALID"
}
if (-not (Test-Path -LiteralPath $PythonExecutable -PathType Leaf)) {
  throw "PYTHON_RUNTIME_NOT_CONFIGURED"
}
$PythonExecutable = (Resolve-Path -LiteralPath $PythonExecutable).Path

# The scheduled ingest process receives Octane/data refresh settings, not Agent,
# model, ASR/OCR, or browser-public configuration from the parent service.
$blockedEnvironmentPrefixes = @(
  "DUPSEARCH_CHAT_",
  "DUPSEARCH_OCR_",
  "DUPSEARCH_TRANSCRIBE_",
  "VITE_",
  "VIZION_AGENT_",
  "VIZION_INTERNAL_",
  "VIZION_OIDC_"
)
Get-ChildItem Env: | ForEach-Object {
  $environmentName = $_.Name
  if ($blockedEnvironmentPrefixes | Where-Object { $environmentName.StartsWith($_, [System.StringComparison]::OrdinalIgnoreCase) }) {
    Remove-Item ("Env:" + $environmentName) -ErrorAction SilentlyContinue
  }
}

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

if ([string]::IsNullOrWhiteSpace($ManualRunYears)) {
  $ManualRunYears = $Years
}

$effectiveSkipComments = $CommentMode -eq "skip"
if ($IncludeComments) {
  $effectiveSkipComments = $false
}

$startedAt = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
Write-LogLine -Message "[$startedAt] Starting refresh-all-sources"
Write-LogLine -Message ("[$startedAt] Log file: " + $LogPath)
Write-LogLine -Message ("[$startedAt] Runtime config teams=" + $Teams + " years=" + $Years + " manual_years=" + $ManualRunYears + " team_name=" + $TeamName + " history_max_workers=" + $HistoryMaxWorkers + " team_max_workers=" + $TeamMaxWorkers + " force_defect_refresh=" + [bool]$ForceDefectRefresh + " skip_comments=" + $effectiveSkipComments + " prepare_duplicate_index=" + [bool]$PrepareDuplicateIndex + " auto_refresh_cookie_on_auth_failure=" + $AutoRefreshCookieOnAuthFailure + " cookie_refresh_headless=" + $CookieRefreshHeadless)

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
  $previousPythonNoUserSite = $env:PYTHONNOUSERSITE
  $previousPythonHome = $env:PYTHONHOME
  $previousPythonPath = $env:PYTHONPATH
  $previousPythonStartup = $env:PYTHONSTARTUP
  $previousPythonInspect = $env:PYTHONINSPECT
  $previousHttpProxy = $env:HTTP_PROXY
  $previousHttpsProxy = $env:HTTPS_PROXY
  $previousLowerHttpProxy = $env:http_proxy
  $previousLowerHttpsProxy = $env:https_proxy
  $previousErrorActionPreference = $ErrorActionPreference
  $outputLines = New-Object 'System.Collections.Generic.List[string]'

  $env:PYTHONUTF8 = "1"
  $env:PYTHONIOENCODING = "utf-8"
  $env:PYTHONNOUSERSITE = "1"
  Remove-Item Env:PYTHONHOME -ErrorAction SilentlyContinue
  Remove-Item Env:PYTHONPATH -ErrorAction SilentlyContinue
  Remove-Item Env:PYTHONSTARTUP -ErrorAction SilentlyContinue
  Remove-Item Env:PYTHONINSPECT -ErrorAction SilentlyContinue
  Remove-Item Env:HTTP_PROXY -ErrorAction SilentlyContinue
  Remove-Item Env:HTTPS_PROXY -ErrorAction SilentlyContinue
  Remove-Item Env:http_proxy -ErrorAction SilentlyContinue
  Remove-Item Env:https_proxy -ErrorAction SilentlyContinue
  $ErrorActionPreference = "Continue"
  try {
    $started = Get-Date
    Write-LogLine -Message ("[" + ($started.ToString("yyyy-MM-dd HH:mm:ss")) + "] Running " + $CommandId + ": " + ($PythonExecutable + " " + (($CliArguments | ForEach-Object { Format-CmdArgument $_ }) -join " ")))
    try {
      & $PythonExecutable @CliArguments 2>&1 | ForEach-Object {
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
    }
    catch {
      $commandExitCode = 1
      $line = $_.Exception.Message
      if ([string]::IsNullOrWhiteSpace($line)) {
        $line = $_.ToString()
      }

      if (-not [string]::IsNullOrWhiteSpace($line)) {
        $outputLines.Add($line)
        Write-LogLine -Message $line
      }
    }

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

    if ($null -eq $previousPythonNoUserSite) { Remove-Item Env:PYTHONNOUSERSITE -ErrorAction SilentlyContinue } else { $env:PYTHONNOUSERSITE = $previousPythonNoUserSite }
    if ($null -eq $previousPythonHome) { Remove-Item Env:PYTHONHOME -ErrorAction SilentlyContinue } else { $env:PYTHONHOME = $previousPythonHome }
    if ($null -eq $previousPythonPath) { Remove-Item Env:PYTHONPATH -ErrorAction SilentlyContinue } else { $env:PYTHONPATH = $previousPythonPath }
    if ($null -eq $previousPythonStartup) { Remove-Item Env:PYTHONSTARTUP -ErrorAction SilentlyContinue } else { $env:PYTHONSTARTUP = $previousPythonStartup }
    if ($null -eq $previousPythonInspect) { Remove-Item Env:PYTHONINSPECT -ErrorAction SilentlyContinue } else { $env:PYTHONINSPECT = $previousPythonInspect }

    if ($null -eq $previousHttpProxy) { Remove-Item Env:HTTP_PROXY -ErrorAction SilentlyContinue } else { $env:HTTP_PROXY = $previousHttpProxy }
    if ($null -eq $previousHttpsProxy) { Remove-Item Env:HTTPS_PROXY -ErrorAction SilentlyContinue } else { $env:HTTPS_PROXY = $previousHttpsProxy }
    if ($null -eq $previousLowerHttpProxy) { Remove-Item Env:http_proxy -ErrorAction SilentlyContinue } else { $env:http_proxy = $previousLowerHttpProxy }
    if ($null -eq $previousLowerHttpsProxy) { Remove-Item Env:https_proxy -ErrorAction SilentlyContinue } else { $env:https_proxy = $previousLowerHttpsProxy }
  }

  return @{
    ExitCode = $commandExitCode
    OutputLines = $outputLines.ToArray()
  }
}

$preflightResult = Invoke-AnalyticsCli -CliArguments @(
  "-c",
  "import sys; assert sys.version_info[:2] == (3, 12); import backend.analytics_cli"
) -CommandId "python-preflight"
if ($preflightResult.ExitCode -ne 0) {
  exit $preflightResult.ExitCode
}

function Test-AuthFailure {
  param([string[]]$OutputLines)

  if ($null -eq $OutputLines -or $OutputLines.Count -eq 0) {
    return $false
  }

  $localizedAuthFailure = [string]::Concat([char]0x8BA4, [char]0x8BC1, [char]0x6D4B, [char]0x8BD5, [char]0x5931, [char]0x8D25)
  $outputText = ($OutputLines -join "`n")
  return ($outputText -match "401") -or ($outputText -match "Failed to authenticate legacy Octane session") -or ($outputText -match [regex]::Escape($localizedAuthFailure))
}

$refreshArguments = @(
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
  $HistoryMaxWorkers.ToString(),
  "--team-max-workers",
  $TeamMaxWorkers.ToString()
)

if ($effectiveSkipComments) {
  $refreshArguments += "--skip-comments"
}

if ($PrepareDuplicateIndex) {
  $refreshArguments += "--prepare-duplicate-index"
}

if ($ForceDefectRefresh) {
  $refreshArguments += "--force-defect-refresh"
}

$refreshResult = Invoke-AnalyticsCli -CliArguments $refreshArguments -CommandId "nightly-refresh"

if ($refreshResult.ExitCode -ne 0 -and $AutoRefreshCookieOnAuthFailure -and (Test-AuthFailure -OutputLines $refreshResult.OutputLines)) {
  $retryAt = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  Write-LogLine -Message "[$retryAt] Detected auth failure, refreshing Octane cookie and retrying refresh-all-sources once"

  $cookieArguments = @(
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
