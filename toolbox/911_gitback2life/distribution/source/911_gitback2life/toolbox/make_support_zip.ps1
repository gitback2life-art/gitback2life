# Windows PowerShell 5.1-compatible, run-after-exit diagnostic collector.
# Never captures interactive input, case contents, request payloads, or register data.
[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$LaunchLog,
    [Parameter(Mandatory=$true)][string]$AppLog,
    [Parameter(Mandatory=$true)][string]$StderrLog,
    [Parameter(Mandatory=$true)][string]$RunId,
    [Parameter(Mandatory=$true)][int]$ExitCode,
    [switch]$Snapshot
)
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
    if ($RunId -notmatch '^\d{1,6}_\d{1,6}_\d{1,6}$') { throw 'Invalid run ID' }
    $root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
    $logs = [IO.Path]::GetFullPath((Join-Path $root 'Temp\Logs'))
    $wanted = @(
        @{ Given=$LaunchLog; Name=('launcher_' + $RunId + '.log'); Required=$true },
        @{ Given=$AppLog; Name=('toolbox_' + $RunId + '.log'); Required=$false },
        @{ Given=$StderrLog; Name=('node_stderr_' + $RunId + '.log'); Required=$false }
    )
    $items = @()
    $present = @()
    foreach ($spec in $wanted) {
        $p = [IO.Path]::GetFullPath($spec.Given)
        $expected = [IO.Path]::GetFullPath((Join-Path $logs $spec.Name))
        if ($p -ne $expected) { throw ('Unexpected diagnostic path: ' + $spec.Name) }
        # Windows CMD owns stderr throughout the Node process. Do not attempt
        # to open that handle during an error snapshot (EBUSY on some systems).
        if ($Snapshot -and $spec.Name -like 'node_stderr_*') { continue }
        if (Test-Path -LiteralPath $p -PathType Leaf) {
            $items += $p
            $present += $spec.Name
        } elseif ($spec.Required) { throw 'Launcher log missing' }
    }
    $downloads = Get-GB2LDownloads
    $info = Join-Path $logs ('support_' + $RunId + $(if ($Snapshot) { '_ERROR' } else { '' }) + '.txt')
    $zip = Join-Path $downloads ('GB2L_TOOLBOX_SUPPORT_' + $RunId + $(if ($Snapshot) { '_ERROR' } else { '' }) + '.zip')
    if (Test-Path -LiteralPath $zip) { throw 'Support ZIP already exists; refusing overwrite' }
    $version = '(unavailable)'
    try { $version = (& node.exe --version 2>$null) } catch { }
    $status = @(
        '911_gitback2life ordinary toolbox development-build diagnostics',
        ('Run ID: ' + $RunId),
        ('Exit code: ' + $ExitCode),
        ('Collection type: ' + $(if ($Snapshot) { 'early error snapshot (stderr saved at normal exit)' } else { 'run completion' })),
        ('Collected UTC: ' + [DateTime]::UtcNow.ToString('o')),
        ('Windows PowerShell version: ' + $PSVersionTable.PSVersion.ToString()),
        ('Node version: ' + $version),
        ('Captured logs: ' + ($present -join ', ')),
        'Production authority: not installed or activated by TOOLBOX.cmd',
        'No case files, register files, request payloads, console input or credentials bundled.'
    )
    [IO.File]::WriteAllLines($info, $status, [Text.UTF8Encoding]::new($false))
    $items += $info
    Compress-Archive -LiteralPath $items -DestinationPath $zip -CompressionLevel Optimal -ErrorAction Stop
    Write-Host ('Support ZIP saved: ' + $zip)
    exit 0
} catch {
    [Console]::Error.WriteLine('Support ZIP failed: ' + $_.Exception.Message)
    exit 3
}
