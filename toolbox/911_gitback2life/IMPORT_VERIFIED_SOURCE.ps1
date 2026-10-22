param(
    [Parameter(Mandatory = $true)]
    [string]$ArchivePath
)
$ErrorActionPreference = "Stop"
$ExpectedArchiveSha256 = "2fe9f2710e780b8f937e335ab2b16e625be9cc24d6769136d9ca0da919d3d5e3"
$ExpectedBuild = "2026-10-20_14TOOLS_EMAIL_COMMUNICATIONS_DRAFT"
$ExpectedSourceFileCount = 206
$ExpectedInnerFileCount = 205
$ExpectedRootFiles = @(
    "BUILD_MANIFEST.json", "BUILD_NOTES.md", "EMAIL_COMMUNICATIONS_REVIEW.patch",
    "README_START_HERE.md", "STAGE_TO_APPROVED_TEMP.cmd",
    "STAGE_TO_APPROVED_TEMP.ps1", "WINDOWS_ACCEPTANCE.mjs"
)
$RequiredTools = @(
    "Incident Management", "Evidence Collection", "Reports & Evidence Packages",
    "Domain Health", "Website Redirect & Authenticity", "Email Security",
    "Account Recovery & Access", "Organization Registers", "Directory Audit",
    "Website Code Analysis", "Dependency Analysis", "File Protection",
    "Computer Security Check", "Email Communications"
)

function Invoke-Git {
    param([Parameter(Mandatory = $true)][string[]]$GitArgs)
    & git @GitArgs
    if ($LASTEXITCODE -ne 0) { throw "git $($GitArgs -join ' ') failed." }
}

$repoRootRaw = & git rev-parse --show-toplevel
if ($LASTEXITCODE -ne 0 -or -not $repoRootRaw) { throw "Run this script from inside your local GitBack2Life repository." }
$repoRoot = [System.IO.Path]::GetFullPath(($repoRootRaw | Select-Object -First 1).Trim())
$origin = (& git -C $repoRoot remote get-url origin | Select-Object -First 1).Trim()
if ($LASTEXITCODE -ne 0 -or $origin -notmatch "gitback2life-art[/:]gitback2life(?:\.git)?$") {
    throw "The local repository origin is not gitback2life-art/gitback2life. No files changed."
}
$status = & git -C $repoRoot status --porcelain
if ($LASTEXITCODE -ne 0) { throw "Could not inspect Git working-tree status." }
if (@($status).Count -gt 0) { throw "Your working tree has uncommitted changes. Commit or safely set them aside first; this script will not overwrite them." }

$archiveFull = (Resolve-Path -LiteralPath $ArchivePath).Path
$actualHash = (Get-FileHash -LiteralPath $archiveFull -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualHash -ne $ExpectedArchiveSha256) {
    throw "Archive hash mismatch. Expected $ExpectedArchiveSha256; got $actualHash. No files imported."
}
$tarExe = Get-Command tar.exe -ErrorAction SilentlyContinue
if (-not $tarExe) { throw "Windows tar.exe is required. No files imported." }

$listing = & $tarExe.Source -tzf $archiveFull
if ($LASTEXITCODE -ne 0) { throw "Could not read tar.gz archive listing." }
$verboseListing = & $tarExe.Source -tvzf $archiveFull
if ($LASTEXITCODE -ne 0) { throw "Could not inspect archive entry types." }
if (@($verboseListing | Where-Object { $_ -match '^[lh]' }).Count -gt 0) {
    throw "Archive contains a symbolic or hard link. Extraction refused."
}
$seen = @{}
foreach ($entry in $listing) {
    $name = ([string]$entry).Trim().TrimEnd("/")
    if (-not $name) { continue }
    if ($name.StartsWith("/") -or $name.Contains("\") -or ($name.Split("/") -contains "..") -or ($name.Split("/") -contains ".")) {
        throw "Unsafe path in archive: $name"
    }
    if ($seen.ContainsKey($name)) { throw "Duplicate archive path: $name" }
    $seen[$name] = $true
    if (($name -notin $ExpectedRootFiles) -and ($name -ne "source") -and ($name -notlike "source/911_gitback2life*")) {
        throw "Unexpected top-level archive content: $name"
    }
}
foreach ($rootFile in $ExpectedRootFiles) {
    if (-not $seen.ContainsKey($rootFile)) { throw "Archive is missing required file $rootFile." }
}
$rootListingFiles = @($listing | Where-Object { $_ -and $_ -notmatch "/$" -and $_ -notmatch "/" })
if ($rootListingFiles.Count -ne $ExpectedRootFiles.Count) {
    throw "Unexpected number of top-level archive files. No files imported."
}

$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("gb2l-verified-source-" + [guid]::NewGuid().ToString("N"))
$packageRoot = Join-Path $tempRoot "package"
$branchName = "import/911-toolbox-source-20261022"
$destination = Join-Path $repoRoot "toolbox\911_gitback2life\distribution"
$staging = Join-Path $repoRoot "toolbox\911_gitback2life\.distribution-import-staging"

try {
    New-Item -ItemType Directory -Path $packageRoot -Force | Out-Null
    & $tarExe.Source -xzf $archiveFull -C $packageRoot
    if ($LASTEXITCODE -ne 0) { throw "Archive extraction failed." }

    $buildManifest = Get-Content -LiteralPath (Join-Path $packageRoot "BUILD_MANIFEST.json") -Raw | ConvertFrom-Json
    if ($buildManifest.build -ne $ExpectedBuild) { throw "Unexpected build identity in BUILD_MANIFEST.json." }
    $outerEntries = @($buildManifest.files)
    if ($outerEntries.Count -ne $ExpectedSourceFileCount) { throw "Outer manifest file count is not $ExpectedSourceFileCount." }

    $sourceRoot = Join-Path $packageRoot "source\911_gitback2life"
    if (-not (Test-Path -LiteralPath $sourceRoot -PathType Container)) { throw "The source/911_gitback2life directory is missing." }
    $outerPaths = @{}
    foreach ($item in $outerEntries) {
        $relative = [string]$item.path
        if (-not $relative -or [System.IO.Path]::IsPathRooted($relative) -or $relative.Contains("\") -or ($relative.Split("/") -contains "..") -or $outerPaths.ContainsKey($relative)) {
            throw "Unsafe or duplicate source manifest path: $relative"
        }
        $outerPaths[$relative] = $true
        $target = Join-Path $sourceRoot ($relative.Replace("/", "\"))
        if (-not (Test-Path -LiteralPath $target -PathType Leaf)) { throw "Manifest file is missing: $relative" }
        $info = Get-Item -LiteralPath $target
        $hash = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($info.Length -ne [long]$item.bytes -or $hash -ne ([string]$item.sha256).ToLowerInvariant()) {
            throw "Outer manifest mismatch: $relative"
        }
    }
    $actualSourceFiles = @(Get-ChildItem -LiteralPath $sourceRoot -File -Recurse -Force)
    if ($actualSourceFiles.Count -ne $ExpectedSourceFileCount) { throw "Actual source-file count differs from outer manifest." }
    $innerPath = Join-Path $sourceRoot "SOURCE_MANIFEST_SHA256.json"
    $inner = Get-Content -LiteralPath $innerPath -Raw | ConvertFrom-Json
    if ($inner.build -ne $ExpectedBuild) { throw "Inner manifest build identity mismatch." }
    $innerProperties = @($inner.files.PSObject.Properties)
    if ($innerProperties.Count -ne $ExpectedInnerFileCount) { throw "Inner manifest file count is not $ExpectedInnerFileCount." }
    foreach ($property in $innerProperties) {
        $relative = [string]$property.Name
        $entry = $property.Value
        $target = Join-Path $sourceRoot ($relative.Replace("/", "\"))
        if (-not (Test-Path -LiteralPath $target -PathType Leaf)) { throw "Inner-manifest file is missing: $relative" }
        $info = Get-Item -LiteralPath $target
        $hash = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($info.Length -ne [long]$entry.bytes -or $hash -ne ([string]$entry.sha256).ToLowerInvariant()) {
            throw "Inner manifest mismatch: $relative"
        }
    }
    $acceptance = Get-Content -LiteralPath (Join-Path $packageRoot "WINDOWS_ACCEPTANCE.mjs") -Raw
    foreach ($tool in $RequiredTools) {
        if (-not $acceptance.Contains($tool)) { throw "14-tool acceptance list is missing: $tool" }
    }
    if (Test-Path -LiteralPath $destination) { throw "Destination already exists. Refusing to overwrite: $destination" }
    if (Test-Path -LiteralPath $staging) { throw "Temporary staging directory already exists. Refusing to overwrite: $staging" }
    $localBranches = & git -C $repoRoot branch --list $branchName
    if (@($localBranches).Count -gt 0) { throw "Local branch $branchName already exists. No files imported." }

    Invoke-Git -GitArgs @("-C", $repoRoot, "fetch", "origin", "main")
    Invoke-Git -GitArgs @("-C", $repoRoot, "checkout", "-b", $branchName, "origin/main")

    New-Item -ItemType Directory -Path $staging | Out-Null
    Get-ChildItem -LiteralPath $packageRoot -Force | ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination $staging -Recurse -Force
    }
    Move-Item -LiteralPath $staging -Destination $destination

    $readme = @'
# 911 GitBack2Life Toolbox — source distribution

This directory contains the individually tracked source files for the 14-tool review build. Read distribution/README_START_HERE.md, distribution/BUILD_NOTES.md, and distribution/source/911_gitback2life/MASTER_TOOL_LIST.md before use.

The source manifests and archive hash were verified during import. This proves package integrity, not production readiness. Native Windows staging/menu acceptance and any live service deployment must still be verified separately.

Email Communications has two separate pieces:
- The Toolbox menu source is in distribution/source/911_gitback2life/email_communications/; its protected HTTPS backend is not deployed by this source package and must remain disabled/unconfigured until separately provisioned and verified.
- The repository-backed outgoing-email adapter is in email_communications/github_actions_adapter/, canonical source tools/gb2l-email/. It uses encrypted GitHub PR requests and the approval_required environment gate. It does not read Gmail inbox messages or replies. Read its AI and owner guides for the current missing gmail.send OAuth grant.
'@
    Set-Content -LiteralPath (Join-Path $repoRoot "toolbox\911_gitback2life\README.md") -Value $readme -Encoding UTF8

    $statusReadme = @'
# 911 GitBack2Life Toolbox — source import and readiness status

The full 14-tool review build 2026-10-20_14TOOLS_EMAIL_COMMUNICATIONS_DRAFT has been imported as normal repository files under distribution/. The import verifies the pinned archive SHA-256 and both file manifests (206 outer source entries and 205 inner-manifest entries), along with all 14 menu labels.

This remains a development/review build. The source archive reports 437 passing and 12 skipped Node tests. Native Windows staging/menu acceptance was not performed by this import.

Local Toolbox Email Communications is source-only; its protected HTTPS backend and credentials are not deployed. The separate repository-backed GitHub email sender is guarded by approval_required, does not read Gmail inboxes, and currently fails no-send readiness because the actual OAuth grant lacks https://www.googleapis.com/auth/gmail.send. Do not send a new test until readiness passes and the owner authorizes a distinct draft. Never retry reserved draft dbd4da02a28c5f2acd9e991b26005f0c.
'@
    Set-Content -LiteralPath (Join-Path $repoRoot "toolbox\911_gitback2life\TOOLBOX_SOURCE_IMPORT_STATUS.md") -Value $statusReadme -Encoding UTF8

    Invoke-Git -GitArgs @("-C", $repoRoot, "add", "--", "toolbox/911_gitback2life/distribution", "toolbox/911_gitback2life/README.md", "toolbox/911_gitback2life/TOOLBOX_SOURCE_IMPORT_STATUS.md")
    Invoke-Git -GitArgs @("-C", $repoRoot, "-c", "user.name=gitback2life-art", "-c", "user.email=339689632+gitback2life-art@users.noreply.github.com", "commit", "-m", "Import complete verified 14-tool 911 Toolbox source")
    Write-Host ""
    Write-Host "SUCCESS: imported and committed the verified 14-tool source to local branch $branchName."
    Write-Host "No email was sent, no Google credentials were changed, and nothing was pushed."
    Write-Host "When ready after the GitHub login switch, push this branch and open a PR:"
    Write-Host "  git push -u origin $branchName"
}
finally {
    if (Test-Path -LiteralPath $tempRoot) { Remove-Item -LiteralPath $tempRoot -Recurse -Force }
}
