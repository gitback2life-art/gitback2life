# Reviewed source candidate only. NOT RUN against any protected machine.
# Predeployment layout/ACL installer, NOT key/genesis initialization or production activation.
# Defaults to read-only Plan. Deploy requires a separate owner gate and explicit parameter.
[CmdletBinding(DefaultParameterSetName='Plan')]
param(
  [Parameter(ParameterSetName='Plan')][switch]$Plan,
  [Parameter(ParameterSetName='Deploy',Mandatory=$true)][switch]$Deploy
)
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$Root = 'C:\ProgramData\gitback2life-authority'
$Node = 'C:\Program Files\nodejs\node.exe'
$Payload = Join-Path $PSScriptRoot 'payload'
$ManifestFile = Join-Path $PSScriptRoot 'payload_manifest.json'
$created = $false
$log = New-Object 'System.Collections.Generic.List[string]'
$reportDir = Join-Path ([IO.Path]::GetTempPath()) ('gb2l-deploy-report-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $reportDir | Out-Null
function Write-Safe([string]$message) {
  $line = ([DateTime]::UtcNow.ToString('u') + ' ' + $message)
  $log.Add($line)
  Write-Host $line
}
function Must([bool]$condition,[string]$reason) { if (-not $condition) { throw "REFUSED: $reason" } }
function NoLink([string]$path) {
  if (Test-Path -LiteralPath $path) {
    $item = Get-Item -LiteralPath $path -Force
    Must (-not [bool]($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) "link/junction in path: $path"
    if (-not $item.PSIsContainer) {
      # GetFileInformationByHandle hard-link checks belong to the later Windows gate.
      Must ($item -is [IO.FileInfo]) "non-file entry: $path"
    }
  }
}
function MakeACL([bool]$directory,[bool]$usersRead) {
  if ($directory) { $acl = New-Object System.Security.AccessControl.DirectorySecurity }
  else { $acl = New-Object System.Security.AccessControl.FileSecurity }
  $acl.SetAccessRuleProtection($true,$false)
  $acl.SetOwner([Security.Principal.SecurityIdentifier]'S-1-5-32-544')
  $inherit = if ($directory) { [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit' } else { [Security.AccessControl.InheritanceFlags]::None }
  $prop = [Security.AccessControl.PropagationFlags]::None
  foreach($id in @('S-1-5-32-544','S-1-5-18')) {
    $sid = [Security.Principal.SecurityIdentifier]::new($id)
    $r = [Security.AccessControl.FileSystemAccessRule]::new($sid,[Security.AccessControl.FileSystemRights]::FullControl,$inherit,$prop,[Security.AccessControl.AccessControlType]::Allow)
    $acl.AddAccessRule($r)
  }
  if ($usersRead) {
    $users = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-545')
    $r = [Security.AccessControl.FileSystemAccessRule]::new($users,[Security.AccessControl.FileSystemRights]::ReadAndExecute,$inherit,$prop,[Security.AccessControl.AccessControlType]::Allow)
    $acl.AddAccessRule($r)
  }
  return $acl
}
function SecureItem([string]$path,[bool]$dir,[bool]$usersRead) {
  NoLink $path
  Set-Acl -LiteralPath $path -AclObject (MakeACL $dir $usersRead)
}
# Read back effective on-disk access rules instead of treating a successful Set-Acl as proof.
# Only the two administrative SIDs, plus Users for read-only items, may have explicit rights.
function VerifyACL([string]$path,[bool]$usersRead) {
  NoLink $path
  $acl = Get-Acl -LiteralPath $path
  Must $acl.AreAccessRulesProtected "ACL inheritance was not disabled: $path"
  $ownerSid = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
  Must ($ownerSid -ceq 'S-1-5-32-544') "unexpected ACL owner: $path"
  $want = @('S-1-5-32-544', 'S-1-5-18')
  if ($usersRead) { $want += 'S-1-5-32-545' }
  $seen = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
  $rules = @($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))
  foreach ($rule in $rules) {
    $sid = $rule.IdentityReference.Value
    Must (-not $rule.IsInherited) "inherited access rule: $path"
    Must ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow) "deny/unexpected access rule: $path"
    Must ($sid -in $want) "unapproved access SID $sid : $path"
    Must ($seen.Add($sid)) "multiple access rules for $sid : $path"
    if ($sid -eq 'S-1-5-32-545') {
      # FileSystemAccessRule normalization can add Synchronize; explicitly bar every write-like right.
      $forbidden = [Security.AccessControl.FileSystemRights]::Write -bor
                   [Security.AccessControl.FileSystemRights]::Delete -bor
                   [Security.AccessControl.FileSystemRights]::ChangePermissions -bor
                   [Security.AccessControl.FileSystemRights]::TakeOwnership -bor
                   [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles
      Must (($rule.FileSystemRights -band $forbidden) -eq 0) "Users have write/delete/control rights: $path"
      Must (($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::ReadAndExecute) -eq [Security.AccessControl.FileSystemRights]::ReadAndExecute) "Users lack ReadAndExecute: $path"
    } else {
      Must (($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -eq [Security.AccessControl.FileSystemRights]::FullControl) "admin/system lack FullControl: $path"
    }
  }
  Must ($seen.Count -eq $want.Count) "missing expected ACL entries: $path"
}
# Roll back only installer-owned, fully recognizable files. Never recursively delete an
# unknown path, reparse point, changed payload, ledger, key, or evidence from a failed run.
function SafeRollbackNewRoot {
  Must $created 'rollback not owned by this invocation'
  Must (Test-Path -LiteralPath $Root -PathType Container) 'created root missing or not a folder'
  $allowedDirs = @('', 'm1','m2','m3','g0a','ledger','evidence','staging','journal','data','data\registers','data\restores','data\.work','launch_scratch')
  $dirs = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  foreach ($rel in $allowedDirs) { [void]$dirs.Add($rel.Replace('/','\')) }
  $files = @{}
  foreach ($e in $manifest.files) { $rel = ([string]$e.path).Replace('/','\'); $files[$rel] = [string]$e.sha256 }
  $files['installed_manifest.json'] = 'receipt'
  $files['ledger\authority.lock'] = 'empty_lock'
  NoLink $Root
  # Enumerate one directory at a time, checking each child BEFORE descending;
  # never follow a reparse point while collecting rollback candidates.
  $stack = New-Object 'System.Collections.Generic.Stack[string]'
  $stack.Push($Root)
  while ($stack.Count -gt 0) {
    $folder = $stack.Pop()
    foreach ($item in @(Get-ChildItem -LiteralPath $folder -Force)) {
      NoLink $item.FullName
      $rel = $item.FullName.Substring($Root.Length + 1)
      if ($item.PSIsContainer) {
        Must ($dirs.Contains($rel)) "preserving unknown directory after failed install: $rel"
        $stack.Push($item.FullName)
      } else {
        Must ($files.ContainsKey($rel)) "preserving unknown file after failed install: $rel"
        $kind = $files[$rel]
        if ($kind -eq 'empty_lock') {
          Must ($item.Length -eq 0) "preserving changed lock file: $rel"
        } elseif ($kind -ne 'receipt') {
          $actual = (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
          Must ($actual -ceq $kind) "preserving modified payload: $rel"
        }
      }
    }
  }
  Remove-Item -LiteralPath $Root -Recurse -Force -ErrorAction Stop
}
function CheckManifest {
  Must (Test-Path -LiteralPath $ManifestFile -PathType Leaf) 'payload manifest absent'
  Must (Test-Path -LiteralPath $Payload -PathType Container) 'payload folder absent'
  NoLink $ManifestFile
  NoLink $Payload
  $m = Get-Content -LiteralPath $ManifestFile -Raw | ConvertFrom-Json
  Must ($m.schema -ceq 'gb2l-predeploy-v1') 'unknown payload schema'
  Must ($null -ne $m.files) 'missing payload file list'
  $expected = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  $expectedDirs = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  foreach ($e in $m.files) {
    $rel = [string]$e.path
    Must ($rel -cmatch '^[a-z0-9_./-]+$' -and -not $rel.Contains('..') -and -not $rel.StartsWith('/') -and -not $rel.EndsWith('/')) "unsafe payload name: $rel"
    $parts = @($rel.Split('/'))
    foreach ($part in $parts) {
      Must ($part -ne '.' -and $part.Length -gt 0 -and -not $part.EndsWith('.') -and $part -notmatch '^(?i:con|prn|aux|nul|com[1-9]|lpt[1-9])$') "unsafe Windows payload segment: $rel"
    }
    Must ($expected.Add($rel)) "duplicate/colliding manifest entry: $rel"
    $name = ''
    for ($i = 0; $i -lt $parts.Length - 1; $i++) {
      if ($name) { $name += '/' }
      $name += $parts[$i]
      [void]$expectedDirs.Add($name)
    }
    $f = Join-Path $Payload ($rel.Replace('/','\'))
    $parent = Split-Path -Parent $f
    NoLink $parent
    Must (Test-Path -LiteralPath $f -PathType Leaf) "missing payload: $rel"
    NoLink $f
    Must ([string]$e.sha256 -cmatch '^[a-f0-9]{64}$') "invalid manifest hash: $rel"
    Must ($e.bytes -is [int] -or $e.bytes -is [long]) "invalid manifest size: $rel"
    Must ($e.bytes -ge 0) "negative payload size: $rel"
    $size = (Get-Item -LiteralPath $f -Force).Length
    Must ($size -eq [long]$e.bytes) "payload byte count mismatch: $rel"
    $sha = (Get-FileHash -LiteralPath $f -Algorithm SHA256).Hash.ToLowerInvariant()
    Must ($sha -ceq [string]$e.sha256) "hash mismatch: $rel"
  }
  # Walk directories ourselves; -File -Recurse could overlook a directory junction
  # that does not itself appear in the enumerated file list.
  $stack = New-Object 'System.Collections.Generic.Stack[string]'
  $stack.Push($Payload)
  $found = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  while ($stack.Count -gt 0) {
    $folder = $stack.Pop()
    NoLink $folder
    foreach ($item in @(Get-ChildItem -LiteralPath $folder -Force)) {
      NoLink $item.FullName
      $rel = $item.FullName.Substring($Payload.Length + 1).Replace('\','/')
      if ($item.PSIsContainer) {
        Must ($expectedDirs.Contains($rel)) "unlisted payload folder: $rel"
        $stack.Push($item.FullName)
      } else {
        Must ($expected.Contains($rel)) "unlisted payload file: $rel"
        Must ($found.Add($rel)) "case-colliding payload file: $rel"
      }
    }
  }
  Must ($found.Count -eq $expected.Count) 'not every listed payload file was found'
  return $m
}
# Use Windows' atomic CreateDirectoryW (ERROR_ALREADY_EXISTS refuses) with the protected
# security descriptor supplied AT CREATION. .NET CreateDirectory is unsuitable here:
# it succeeds for an already-existing folder, which could lead to an unsafe rollback.
function CreateFreshRoot {
  $csharp = @'
using System;
using System.Runtime.InteropServices;
public static class GB2LFreshDirectory {
  [StructLayout(LayoutKind.Sequential)]
  public struct SECURITY_ATTRIBUTES {
    public int nLength;
    public IntPtr lpSecurityDescriptor;
    public int bInheritHandle;
  }
  // Return the structure size from compiled C#, avoiding the PowerShell 5.1 overload binder
  // that tries to marshal System.RuntimeType instead of the struct itself.
  public static int SecurityAttributesSize() {
    return Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES));
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true, EntryPoint="CreateDirectoryW")]
  public static extern bool CreateDirectory(string path, ref SECURITY_ATTRIBUTES attrs);
}
'@
  Add-Type -Language CSharp -TypeDefinition $csharp -ErrorAction Stop
  $security = MakeACL $true $false
  $bytes = $security.GetSecurityDescriptorBinaryForm()
  $buffer = [Runtime.InteropServices.Marshal]::AllocHGlobal($bytes.Length)
  try {
    [Runtime.InteropServices.Marshal]::Copy($bytes, 0, $buffer, $bytes.Length)
    $attrs = New-Object GB2LFreshDirectory+SECURITY_ATTRIBUTES
    $attrs.nLength = [GB2LFreshDirectory]::SecurityAttributesSize()
    $attrs.lpSecurityDescriptor = $buffer
    $attrs.bInheritHandle = 0
    $ok = [GB2LFreshDirectory]::CreateDirectory($Root, [ref]$attrs)
    if (-not $ok) {
      $nativeError = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
      throw "REFUSED: cannot exclusively create fresh authority folder (Win32 $nativeError); existing destination preserved"
    }
  } finally {
    [Runtime.InteropServices.Marshal]::FreeHGlobal($buffer)
  }
}
function AdminCheck {
  $principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
  Must ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) 'Deploy needs owner-started Administrator shell; no auto elevation'
}
function ValidatePath {
  NoLink 'C:\ProgramData'
  NoLink $Root
  Must (Test-Path -LiteralPath $Node -PathType Leaf) 'pinned Node path absent'
  NoLink $Node
  $ac = Get-Acl -LiteralPath $Node
  Must ($ac.Owner -in @('BUILTIN\Administrators','NT AUTHORITY\SYSTEM','NT SERVICE\TrustedInstaller')) 'Node runtime ownership is not trusted'
}
function PublishReport([string]$status) {
  try {
    [IO.File]::WriteAllLines((Join-Path $reportDir 'installer_report.txt'), $log.ToArray())
    [IO.File]::WriteAllText((Join-Path $reportDir 'status.txt'), $status)
    # No secrets, environment dump, private keys, raw ACL exports or protected content in report.
    $downloads = Join-Path $env:USERPROFILE 'Downloads'
    if (-not (Test-Path -LiteralPath $downloads -PathType Container)) { $downloads = $env:TEMP }
    $zip = Join-Path $downloads ('gb2l_predeploy_support_' + [DateTime]::UtcNow.ToString('yyyyMMdd_HHmmss') + '_' + [guid]::NewGuid().ToString('N').Substring(0,8) + '.zip')
    Compress-Archive -Path (Join-Path $reportDir '*.txt') -DestinationPath $zip -CompressionLevel Optimal
    Write-Host "Sanitized support ZIP: $zip"
  } catch { Write-Host 'Support ZIP creation failed; no security state changed by this reporting error.' }
  finally { Remove-Item -LiteralPath $reportDir -Force -Recurse -ErrorAction SilentlyContinue }
}
try {
  Write-Safe 'Predeployment source candidate; NOT authority activation or M4.'
  $manifest = CheckManifest
  ValidatePath
  if (-not $Deploy) {
    Write-Safe ("PLAN PASS: " + $manifest.files.Count + " exact payload hashes verified; no install performed.")
    Write-Safe "Destination: $Root; existing root is never overwritten or migrated by this script."
    Write-Safe 'Pending separately authorized Windows installer test, G0b, G2, and M4.'
    PublishReport 'PLAN_PASSED_NO_INSTALL'
    exit 0
  }
  AdminCheck
  Must (-not (Test-Path -LiteralPath $Root)) 'existing authority; preserve it and use separately reviewed migration (not this script)'
  Write-Host 'This prepares protected files but DOES NOT initialize genesis/keys or activate writes.'
  $confirmation = Read-Host 'To continue AFTER separate owner authorization, type exactly AUTHORIZE NEW PREDEPLOYMENT'
  Must ($confirmation -ceq 'AUTHORIZE NEW PREDEPLOYMENT') 'owner did not authorize this preparation'
  # Create the root with restrictive permissions and exclusive name creation in ONE Windows syscall.
  # Fail if the destination appeared concurrently, even if it was empty.
  CreateFreshRoot
  $created = $true
  SecureItem $Root $true $false
  $directories = @('', 'm1','m2','m3','g0a','ledger','evidence','staging','journal','data','data\registers','data\restores','data\.work','launch_scratch')
  foreach($relative in $directories) {
    $d = if ($relative -eq '') { $Root } else { Join-Path $Root $relative }
    if ($relative -ne '') { New-Item -ItemType Directory -Path $d -ErrorAction Stop | Out-Null }
    $userRead = ($relative -in @('','m1','m2','m3','g0a','ledger','data','data\registers','data\restores'))
    SecureItem $d $true $userRead
  }
  foreach ($e in $manifest.files) {
    $destFile = Join-Path $Root ([string]$e.path).Replace('/','\')
    $parent = Split-Path -Parent $destFile
    Must (Test-Path -LiteralPath $parent -PathType Container) 'unknown payload subdirectory'
    Copy-Item -LiteralPath (Join-Path $Payload ([string]$e.path).Replace('/','\')) -Destination $destFile -ErrorAction Stop
    SecureItem $destFile $false $true
    Must (((Get-FileHash -LiteralPath $destFile -Algorithm SHA256).Hash.ToLowerInvariant()) -ceq [string]$e.sha256) 'post-copy hash mismatch'
  }
  # Install-time runtime fingerprint is explicitly provisional until an independently approved pinned hash is supplied.
  $runtimeHash = (Get-FileHash -LiteralPath $Node -Algorithm SHA256).Hash.ToLowerInvariant()
  $record = [ordered]@{ schema='gb2l-predeploy-v1'; status='not_initialized_no_authority'; runtime_path=$Node; runtime_sha256=$runtimeHash; files=@{} }
  foreach ($e in $manifest.files) { $record.files[[string]$e.path] = [string]$e.sha256 }
  $recordJson = ConvertTo-Json -InputObject $record -Depth 8
  $receiptPath = Join-Path $Root 'installed_manifest.json'
  [IO.File]::WriteAllText($receiptPath,$recordJson,(New-Object System.Text.UTF8Encoding($false)))
  SecureItem $receiptPath $false $true
  $lockfile = Join-Path $Root 'ledger\authority.lock'
  [IO.File]::WriteAllBytes($lockfile,[byte[]]@())
  SecureItem $lockfile $false $false
  # Explicit read-back of every installed ACL; fail closed if security descriptors are not as specified.
  foreach ($relative in $directories) {
    $d = if ($relative -eq '') { $Root } else { Join-Path $Root $relative }
    $userRead = ($relative -in @('','m1','m2','m3','g0a','ledger','data','data\registers','data\restores'))
    VerifyACL $d $userRead
  }
  foreach ($e in $manifest.files) { VerifyACL (Join-Path $Root ([string]$e.path).Replace('/','\')) $true }
  VerifyACL $receiptPath $true
  VerifyACL $lockfile $false
  # Intentionally NO ledger.log, key or genesis: cannot claim activation before owner G0b/G2/M4.
  Must (-not (Test-Path -LiteralPath (Join-Path $Root 'ledger\ledger.log'))) 'unexpected pre-existing ledger'
  Write-Safe 'PREDEPLOYMENT CREATED AND ACLS VERIFIED: files and ACLs; no ledger/key created, no authority writes enabled.'
  Write-Safe ("Installed runtime SHA256 for independent owner review: " + $runtimeHash)
  Write-Safe 'STOP: do not operate this authority; owner G0b, G2 and M4 remain pending.'
  PublishReport 'PREDEPLOYMENT_ONLY_NOT_ACTIVATED'
  exit 0
} catch {
  # Rollback only a destination this invocation itself created; never touch a pre-existing authority.
  $errText = $_.Exception.Message -replace '(?i)passphrase[^ ]*','[REDACTED]'
  Write-Safe ("ERROR: " + $errText)
  if ($created) {
    try { SafeRollbackNewRoot; Write-Safe 'Rollback removed only verified installer-owned files in the new folder.' }
    catch { Write-Safe 'ROLLBACK REFUSED/FAILED: unverified or newly created folder may remain. Preserve it for owner review; nothing unknown was intentionally deleted.' }
  }
  PublishReport 'REFUSED_OR_ROLLED_BACK'
  exit 2
}
