# PowerShell 5.1 one-click development STAGING only. Not a production installer.
# Checks source and destination against one shipped SHA256 manifest. Never overwrites.
$ErrorActionPreference = 'Stop'
$run = [Guid]::NewGuid().ToString('N').Substring(0, 12)
$log = New-Object System.Collections.Generic.List[string]
$rc = 0
$created = $false
$dest = $null
# Preserve an existing project Temp location without assuming an account name.
# All other users stage in their OWN unshared local application-data directory,
# never in a Git checkout, public location, or protected authority directory.
function Get-GB2LStageRoot {
    $desktop = [Environment]::GetFolderPath('Desktop')
    if (-not [string]::IsNullOrWhiteSpace($desktop)) {
        $existing = Join-Path (Join-Path $desktop '911_gitback2life') 'Temp'
        if (Test-Path -LiteralPath $existing -PathType Container) { return $existing }
    }
    $local = [Environment]::GetFolderPath('LocalApplicationData')
    if ([string]::IsNullOrWhiteSpace($local)) { throw 'Current-user application data directory unavailable' }
    $location = Join-Path $local 'GitBack2Life\Temp'
    if (-not (Test-Path -LiteralPath $location -PathType Container)) {
        New-Item -Path $location -ItemType Directory -ErrorAction Stop | Out-Null
    }
    return $location
}
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
function Note([string]$s) {
    $script:log.Add(('[{0}] {1}' -f [DateTime]::UtcNow.ToString('o'), $s))
    Write-Host $s
}
function Guard-Tree([string]$path) {
    $rootItem = Get-Item -LiteralPath $path -Force
    if (($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse-point root refused' }
    foreach ($item in @(Get-ChildItem -LiteralPath $path -Force -Recurse)) {
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse point in staged source refused' }
    }
}
function Verify-Files([string]$folder, $expected) {
    # A correct count alone is not sufficient: a duplicated manifest entry
    # could otherwise hide an unexpected unverified payload file. Match EVERY
    # actual relative path to exactly one unique manifest entry.
    $actual = @(Get-ChildItem -LiteralPath $folder -File -Recurse -Force)
    if ($actual.Count -ne $expected.Count) { throw ('Unexpected file count: got {0}, expected {1}' -f $actual.Count, $expected.Count) }
    $names = @{}
    foreach ($entry in $expected) {
        if ($entry.path -notmatch '^[a-zA-Z0-9_./-]+$' -or $entry.path -match '(^|/)\.\.(/|$)' -or
            $entry.path -match '(^|/)\.(/|$)' -or $entry.path.StartsWith('/')) {
            throw 'Invalid manifest path'
        }
        $relativeName = $entry.path.Replace('/', '\')
        if ($names.ContainsKey($relativeName)) { throw ('Duplicate manifest entry: ' + $entry.path) }
        $names[$relativeName] = $true
        $f = Join-Path $folder $relativeName
        $got = Get-Item -LiteralPath $f -Force -ErrorAction Stop
        if (-not $got.PSIsContainer -and $got.Length -eq [long]$entry.bytes) {
            $hash = (Get-FileHash -LiteralPath $f -Algorithm SHA256).Hash
            if ($hash -ne $entry.sha256) { throw ('Hash mismatch: ' + $entry.path) }
        } else { throw ('Unexpected file size/type: ' + $entry.path) }
    }
    $prefix = (Get-Item -LiteralPath $folder -Force).FullName.TrimEnd('\') + '\'
    foreach ($file in $actual) {
        if (-not $file.FullName.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
            throw 'Staged file path escaped source root'
        }
        $relativeName = $file.FullName.Substring($prefix.Length)
        if (-not $names.ContainsKey($relativeName)) {
            throw ('Unexpected file outside manifest: ' + $relativeName)
        }
    }
}
function Verify-Embedded-Manifest([string]$folder, $expected) {
    # The inner source manifest is a complete independent source inventory except
    # for itself (a self-hash would be circular). BUILD_MANIFEST.json hashes the
    # inner manifest file. Reject any discrepancy, even when the outer manifest
    # independently matches the shipped ZIP.
    $embeddedPath = Join-Path $folder 'SOURCE_MANIFEST_SHA256.json'
    $embedded = Get-Content -LiteralPath $embeddedPath -Raw -ErrorAction Stop | ConvertFrom-Json
    if ($embedded.build -ne '2026-10-20_14TOOLS_EMAIL_COMMUNICATIONS_DRAFT' -or $null -eq $embedded.files) {
        throw 'Embedded source manifest identity or format mismatch'
    }
    $embeddedItems = @($embedded.files.PSObject.Properties)
    if ($embeddedItems.Count -ne ($expected.Count - 1)) {
        throw ('Embedded source manifest file count mismatch: got {0}, expected {1}' -f $embeddedItems.Count, ($expected.Count - 1))
    }
    $outerByPath = @{}
    foreach ($item in $expected) { $outerByPath[[string]$item.path] = $item }
    if (-not $outerByPath.ContainsKey('SOURCE_MANIFEST_SHA256.json')) {
        throw 'Outer build manifest is missing the embedded source manifest'
    }
    $names = @{}
    foreach ($prop in $embeddedItems) {
        $name = [string]$prop.Name
        if ($name -eq 'SOURCE_MANIFEST_SHA256.json' -or
            $name -notmatch '^[a-zA-Z0-9_./-]+$' -or $name -match '(^|/)\.{1,2}(/|$)') {
            throw ('Invalid embedded manifest path: ' + $name)
        }
        if ($names.ContainsKey($name) -or -not $outerByPath.ContainsKey($name)) {
            throw ('Duplicate or unexpected embedded source file: ' + $name)
        }
        $names[$name] = $true
        $metadata = $prop.Value
        $outer = $outerByPath[$name]
        if ([long]$metadata.bytes -ne [long]$outer.bytes -or
            ([string]$metadata.sha256).ToUpperInvariant() -ne ([string]$outer.sha256).ToUpperInvariant()) {
            throw ('Embedded and outer manifests disagree: ' + $name)
        }
        $path = Join-Path $folder ($name.Replace('/', '\'))
        $got = Get-Item -LiteralPath $path -ErrorAction Stop
        if ($got.PSIsContainer -or $got.Length -ne [long]$metadata.bytes -or
            (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -ne ([string]$metadata.sha256).ToUpperInvariant()) {
            throw ('Embedded source manifest hash/size mismatch: ' + $name)
        }
    }
    foreach ($item in $expected) {
        if ($item.path -ne 'SOURCE_MANIFEST_SHA256.json' -and -not $names.ContainsKey([string]$item.path)) {
            throw ('Missing embedded manifest file: ' + $item.path)
        }
    }
}
try {
    Note '911_gitback2life portable toolbox with owner-approved Email Communications (send disabled) staging'
    $here = (Resolve-Path -LiteralPath $PSScriptRoot).Path
    $source = Join-Path $here 'source\911_gitback2life'
    $manifestPath = Join-Path $here 'BUILD_MANIFEST.json'
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw 'Source manifest is absent' }
    if (-not (Test-Path -LiteralPath $source -PathType Container)) { throw 'Extracted source is absent; extract the whole ZIP first' }
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    if ($manifest.schema_version -ne 1 -or $manifest.build -ne '2026-10-20_14TOOLS_EMAIL_COMMUNICATIONS_DRAFT') { throw 'Unexpected source manifest' }
    $expected = @($manifest.files)
    if ($expected.Count -lt 170 -or $expected.Count -gt 220) { throw 'Unexpected source inventory size' }
    Guard-Tree $source
    Verify-Files $source $expected
    Verify-Embedded-Manifest $source $expected
    Note ('Verified {0} shipped project files against both independently enumerated SHA256 manifests.' -f $expected.Count)
    $approved = Get-GB2LStageRoot
    Note ('Staging directory for current Windows user: ' + $approved)
    $approvedItem = Get-Item -LiteralPath $approved -Force
    if (($approvedItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Approved Temp is a reparse point' }
    $dest = Join-Path $approved 'GB2L_TOOLBOX_DEV_20261020_14TOOLS_EMAIL_COMM_DRAFT'
    if (Test-Path -LiteralPath $dest) { throw 'This batch is already staged or destination exists. Existing folders are never replaced' }
    New-Item -Path $dest -ItemType Directory -ErrorAction Stop | Out-Null
    $created = $true
    Get-ChildItem -LiteralPath $source -Force | Copy-Item -Destination $dest -Recurse -Force -ErrorAction Stop
    Guard-Tree $dest
    Verify-Files $dest $expected
    Verify-Embedded-Manifest $dest $expected
    Note 'New independent staged source verified against both manifests. No previous build overwritten.'
    $node = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($null -eq $node) { throw 'Node.js 22+ unavailable; this copied batch will be rolled back' }
    $major = (& $node.Source -p "Number(process.versions.node.split('.')[0])").Trim()
    if ([int]$major -lt 22) { throw 'Node.js 22+ required; this copied batch will be rolled back' }
    foreach ($file in @('toolbox\toolbox.mjs', 'toolbox\diagnostics.mjs')) {
        & $node.Source --check (Join-Path $dest $file)
        if ($LASTEXITCODE -ne 0) { throw ('Node syntax check failed: ' + $file) }
    }
    # Check the PowerShell 5.1 GUI parses before completing the new staging.
    # This does not claim the interactive window was displayed on this host.
    $guiFile = Join-Path $dest 'toolbox\ToolboxUI.ps1'
    $uiText = Get-Content -LiteralPath $guiFile -Raw -ErrorAction Stop
    $uiParseErrors = $null
    [void][System.Management.Automation.PSParser]::Tokenize($uiText, [ref]$uiParseErrors)
    if ($null -ne $uiParseErrors -and @($uiParseErrors).Count -gt 0) { throw ('WinForms interface syntax error: ' + $uiParseErrors[0].Message) }
    foreach ($clientScript in @('device_check\check_device.ps1', 'device_check\Client_Device_Collector.ps1')) {
        $clientText = Get-Content -LiteralPath (Join-Path $dest $clientScript) -Raw -ErrorAction Stop
        $clientErrors = $null
        [void][System.Management.Automation.PSParser]::Tokenize($clientText, [ref]$clientErrors)
        if ($null -ne $clientErrors -and @($clientErrors).Count -gt 0) { throw ('Client security script syntax error: ' + $clientErrors[0].Message) }
    }
    Note 'PASS Windows PowerShell GUI and consenting client-collector script syntax.'
    # One substantial acceptance, with synthetic temporary case data only.
    # Always preserve device-status findings as findings; fail only if the tool
    # cannot run or does not return its contracted JSON report.
    $acceptance = Join-Path $here 'WINDOWS_ACCEPTANCE.mjs'
    if (-not (Test-Path -LiteralPath $acceptance -PathType Leaf)) { throw 'Bundled Windows acceptance check is missing' }
    Note 'Running the single combined Windows offline acceptance (no network, installs or authority changes).'
    # PowerShell 5.1 turns a native child's STDERR into ErrorRecords when using
    # 2>&1. With ErrorActionPreference=Stop, even an ordinary informational
    # 'scope ... allowed' line aborts the stager. Run Node with two native pipes
    # and collect both asynchronously instead; the EXIT CODE decides success.
    # Exact fixed arguments; no shells, downloads, elevated prompts or commands
    # created from owner input. Spaces in extracted paths remain supported.
    $start = New-Object System.Diagnostics.ProcessStartInfo
    $start.FileName = [string]$node.Source
    $start.Arguments = ('"{0}" "{1}"' -f $acceptance, $dest)
    $start.WorkingDirectory = $dest
    $start.UseShellExecute = $false
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.CreateNoWindow = $true
    $child = [System.Diagnostics.Process]::new()
    $child.StartInfo = $start
    try {
        if (-not $child.Start()) { throw 'Consolidated acceptance could not start Node' }
        $stdoutTask = $child.StandardOutput.ReadToEndAsync()
        $stderrTask = $child.StandardError.ReadToEndAsync()
        if (-not $child.WaitForExit(180000)) {
            try { $child.Kill() } catch { }
            throw 'Consolidated acceptance timed out; see support ZIP'
        }
        foreach ($line in ($stdoutTask.GetAwaiter().GetResult() -split "`n")) {
            if ($line.Trim()) { Note ($line.TrimEnd([char]13)) }
        }
        foreach ($line in ($stderrTask.GetAwaiter().GetResult() -split "`n")) {
            if ($line.Trim()) { Note ('ACCEPTANCE STDERR (informational unless exit nonzero): ' + $line.TrimEnd([char]13)) }
        }
        if ($child.ExitCode -ne 0) { throw ('Windows consolidated acceptance failed (exit ' + $child.ExitCode + '); see support ZIP') }
    } finally { $child.Dispose() }
    Note ('STAGED AND VERIFIED: ' + $dest)
    Note 'No further manual menu checks are needed. No activation or installation was performed.'
} catch {
    $rc = 2
    Note ('STAGING REFUSED: ' + $_.Exception.Message)
    if ($created -and $null -ne $dest) {
        try {
            # Only our just-created, uniquely named destination; no original or previous build touched.
            Remove-Item -LiteralPath $dest -Recurse -Force -ErrorAction Stop
            Note 'Rolled back only the newly created incomplete staged folder.'
        } catch { Note ('Could not roll back incomplete new folder; please inspect: ' + $dest) }
    }
} finally {
    # One small diagnostic ZIP always saved to Downloads if the folder is available;
    # no project data, incidents, registry contents or captured console input.
    try {
        $downloads = Get-GB2LDownloads
        $zipPath = Join-Path $downloads ('GB2L_DEV_STAGE_SUPPORT_20261020_' + $run + '.zip')
        Add-Type -AssemblyName System.IO.Compression
        $stream = [IO.File]::Open($zipPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write)
        try {
            $archive = [System.IO.Compression.ZipArchive]::new($stream, [System.IO.Compression.ZipArchiveMode]::Create, $false)
            try {
                $entry = $archive.CreateEntry('STAGE_REPORT.txt')
                $writer = [IO.StreamWriter]::new($entry.Open(), [Text.UTF8Encoding]::new($false))
                try { $writer.Write(($log -join "`r`n") + "`r`nExit code: $rc`r`n") } finally { $writer.Dispose() }
            } finally { $archive.Dispose() }
        } finally { $stream.Dispose() }
        Write-Host ('Support ZIP saved in Downloads: ' + $zipPath)
    } catch {
        Write-Host ('WARNING: Support ZIP was not produced: ' + $_.Exception.Message)
        if ($rc -eq 0) { $rc = 2 }
    }
}
exit $rc
