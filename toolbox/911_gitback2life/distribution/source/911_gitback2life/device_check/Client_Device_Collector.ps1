# Shareable, consent-based client collector. No external connections or remote commands.
# Collects only the seven existing Windows security checks, and no account/device identifiers.
$ErrorActionPreference = 'Stop'
function Get-GB2LDownloads {
    $key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders'
    $id = '{374DE290-123F-4565-9164-39C4925E467B}'
    $configured = $null
    try {
        $props = Get-ItemProperty -Path $key -ErrorAction Stop
        $entry = $props.PSObject.Properties[$id]
        if ($null -ne $entry) { $configured = [string]$entry.Value }
    } catch { }
    if ([string]::IsNullOrWhiteSpace($configured)) {
        $configured = Join-Path ([Environment]::GetFolderPath('UserProfile')) 'Downloads'
    }
    $folder = [Environment]::ExpandEnvironmentVariables($configured)
    if (-not [IO.Path]::IsPathRooted($folder)) { throw 'Downloads folder is not an absolute path' }
    if (-not (Test-Path -LiteralPath $folder -PathType Container)) {
        New-Item -Path $folder -ItemType Directory -ErrorAction Stop | Out-Null
    }
    return [IO.Path]::GetFullPath($folder)
}

try {
    Write-Host '911 GitBack2Life - Client Computer Security Check'
    Write-Host 'This reads antivirus, update freshness, firewall, system drive encryption and lock policy.'
    Write-Host 'It does not scan files, capture passwords, change settings, install software or contact anyone.'
    Write-Host 'A small ZIP will be saved in YOUR Downloads folder. Review it before sending to your helper.'
    $consent = Read-Host 'If you own or administer this computer and agree, type YES'
    if ($consent -cne 'YES') { Write-Host 'Cancelled. No assessment ran.'; exit 0 }
    $scriptFile = Join-Path $PSScriptRoot 'check_device.ps1'
    if (-not (Test-Path -LiteralPath $scriptFile -PathType Leaf)) { throw 'Bundled security check is missing.' }
    $psExe = Join-Path $PSHOME 'powershell.exe'
    $p = New-Object System.Diagnostics.ProcessStartInfo
    $p.FileName = $psExe
    $p.Arguments = ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}"' -f $scriptFile)
    $p.WorkingDirectory = $PSScriptRoot
    $p.UseShellExecute = $false
    $p.CreateNoWindow = $true
    $p.RedirectStandardOutput = $true
    $p.RedirectStandardError = $true
    $child = [System.Diagnostics.Process]::new()
    $child.StartInfo = $p
    try {
        if (-not $child.Start()) { throw 'Could not start the Windows security check.' }
        $outTask = $child.StandardOutput.ReadToEndAsync()
        $errTask = $child.StandardError.ReadToEndAsync()
        if (-not $child.WaitForExit(60000)) {
            try { $child.Kill() } catch { }
            throw 'Security check took too long.'
        }
        $raw = $outTask.GetAwaiter().GetResult()
        [void]$errTask.GetAwaiter().GetResult() # Do not include raw stderr in a client report.
        if ($child.ExitCode -notin @(0, 1, 3)) { throw 'The read-only security check could not finish.' }
    } finally { $child.Dispose() }
    if ($raw.Length -gt 32768) { throw 'Security report exceeded the expected small size.' }
    $report = $raw | ConvertFrom-Json -ErrorAction Stop
    if ($report.schema_version -ne 1 -or $report.tool -ne 'device' -or
        $report.environment -ne 'local_device' -or $report.checks.Count -ne 7 -or
        $report.result -notin @('pass','fail','unresolved')) { throw 'Unexpected security report structure.' }
    $downloads = Get-GB2LDownloads
    $id = [Guid]::NewGuid().ToString('N').Substring(0, 12)
    $zipPath = Join-Path $downloads ('GB2L_CLIENT_DEVICE_REPORT_' + $id + '.zip')
    Add-Type -AssemblyName System.IO.Compression
    $stream = [IO.File]::Open($zipPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write)
    try {
        $zip = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Create, $false)
        try {
            $entry = $zip.CreateEntry('DEVICE_REPORT.json')
            $writer = [IO.StreamWriter]::new($entry.Open(), [Text.UTF8Encoding]::new($false))
            try { $writer.Write($raw.Trim()) } finally { $writer.Dispose() }
        } finally { $zip.Dispose() }
    } finally { $stream.Dispose() }
    Write-Host ('Saved: ' + $zipPath)
    Write-Host 'If you choose to share it, send ONLY that ZIP to the helper you trust.'
    Write-Host 'This report is a status snapshot, NOT a malware scan or full security assessment.'
    exit 0
} catch {
    Write-Host ('Collection failed: ' + $_.Exception.Message)
    exit 2
}
