param(
  [switch]$SetupOnly
)
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$localSetup = Join-Path $repoRoot 'tools\gb2l-email\inbox-local-setup.mjs'
$localRead = Join-Path $repoRoot 'tools\gb2l-email\inbox-local-read.mjs'
$privateKey = Join-Path $env:USERPROFILE 'gb2l.inbox.private.pem'
$oauthStore = Join-Path $env:LOCALAPPDATA 'GitBack2Life\inbox-oauth.json'

try {
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw 'Node.js is not installed or is not on PATH. Install Node.js, then run this script again.'
  }
  if (-not (Test-Path $privateKey)) {
    throw 'Your private inbox key was not found at %USERPROFILE%\gb2l.inbox.private.pem. Do not upload or share it.'
  }
  if (-not (Test-Path $oauthStore)) {
    Add-Type -AssemblyName System.Windows.Forms
    $dialog = New-Object System.Windows.Forms.OpenFileDialog
    $dialog.Title = 'Select the Google Desktop OAuth client JSON file'
    $dialog.Filter = 'Google OAuth client JSON (*.json)|*.json'
    $dialog.Multiselect = $false
    if ($dialog.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) {
      throw 'Setup cancelled. No Gmail messages were read.'
    }
    & node $localSetup --credentials $dialog.FileName --private-key $privateKey
    if ($LASTEXITCODE -ne 0) { throw 'Local Gmail authorization did not complete. No messages were read.' }
    if ($SetupOnly) {
      Write-Host 'Local read-only authorization is complete. Inbox remains inactive until you request a read.'
      return
    }
  }
  & node $localRead --private-key $privateKey
  if ($LASTEXITCODE -ne 0) { throw 'Inbox processing stopped. See the safe error code above.' }
}
catch {
  Write-Host ''
  Write-Host ('GitBack2Life inbox: ' + $_.Exception.Message) -ForegroundColor Yellow
}
finally {
  Write-Host ''
  Read-Host 'Press Enter to close this window' | Out-Null
}
