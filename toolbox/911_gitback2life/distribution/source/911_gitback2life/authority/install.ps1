# gitback2life protected authority: one-time install. Run by the OWNER in an Administrator PowerShell.
# It creates an admin-only folder, copies the authority code into it, and locks the folder AND every file in it so the
# normal account (and any AI or script running under it WITHOUT administrator rights) can read and run the code but
# never change it. It changes no other system setting. Review it, and the two .mjs files, before running it.
$ErrorActionPreference = 'Stop'
$dest = 'C:\ProgramData\gitback2life-authority'
$src = Split-Path -Parent $MyInvocation.MyCommand.Path
$expected = @('authority_core.mjs', 'authority_cli.mjs', 'public_key.pem', 'private_key.enc.json', 'state.json', 'authorizations')
# V6-03: the protected verifier and every command below use Node by FIXED path (never a "node" found on PATH).
$node = 'C:\Program Files\nodejs\node.exe'

$me = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $me.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Run this from an Administrator PowerShell.' }

function Test-Reparse($path) { [bool]((Get-Item -LiteralPath $path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) }
if (Test-Reparse 'C:\ProgramData') { throw 'C:\ProgramData is a link (reparse point); refusing to install.' }
if (-not (Test-Path -LiteralPath $node -PathType Leaf)) { throw "Node.js was not found at $node. Install it there (it must be admin-only), then run this again." }
$nodeOwner = (Get-Acl -LiteralPath $node).Owner
if ($nodeOwner -notin @('BUILTIN\Administrators', 'NT AUTHORITY\SYSTEM', 'NT SERVICE\TrustedInstaller')) { throw "$node is owned by $nodeOwner, not Administrators; refusing." }

if (Test-Path -LiteralPath $dest) {
    if (Test-Reparse $dest) { throw "$dest is a link (reparse point). Inspect it and remove it as Administrator, then run this again." }
    $owner = (Get-Acl -LiteralPath $dest).Owner
    if ($owner -notin @('BUILTIN\Administrators', 'NT AUTHORITY\SYSTEM')) {
        throw "$dest already exists and is owned by $owner, not Administrators. It may have been created by a normal-account process (possibly to plant a key). Inspect it, delete it as Administrator, then run this again."
    }
    $unexpected = @(Get-ChildItem -LiteralPath $dest -Force | Where-Object { $_.Name -notin $expected })
    if ($unexpected.Count -gt 0) { throw "$dest contains unexpected items: $($unexpected.Name -join ', '). Inspect and remove them as Administrator, then run this again." }
    foreach ($c in Get-ChildItem -LiteralPath $dest -Force) { if (Test-Reparse $c.FullName) { throw "$($c.FullName) is a link; refusing." } }
    $auth = Join-Path $dest 'authorizations'
    if (Test-Path -LiteralPath $auth) {
        if (-not (Test-Path -LiteralPath $auth -PathType Container)) { throw "$auth is not a folder; refusing." }
        foreach ($c in Get-ChildItem -LiteralPath $auth -Force) {
            if (Test-Reparse $c.FullName) { throw "$($c.FullName) is a link; refusing." }
            if ($c.PSIsContainer -or $c.Name -notlike '*.json') { throw "$auth contains an unexpected item: $($c.Name). Inspect and remove it as Administrator." }
        }
    }
} else {
    New-Item -ItemType Directory -Path $dest | Out-Null
}

function New-AdminOnlyAcl([bool]$isFolder) {
    $acl = if ($isFolder) { New-Object System.Security.AccessControl.DirectorySecurity } else { New-Object System.Security.AccessControl.FileSecurity }
    $acl.SetOwner([Security.Principal.NTAccount]'BUILTIN\Administrators')
    $acl.SetAccessRuleProtection($true, $false) # no inherited entries
    $inherit = if ($isFolder) { [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit' } else { [System.Security.AccessControl.InheritanceFlags]::None }
    $none = [System.Security.AccessControl.PropagationFlags]::None
    foreach ($r in @(@('BUILTIN\Administrators', 'FullControl'), @('NT AUTHORITY\SYSTEM', 'FullControl'), @('BUILTIN\Users', 'ReadAndExecute'))) {
        $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($r[0], $r[1], $inherit, $none, 'Allow')))
    }
    return $acl
}

Set-Acl -LiteralPath $dest -AclObject (New-AdminOnlyAcl $true)
foreach ($f in 'authority_core.mjs', 'authority_cli.mjs') {
    Copy-Item -LiteralPath (Join-Path $src $f) -Destination (Join-Path $dest $f) -Force
}
# Every file, new or pre-existing, gets the same explicit admin-only permissions (a protected folder alone is not enough),
# including the authorizations folder and the signed authorizations inside it (checked above: no links, files only).
foreach ($c in Get-ChildItem -LiteralPath $dest -Force -File) { Set-Acl -LiteralPath $c.FullName -AclObject (New-AdminOnlyAcl $false) }
if (Test-Path -LiteralPath (Join-Path $dest 'authorizations')) {
    Set-Acl -LiteralPath (Join-Path $dest 'authorizations') -AclObject (New-AdminOnlyAcl $true)
    foreach ($c in Get-ChildItem -LiteralPath (Join-Path $dest 'authorizations') -Force -File) { Set-Acl -LiteralPath $c.FullName -AclObject (New-AdminOnlyAcl $false) }
}
foreach ($f in 'authority_core.mjs', 'authority_cli.mjs') {
    $h = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $dest $f)).Hash.ToLower()
    Write-Host "installed $f  sha256 $h"
}
Write-Host ''
Write-Host 'Compare the two SHA-256 values above with the ones the independent reviewer reported. If they differ, STOP.'
Write-Host 'Next, in this Administrator window (Node by its full path; never a "node" found on PATH):'
Write-Host "  & `"$node`" `"$dest\authority_cli.mjs`" init"
Write-Host "  & `"$node`" `"$dest\authority_cli.mjs`" check-protection"
Write-Host "  & `"$node`" `"$dest\authority_cli.mjs`" baseline `"$((Resolve-Path (Join-Path $src '..')).Path)`""
Write-Host 'After init creates the key, the state and the authorizations folder, run this installer once more so they get the same explicit permissions.'
