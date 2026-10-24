param(
  [switch]$SetupOnly,
  [switch]$Watch,
  [switch]$NoDiagnosticZip,
  [switch]$NoPause
)
$ErrorActionPreference = 'Stop'
$script:Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$script:LogDir = Join-Path $env:TEMP ("GB2L-Inbox-Helper-" + $script:Stamp + '-' + $PID)
$script:LogPath = Join-Path $script:LogDir 'run.log'
$script:MetaPath = Join-Path $script:LogDir 'diagnostics.txt'
$script:Result = 'started'
$script:FailureCode = ''
$script:ExitCode = 0
New-Item -ItemType Directory -Path $script:LogDir -Force | Out-Null

function Write-LocalLog([string]$Message) {
  $line = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-ddTHH:mm:ss.fffK'), $Message
  Add-Content -LiteralPath $script:LogPath -Value $line -Encoding UTF8
}
function Stop-Safely([string]$Code, [string]$Message) {
  $script:FailureCode = $Code
  $script:Result = 'failed'
  $script:ExitCode = 1
  Write-LocalLog ("FAIL code=" + $Code)
  throw $Message
}

$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$localSetup = Join-Path $repoRoot 'tools\gb2l-email\inbox-local-setup.mjs'
$localRead = Join-Path $repoRoot 'tools\gb2l-email\inbox-local-read.mjs'
$privateKey = Join-Path $env:USERPROFILE 'gb2l.inbox.private.pem'
$oauthStore = Join-Path $env:LOCALAPPDATA 'GitBack2Life\inbox-oauth.json'

try {
  Write-LocalLog 'Inbox helper started. Raw terminal output is not copied into the ZIP.'
  Set-Content -LiteralPath $script:MetaPath -Encoding UTF8 -Value @(
    'GitBack2Life Inbox Diagnostic Bundle'
    ('Time: ' + (Get-Date -Format 'yyyy-MM-ddTHH:mm:ssK'))
    ('PowerShell: ' + $PSVersionTable.PSVersion.ToString())
    ('Windows: ' + [System.Environment]::OSVersion.Version.ToString())
    'Computer name: omitted'
    'Windows account name: omitted'
    'Private keys, OAuth JSON, tokens, sender filters, email contents, and raw child-process output are not collected.'
  )
  if (Get-Command node -ErrorAction SilentlyContinue) {
    Add-Content -LiteralPath $script:MetaPath -Encoding UTF8 -Value ('Node: ' + ((& node --version 2>&1) -join ' '))
  } else {
    Add-Content -LiteralPath $script:MetaPath -Encoding UTF8 -Value 'Node: unavailable'
  }
  $repoDisplay = $repoRoot
  if ($env:USERPROFILE) { $repoDisplay = $repoDisplay.Replace($env:USERPROFILE, '%USERPROFILE%') }
  Add-Content -LiteralPath $script:MetaPath -Encoding UTF8 -Value ('Repository: ' + $repoDisplay)

  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Stop-Safely 'NODE_NOT_INSTALLED' 'Node.js is not installed or is not on PATH. Install Node.js, then run this script again.'
  }
  if (-not (Test-Path $privateKey)) {
    Stop-Safely 'LOCAL_INBOX_PRIVATE_KEY_MISSING' 'Your private inbox key was not found at %USERPROFILE%\gb2l.inbox.private.pem. Do not upload or share it.'
  }
  if (-not (Test-Path $oauthStore)) {
    Add-Type -AssemblyName System.Windows.Forms
    $dialog = New-Object System.Windows.Forms.OpenFileDialog
    $dialog.Title = 'Select the Google Desktop OAuth client JSON file'
    $dialog.Filter = 'Google OAuth client JSON (*.json)|*.json'
    $dialog.Multiselect = $false
    if ($dialog.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) {
      $script:Result = 'cancelled'
      $script:FailureCode = 'OAUTH_FILE_PICKER_CANCELLED'
      Write-LocalLog 'OAuth file picker cancelled. No Gmail messages were read.'
      throw 'Setup cancelled. No Gmail messages were read.'
    }
    Write-LocalLog 'Local read-only OAuth setup started. Selected filename is intentionally not recorded.'
    & node $localSetup --credentials $dialog.FileName --private-key $privateKey
    $setupCode = $LASTEXITCODE
    Write-LocalLog ('Local OAuth setup process exit_code=' + $setupCode)
    if ($setupCode -ne 0) { Stop-Safely 'LOCAL_OAUTH_SETUP_FAILED' 'Local Gmail authorization did not complete. No messages were read.' }
    if ($SetupOnly) {
      $script:Result = 'setup_complete'
      Write-Host 'Local read-only authorization is complete. Inbox remains inactive until you request a read.'
      return
    }
  } else {
    Write-LocalLog 'Existing local OAuth file detected; its contents and path are not collected.'
  }

  Write-LocalLog 'Owner-local inbox request reader started.'
  $readerArgs = @('--private-key', $privateKey)
  if ($Watch) {
    $readerArgs += '--watch'
    Write-LocalLog 'Inbox watch mode enabled. Raw message content is never written to the helper log.'
  }
  & node $localRead @readerArgs
  $readCode = $LASTEXITCODE
  Write-LocalLog ('Local inbox reader process exit_code=' + $readCode)
  if ($readCode -ne 0) { Stop-Safely 'LOCAL_INBOX_READER_FAILED' 'Inbox processing stopped. See the safe error code in the terminal.' }
  $script:Result = 'completed'
}
catch {
  if ($script:Result -eq 'started') {
    $script:Result = 'failed'
    $script:ExitCode = 1
    if (-not $script:FailureCode) { $script:FailureCode = 'UNEXPECTED_LOCAL_HELPER_ERROR' }
    Write-LocalLog ('Caught error category=' + $script:FailureCode)
  }
  Write-Host ''
  Write-Host ('GitBack2Life inbox: ' + $_.Exception.Message) -ForegroundColor Yellow
}
finally {
  Write-LocalLog ('Final result=' + $script:Result)
  if ($script:FailureCode) { Write-LocalLog ('Failure code=' + $script:FailureCode) }
  if (-not $NoDiagnosticZip) {
    try {
      $desktop = Join-Path $env:USERPROFILE 'Desktop'
      if (-not (Test-Path $desktop)) { $desktop = $env:USERPROFILE }
      $zipPath = Join-Path $desktop ('GitBack2Life-Inbox-Log-' + $script:Stamp + '.zip')
      Write-LocalLog ('Diagnostic ZIP path=' + $zipPath)
      Compress-Archive -LiteralPath @($script:LogPath, $script:MetaPath) -DestinationPath $zipPath -Force
      Write-Host ''
      Write-Host ('Diagnostic ZIP created: ' + $zipPath) -ForegroundColor Green
      Write-Host 'It excludes email contents, sender filters, private keys, OAuth files, tokens, and raw child-process output.'
    } catch {
      Write-Host ('Could not create the diagnostic ZIP: ' + $_.Exception.Message) -ForegroundColor Yellow
      if ($script:ExitCode -eq 0) { $script:ExitCode = 1 }
    }
  }
  if (-not $NoPause) {
    Write-Host ''
    Write-Host 'Press any key to close this window...' -ForegroundColor Cyan
    try { [void][Console]::ReadKey($true) }
    catch { Read-Host 'Press Enter to close this window' | Out-Null }
  }
}
if ($script:ExitCode -ne 0) { exit $script:ExitCode }
