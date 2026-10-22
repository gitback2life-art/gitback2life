#!/usr/bin/env python3
"""Import and verify the exact 14-tool review distribution without trusting an archive blindly."""
from __future__ import annotations
import argparse, hashlib, io, json, shutil, stat, sys, tempfile, zipfile
from pathlib import Path, PurePosixPath

EXPECTED_ARCHIVE_SHA256 = "d91ef009c3d5a9e5fb335dd7eaeb8b8cbf91e05fb64f2afd6569bda6a832b9ee"
EXPECTED_BUILD = "2026-10-20_14TOOLS_EMAIL_COMMUNICATIONS_DRAFT"
EXPECTED_SOURCE_FILES = 206
EXPECTED_EMBEDDED_FILES = 205
ROOT_FILES = {
    "BUILD_MANIFEST.json",
    "BUILD_NOTES.md",
    "EMAIL_COMMUNICATIONS_REVIEW.patch",
    "README_START_HERE.md",
    "STAGE_TO_APPROVED_TEMP.cmd",
    "STAGE_TO_APPROVED_TEMP.ps1",
    "WINDOWS_ACCEPTANCE.mjs",
}
PREFIX = "source/911_gitback2life/"

ROOT_README = """# 911 GitBack2Life Toolbox — repository source

This directory is the repository-tracked source distribution for the 14-tool 911 GitBack2Life Toolbox review build. The original build files are kept under distribution/ with their source-relative folder layout and both SHA-256 manifests.

## Start here
1. Read distribution/README_START_HERE.md and distribution/BUILD_NOTES.md.
2. Review distribution/source/911_gitback2life/MASTER_TOOL_LIST.md, TOOLKIT_RULES.md, and CLAUDE.md before an AI runs or changes anything.
3. On Windows, use distribution/STAGE_TO_APPROVED_TEMP.cmd only from an extracted distribution folder. It verifies the package manifests and stages a separate copy; native Windows staging and full menu acceptance still need to be verified on the target computer.
4. A GitHub-connected AI can read the source files directly in this directory. It must preserve the manifest integrity and request explicit authorization before any live or privileged operation.

## Email Communications has two distinct paths
- Local Toolbox menu tool: distribution/source/911_gitback2life/email_communications/. This is a development implementation that expects an owner-protected HTTPS backend. The backend is not deployed or configured by the source package and must remain unavailable for real sending until the owner separately provisions and verifies it.
- Repository-backed AI/GitHub email adapter: email_communications/github_actions_adapter/ and canonical source at tools/gb2l-email/, with workflow templates under its subdirectory. It sends outgoing messages only using protected GitHub Actions approval. It does not read a Gmail inbox or incoming replies. Its current no-send readiness blocker is the actual Google OAuth grant missing gmail.send; see the bundled AI guide and workflow run link there.

Never put Google client JSON, OAuth tokens, refresh tokens, private keys, GitHub control tokens, real drafts, incident-private data, or private approval receipts in this public repository. The public encryption key is distributable; its private counterpart is not.

The archive's hashes prove byte integrity of this source snapshot, not operational readiness. The review build reports 437 passing and 12 skipped Node tests at the supplied snapshot; native Windows GUI/staging acceptance and live Gmail/OAuth deployment were not verified. See BUILD_NOTES.md.
"""

STATUS_README = """# 911 GitBack2Life Toolbox — source import and readiness status

Updated: 2026-10-22.

## Repository source status
The complete source tree from the supplied 14-tool Email Communications review build is now tracked as individual files under toolbox/911_gitback2life/distribution/, including all shared modules, all specialist tools, all menu/UI code, tests, fixtures, launchers, both integrity manifests, the Windows staging files, and the consolidated acceptance script. The importer requires the source archive SHA-256 to match the reviewed ZIP and verifies every manifest entry before importing. CI rechecks the imported source manifests and runs the package's Node test suite.

The imported snapshot is exactly build: 2026-10-20_14TOOLS_EMAIL_COMMUNICATIONS_DRAFT. It is a development/review build, not a statement of production readiness.

## Email status
1. Local Toolbox Email Communications is present at distribution/source/911_gitback2life/email_communications/. Its protected HTTPS backend and credentials were not deployed by this package. Live local-tool sending must remain disabled/unconfigured.
2. The separate repository-backed AI email adapter is present at email_communications/github_actions_adapter/ and canonical source remains at tools/gb2l-email/. It is a guarded outgoing-send path via encrypted request comments and GitHub environment approval; it does not read Gmail inboxes/replies.
3. The current GitHub Actions sender readiness check is blocked because the actual Google OAuth access token grant lacks https://www.googleapis.com/auth/gmail.send. See https://github.com/gitback2life-art/gitback2life/actions/runs/39813519317. Mode must remain approval_required.
4. The prior reserved email draft ID dbd4da02a28c5f2acd9e991b26005f0c had an uncertain HTTP 403 outcome and must never be retried or reused. A fresh email test requires a new ID and separate explicit owner authorization.

## Verification limits
- The source archive's embedded and outer SHA-256 manifests were verified before import.
- The Node offline test suite runs in CI under the package's network-denial harness.
- Native Windows staging and menu acceptance were not run on the owner's computer as part of this import.
- The legacy full Python test suite was not treated as passing; the build notes identify a Windows-only _winapi import and two existing deployment payload count expectations that fail in the Linux review environment.
- Importing source files does not deploy services, provision credentials, activate protected authority operations, or authorize live email.
"""

def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest().lower()

def validate_manifest(source_root: Path, build_manifest_path: Path) -> tuple[int, int]:
    build = json.loads(build_manifest_path.read_text(encoding="utf-8"))
    if build.get("build") != EXPECTED_BUILD:
        raise ValueError("Build manifest is not the expected 14-tool review build.")
    entries = build.get("files")
    if not isinstance(entries, list) or len(entries) != EXPECTED_SOURCE_FILES:
        raise ValueError("Unexpected outer manifest file count.")
    outer = {}
    for item in entries:
        rel = item.get("path")
        if not isinstance(rel, str) or not rel or rel.startswith("/") or "\\" in rel:
            raise ValueError("Invalid path in build manifest.")
        pp = PurePosixPath(rel)
        if any(part in ("", ".", "..") for part in pp.parts):
            raise ValueError("Unsafe path in build manifest.")
        if rel in outer:
            raise ValueError("Duplicate build manifest path: " + rel)
        outer[rel] = item
        target = source_root.joinpath(*pp.parts)
        if not target.is_file():
            raise ValueError("Missing source file: " + rel)
        raw = target.read_bytes()
        if len(raw) != item.get("bytes") or digest(raw) != str(item.get("sha256", "")).lower():
            raise ValueError("Outer manifest mismatch: " + rel)
    actual = {p.relative_to(source_root).as_posix() for p in source_root.rglob("*") if p.is_file()}
    if actual != set(outer):
        raise ValueError("Source-tree paths differ from outer manifest (expected %d, got %d)." % (len(outer), len(actual)))

    inner_path = source_root / "SOURCE_MANIFEST_SHA256.json"
    inner = json.loads(inner_path.read_text(encoding="utf-8"))
    if inner.get("build") != EXPECTED_BUILD or not isinstance(inner.get("files"), dict):
        raise ValueError("Inner source manifest identity or format mismatch.")
    inner_files = inner["files"]
    if len(inner_files) != EXPECTED_EMBEDDED_FILES:
        raise ValueError("Unexpected inner manifest file count.")
    outer_minus_self = set(outer) - {"SOURCE_MANIFEST_SHA256.json"}
    if set(inner_files) != outer_minus_self:
        raise ValueError("Inner and outer manifests enumerate different source files.")
    for rel, item in inner_files.items():
        target = source_root.joinpath(*PurePosixPath(rel).parts)
        if not target.is_file():
            raise ValueError("Inner manifest file missing: " + rel)
        raw = target.read_bytes()
        if len(raw) != item.get("bytes") or digest(raw) != str(item.get("sha256", "")).lower():
            raise ValueError("Inner manifest mismatch: " + rel)

    acceptance = (source_root.parent.parent.parent / "WINDOWS_ACCEPTANCE.mjs")
    # This path is checked separately by verify_distribution once the outer package root is known.
    return len(outer), len(inner_files)

def verify_distribution(destination: Path) -> dict:
    if not destination.is_dir():
        raise ValueError("Distribution folder is missing.")
    missing = sorted(name for name in ROOT_FILES if not (destination / name).is_file())
    if missing:
        raise ValueError("Distribution root is missing required build files: " + ", ".join(missing))
    source_root = destination / "source" / "911_gitback2life"
    outer_count, inner_count = validate_manifest(source_root, destination / "BUILD_MANIFEST.json")
    acceptance = (destination / "WINDOWS_ACCEPTANCE.mjs").read_text(encoding="utf-8")
    for name in [
        "Incident Management", "Evidence Collection", "Reports & Evidence Packages",
        "Domain Health", "Website Redirect & Authenticity", "Email Security",
        "Account Recovery & Access", "Organization Registers", "Directory Audit",
        "Website Code Analysis", "Dependency Analysis", "File Protection",
        "Computer Security Check", "Email Communications"
    ]:
        if name not in acceptance:
            raise ValueError("Windows acceptance script does not name expected tool: " + name)
    return {"outer_files": outer_count, "inner_files": inner_count}

def unpack_and_import(payload_dir: Path, destination: Path, repo_root: Path) -> None:
    if destination.exists():
        raise ValueError("Destination already exists; refusing to overwrite: " + str(destination))
    if not payload_dir.is_dir():
        raise ValueError("The source payload directory is missing: " + str(payload_dir))

    expected_name = "911_GitBack2Life_Email_Communications_Review_Build_20261020.zip"
    payload_items = list(payload_dir.iterdir())
    allowed_names = {expected_name, "UPLOAD_INSTRUCTIONS.md"}
    payload_names = {item.name for item in payload_items}
    if expected_name not in payload_names or payload_names - allowed_names:
        raise ValueError(
            "Payload directory must contain the exact reviewed ZIP and, optionally, "
            "UPLOAD_INSTRUCTIONS.md; found: " + ", ".join(sorted(payload_names))
        )
    if any(item.is_symlink() or not item.is_file() for item in payload_items):
        raise ValueError("Payload entries must be regular files, not links or directories.")
    archive_path = payload_dir / expected_name
    if archive_path.is_symlink() or not archive_path.is_file():
        raise ValueError("Source archive must be a regular file, not a link.")
    archive_bytes = archive_path.read_bytes()
    if digest(archive_bytes) != EXPECTED_ARCHIVE_SHA256:
        raise ValueError("Archive SHA-256 differs from the pinned review build; no files imported.")

    with tempfile.TemporaryDirectory(prefix="gb2l-source-import-") as temp_name:
        unpack = Path(temp_name) / "unpack"
        unpack.mkdir()
        with zipfile.ZipFile(io.BytesIO(archive_bytes), mode="r") as zf:
            if zf.testzip() is not None:
                raise ValueError("Source ZIP failed its CRC/integrity check.")
            infos = zf.infolist()
            seen = set()
            files = []
            for info in infos:
                name = info.filename
                pp = PurePosixPath(name)
                if (
                    not name
                    or name.startswith("/")
                    or "\\" in name
                    or "\x00" in name
                    or pp.is_absolute()
                    or any(part in ("", ".", "..") for part in pp.parts)
                ):
                    raise ValueError("Unsafe archive path.")
                if name in seen:
                    raise ValueError("Duplicate archive path: " + name)
                seen.add(name)
                if info.is_dir():
                    raise ValueError("Unexpected directory entry in reviewed archive: " + name)
                if info.flag_bits & 0x1:
                    raise ValueError("Encrypted ZIP entries are not allowed.")
                unix_mode = (info.external_attr >> 16) & 0xFFFF
                file_type = stat.S_IFMT(unix_mode)
                if file_type not in (0, stat.S_IFREG):
                    raise ValueError("Non-regular ZIP entry is not allowed: " + name)
                if name not in ROOT_FILES and not name.startswith(PREFIX):
                    raise ValueError("Unexpected file outside the source package: " + name)
                files.append(info)

            names = [info.filename for info in files]
            if {name for name in names if "/" not in name} != ROOT_FILES:
                raise ValueError("Archive root-file list differs from the reviewed package.")
            if len(names) != EXPECTED_SOURCE_FILES + len(ROOT_FILES):
                raise ValueError("Unexpected archive file count.")
            if sum(name.startswith(PREFIX) for name in names) != EXPECTED_SOURCE_FILES:
                raise ValueError("Unexpected source-tree file count.")

            for info in files:
                out = unpack.joinpath(*PurePosixPath(info.filename).parts)
                out.parent.mkdir(parents=True, exist_ok=True)
                with zf.open(info, "r") as source, out.open("xb") as target:
                    shutil.copyfileobj(source, target)
                if out.stat().st_size != info.file_size:
                    raise ValueError("Extracted file size mismatch: " + info.filename)

        source_root = unpack / "source" / "911_gitback2life"
        counts = validate_manifest(source_root, unpack / "BUILD_MANIFEST.json")
        if counts != (EXPECTED_SOURCE_FILES, EXPECTED_EMBEDDED_FILES):
            raise ValueError("Unexpected verified manifest counts.")
        if (unpack / "EMAIL_COMMUNICATIONS_REVIEW.patch").stat().st_size == 0:
            raise ValueError("Review patch unexpectedly empty.")
        acceptance = (unpack / "WINDOWS_ACCEPTANCE.mjs").read_text(encoding="utf-8")
        if "Email Communications" not in acceptance:
            raise ValueError("The 14th Email Communications group is missing.")
        destination.parent.mkdir(parents=True, exist_ok=True)
        staging = destination.parent / ".distribution-import-staging"
        if staging.exists():
            raise ValueError("Staging destination already exists; refusing to overwrite.")
        shutil.copytree(unpack, staging)
        staging.rename(destination)

    (repo_root / "toolbox" / "911_gitback2life" / "README.md").write_text(ROOT_README, encoding="utf-8")
    (repo_root / "toolbox" / "911_gitback2life" / "TOOLBOX_SOURCE_IMPORT_STATUS.md").write_text(STATUS_README, encoding="utf-8")
    shutil.rmtree(payload_dir)
    result = verify_distribution(destination)
    print("PASS: imported exact verified review ZIP; outer files=%d, inner files=%d, menu groups=14." % (result["outer_files"], result["inner_files"]))
    print("Archive SHA-256: " + EXPECTED_ARCHIVE_SHA256)
    print("No live email operation or credential provisioning was performed.")

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--payload-dir", type=Path)
    ap.add_argument("--destination", type=Path, default=Path("toolbox/911_gitback2life/distribution"))
    ap.add_argument("--repo-root", type=Path, default=Path("."))
    ap.add_argument("--verify-only", action="store_true")
    args = ap.parse_args()
    repo_root = args.repo_root.resolve()
    destination = (repo_root / args.destination).resolve() if not args.destination.is_absolute() else args.destination.resolve()
    try:
        if args.verify_only:
            result = verify_distribution(destination)
            print("PASS: distribution manifests and 14-tool acceptance list verified; outer files=%d, inner files=%d." % (result["outer_files"], result["inner_files"]))
        else:
            if args.payload_dir is None:
                raise ValueError("--payload-dir is required unless --verify-only is used.")
            payload = (repo_root / args.payload_dir).resolve() if not args.payload_dir.is_absolute() else args.payload_dir.resolve()
            unpack_and_import(payload, destination, repo_root)
        return 0
    except Exception as exc:
        print("Toolbox source import/verification failed: " + str(exc), file=sys.stderr)
        return 1

if __name__ == "__main__":
    raise SystemExit(main())
