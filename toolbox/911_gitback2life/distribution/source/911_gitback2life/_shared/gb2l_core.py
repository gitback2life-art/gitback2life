"""Shared helpers for the Python tools in this toolbox.

Adapted from the gitback2life security suite core: bounded labels, safe path selection that rejects
symlinks/traversal and sensitive locations before reading, atomic JSON writes, and the shared
pass/fail/unresolved report contract. Writes are additionally restricted to the toolbox folder.
"""
import datetime as dt
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import struct
import sys
import tempfile

TOOLBOX_ROOT = Path(__file__).resolve().parents[1]


class InputError(ValueError):
    pass


def require(condition, message='Input does not match the documented schema'):
    if not condition:
        raise InputError(message)


def keys(data, required, optional=()):
    require(isinstance(data, dict) and set(required) <= set(data) and
            set(data) <= set(required) | set(optional),
            f'Expected fields {sorted(required)} (optional {sorted(optional)})')


EMAIL = re.compile(r'[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}')
PHONE = re.compile(r'(?<!\d)(\+?\d{1,3}[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}(?!\d)')


def label(value, limit=160):
    require(isinstance(value, str) and 0 < len(value) <= limit and
            re.fullmatch(r"[A-Za-z0-9_./:# @+\-=(),*~^<>'&]+", value) is not None,
            'Use bounded metadata labels, not raw content')
    # Toolkit rule: record roles, never people's contact details.
    require(not EMAIL.search(value) and not PHONE.search(value),
            'Looks like an email address or phone number; record a role (e.g. board_secretary) instead')
    return value


def identifier(value):
    require(isinstance(value, str) and re.fullmatch(r'[a-zA-Z0-9_-]{1,80}', value), f'Bad identifier: {value!r}')
    return value


def timestamp(value):
    require(isinstance(value, str), 'Timestamp must be a string')
    parsed = dt.datetime.fromisoformat(value.replace('Z', '+00:00'))
    require(parsed.tzinfo is not None, 'Timestamp requires timezone')
    return parsed.astimezone(dt.timezone.utc)


def now():
    return dt.datetime.now(dt.timezone.utc).isoformat()


def no_links(path):
    path = Path(os.path.abspath(path))
    for part in [path, *path.parents]:
        if part.exists() or part.is_symlink():
            s = part.lstat()
            require(not stat.S_ISLNK(s.st_mode) and not
                    (getattr(s, 'st_file_attributes', 0) & 0x400),
                    'Symlink or reparse-point path rejected')
    return path


# Folders/files never read or written. Includes the personal data small organizations commonly hold.
DENIED = {'node_modules', '.git', '.aws', '.ssh', '.env', '.dev.vars', 'secrets', 'wallet', 'wallets',
          'customer', 'customers', 'uploads', 'donor', 'donors', 'adopter', 'adopters', 'volunteer', 'volunteers'}
SENSITIVE_NAME = re.compile(r'(private.?key|secret|credential|password|wallet|recovery.?code|donor|adopter|vault)', re.I)
SENSITIVE_SUFFIX = {'.pem', '.key', '.p12', '.pfx', '.keystore', '.db', '.sqlite', '.kdbx'}


def metadata_path(path):
    path = no_links(path)
    require(not any(part.lower() in DENIED or part.lower().startswith(('.env', '.dev.vars')) for part in path.parts)
            and not SENSITIVE_NAME.search(path.name),
            'Sensitive path rejected before reading')
    require(path.suffix.lower() not in SENSITIVE_SUFFIX, 'Sensitive file type rejected before reading')
    return path


def relative(value):
    require(isinstance(value, str) and '\\' not in value and ':' not in value, 'Use forward-slash relative paths')
    p = PurePosixPath(value)
    require(not p.is_absolute() and value not in ('', '.') and
            all(x not in ('', '.', '..') for x in value.split('/')), 'Path traversal rejected')
    reserved = {'con', 'prn', 'aux', 'nul', *('com' + str(i) for i in range(1, 10)), *('lpt' + str(i) for i in range(1, 10))}
    require(all(not x.endswith(('.', ' ')) and x.split('.')[0].lower() not in reserved and
                not any(ch in x for ch in '\x00<>"|?*') for x in p.parts), 'Ambiguous Windows path rejected')
    require(not any(x.lower() in DENIED or x.lower().startswith(('.env', '.dev.vars')) or SENSITIVE_NAME.search(x)
                    for x in p.parts), 'Sensitive path excluded before reading')
    require(p.suffix.lower() not in SENSITIVE_SUFFIX, 'Sensitive file type excluded')
    return value


def selected(root, value):
    root = metadata_path(root).resolve()
    value = relative(value)
    path = no_links(root / value)
    require(path.resolve().is_relative_to(root) and path.is_file(), f'Selected file not inside source root: {value}')
    return path


def load(path, limit=2_000_000):
    path = metadata_path(path)
    require(path.is_file() and path.stat().st_size <= limit, 'Input missing or exceeds size budget')
    return json.loads(path.read_text(encoding='utf-8-sig'))


def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(65536), b''):
            h.update(chunk)
    return h.hexdigest()


def inside_toolbox(path):
    path = Path(os.path.abspath(path))
    require(path.is_relative_to(TOOLBOX_ROOT), f'Writes are limited to the toolbox folder ({TOOLBOX_ROOT})')
    return path


def contained(path):
    """A path inside the toolbox with no symlink, junction or other reparse point in any existing component."""
    return no_links(inside_toolbox(path))


def _require_real_inside(path):
    """The link-resolved location must still be inside the link-resolved toolbox root."""
    real_root = Path(os.path.realpath(TOOLBOX_ROOT))
    real = Path(os.path.realpath(path))
    require(real == real_root or real.is_relative_to(real_root), 'Destination really resolves outside the toolbox')


def make_dirs(path):
    """Create a folder inside the toolbox one level at a time, refusing links before and after each step."""
    target = contained(path)
    missing = []
    probe = target
    while not probe.exists():
        missing.append(probe)
        probe = probe.parent
    _require_real_inside(probe)
    for d in reversed(missing):
        d.mkdir()
        no_links(d)
        _require_real_inside(d)
    return target


def write_bytes_safely(path, data, overwrite=False, binary=None, require_unchanged=False):
    """Write bytes inside the toolbox. New files are created exclusively. An overwrite writes a temporary file and
    replaces the directory entry, so an existing file (including one hard-linked elsewhere) is never truncated.
    #10: the content is masked (or refused) BEFORE anything, including the temporary file, touches disk."""
    recheck_scope()  # F12: a scope stopped or expired while this command ran blocks the write
    data = prepare_for_storage(data, binary=binary, require_unchanged=require_unchanged)
    target = contained(path)
    make_dirs(target.parent)
    _require_real_inside(target.parent)
    if not overwrite:
        require(not target.exists(), f'Refusing to overwrite an existing file: {target.name}')
        fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_BINARY', 0))
        with os.fdopen(fd, 'wb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        return target
    if target.exists():  # F05: same rule as safeWrite; a second name may sit outside the toolbox
        require(target.is_file(), f'Refusing to overwrite something that is not a regular file: {target.name}')
        require(os.lstat(target).st_nlink <= 1, f'Refusing to overwrite a hardlinked file (it has other names): {target.name}')
    fd, temp = tempfile.mkstemp(dir=target.parent, prefix='.gitback2life-', suffix='.tmp')
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        no_links(target)  # re-check immediately before replacing
        os.replace(temp, target)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)
    return target


def write(path, data):
    """Write JSON inside the toolbox (replacing an existing file atomically)."""
    path = metadata_path(contained(path))
    require(path.parent.is_dir(), 'Output parent must already exist')
    write_bytes_safely(path, (json.dumps(data, indent=2, allow_nan=False) + '\n').encode('utf-8'), overwrite=True)


def refuse_unapproved_update(tool, register, proposed):
    """V7-01: every update requires an authorized human's approval tied to the exact target and the exact change
    (TOOLKIT_RULES 1e). That enforcement does not exist yet, so update commands NEVER write: they validate the change
    (the caller already did, via register_update) and refuse, naming the exact change for a person to apply by hand."""
    digest = hashlib.sha256((json.dumps(proposed, indent=2, allow_nan=False) + '\n').encode('utf-8')).hexdigest()
    raise InputError(f'{tool} update is disabled: changing a register needs an authorized person\'s approval for this exact '
                     f'file and change, and that check is not implemented yet (TOOLKIT_RULES 1e). Nothing was written. '
                     f'The change is valid; proposed register sha256 {digest}. A person may apply it to {Path(register).name} by hand.')


def check(cid, result, category, reference=None):
    require(result in {'pass', 'fail', 'unresolved', 'not_applicable'})
    return dict(id=identifier(cid), result=result, category=identifier(category), reference=reference)


def report(tool, checks, version='unknown', environment='offline', **details):
    label(version)
    label(environment)
    states = [c['result'] for c in checks]
    result = 'fail' if 'fail' in states else ('unresolved' if not states or 'unresolved' in states else 'pass')
    return dict(schema_version=1, tool_version='1.0.0', tool=identifier(tool), observed_at=now(),
                source_version=version, environment=environment, result=result, checks=checks, **details)


# F12: the one scope contract, shared with _shared/scope.mjs (which reads the same file).
SCOPE_SCHEMA = json.loads((Path(__file__).resolve().parent / 'scope_schema.json').read_text(encoding='utf-8'))
_HOST = re.compile(r'^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$')  # same rule as targetKey() in scope.mjs
_active_scope = None  # (path, action) of the command that is running; every write re-checks it


def target_key(raw):
    """Mirror of targetKey() in scope.mjs: ('repo', 'owner/repo') or ('host', 'example.org'), else None.
    Parsed with a regex on purpose: the toolkit rules forbid importing urllib (or any network module) in Python tools."""
    s = str(raw if raw is not None else '').strip()
    if not s:
        return None
    url = re.match(r'^[a-z][a-z0-9+.-]*://([^/?#]*)([^?#]*)', s, re.I)
    if url:
        host = url.group(1).rsplit('@', 1)[-1].split(':', 1)[0].lower()  # drop user:password@ and :port
        if host == 'github.com':
            parts = [p for p in url.group(2).split('/') if p]
            return ('repo', f'{parts[0]}/{parts[1]}'.lower()) if len(parts) >= 2 else ('host', 'github.com')
    elif re.match(r'^[\w-]+/[\w.-]+$', s):
        return ('repo', s.lower())
    host = (host if url else s.split('/')[0]).lower()
    host = host[:-1] if host.endswith('.') else host  # ONE trailing dot, like Node (rstrip accepted "example.org..")
    host = host[4:] if host.startswith('www.') else host
    return ('host', host) if _HOST.match(host) else None


def validate_scope(s):
    """Same checks as validateScope() in scope.mjs, from the same scope_schema.json. Returns a list of problems."""
    if not isinstance(s, dict):
        return ['the scope must be a JSON object']
    errors = []
    if 'scope_schema' in s and s['scope_schema'] != SCOPE_SCHEMA['scope_schema']:
        errors.append(f'scope_schema {s["scope_schema"]} is not supported (this toolbox reads schema {SCOPE_SCHEMA["scope_schema"]})')
    for key in SCOPE_SCHEMA['required_text']:
        if not isinstance(s.get(key), str) or not s[key].strip():
            errors.append(f'{key} is required')
    targets = s.get('targets')
    if not isinstance(targets, list) or not targets:
        errors.append('targets must list at least one domain, URL or owner/repo')
    else:
        errors += [f'target "{t}" is not a domain, URL or owner/repo' for t in targets if not target_key(t)]
    for key in ('status', 'urgency', 'confidence', 'persistence'):
        if s.get(key) not in SCOPE_SCHEMA[key]:
            errors.append(f'{key} must be {"|".join(SCOPE_SCHEMA[key])}')
    try:
        timestamp(s.get('expires_at'))
    except (InputError, TypeError, ValueError):
        errors.append('expires_at is required (ISO time); scopes are time-limited')
    if not isinstance(s.get('prohibited'), list) or not s['prohibited']:
        errors.append('prohibited must list at least one action')
    if 'deny_actions' in s and (not isinstance(s['deny_actions'], list) or any(a not in SCOPE_SCHEMA['actions'] for a in s['deny_actions'])):
        errors.append('deny_actions must list action names')
    if 'allow_derived_lookalikes' in s and not isinstance(s['allow_derived_lookalikes'], bool):
        errors.append('allow_derived_lookalikes must be true/false')
    disclosures = s.get('disclosures')
    if not isinstance(disclosures, list):
        errors.append('disclosures must list which outside services may see the targets (may be empty)')
    else:
        errors += [f'unknown disclosure service "{d}"' for d in disclosures if d not in SCOPE_SCHEMA['services']]
    permissions = s.get('permissions', {})
    if not isinstance(permissions, dict):
        errors.append('permissions must be an object')
    else:
        for action, value in permissions.items():
            if action not in SCOPE_SCHEMA['actions']:
                errors.append(f'unknown permission "{action}"')
            if not isinstance(value, bool):
                errors.append(f'permission {action} must be true/false')
    for a in s.get('approvals') or []:
        if not isinstance(a, dict):
            errors.append('each attestation must be an object')
            continue
        if a.get('action') not in SCOPE_SCHEMA['actions']:
            errors.append(f'attestation for unknown action "{a.get("action")}"')
        if not isinstance(a.get('target'), str) or not a['target']:
            errors.append(f'attestation for {a.get("action")} needs the exact target it covers')
        if 'approved_via' in a or 'check' in a:
            errors.append(f'old-style approval for {a.get("action")} claims human-only approval, which the toolbox cannot verify')
        if a.get('attested_by') != 'operator':
            errors.append(f'attestation for {a.get("action")} must say attested_by: "operator"')
        try:
            timestamp(a.get('attested_at'))
        except (InputError, TypeError, ValueError):
            errors.append(f'attestation for {a.get("action")} needs attested_at (ISO time)')
    return errors


# ---- Protected authority (F01; pre-install review finding 3: Python must enforce it too) -----------------------------
AUTHORITY_DIR = r'C:\ProgramData\gitback2life-authority'
AUTHORITY_FILES = ('authority_core.mjs', 'authority_cli.mjs', 'public_key.pem', 'state.json', 'authorizations')
PROTECTED_NODE = r'C:\Program Files\nodejs\node.exe'  # fixed path: a "node" earlier on PATH is never used
# V6-03: the system PowerShell by fixed path, with a constructed environment (same as _shared/system_exec.mjs).
_WINDOWS = r'C:\Windows'
POWERSHELL = _WINDOWS + r'\System32\WindowsPowerShell\v1.0\powershell.exe'
_ADMIN_OWNERS = ('BUILTIN\\Administrators', 'NT AUTHORITY\\SYSTEM')
_NODE_OWNERS = _ADMIN_OWNERS + ('NT SERVICE\\TrustedInstaller',)
_TRUSTED_WRITERS = ('BUILTIN\\Administrators', 'NT AUTHORITY\\SYSTEM', 'NT SERVICE\\TrustedInstaller')
# V6-05: a closed list of read-only rights, plus the numeric mask's known read bits (same as acl_check.mjs).
_READ_ONLY_RIGHTS = ('ReadData', 'ListDirectory', 'ReadExtendedAttributes', 'ExecuteFile', 'Traverse', 'ReadAttributes',
                     'ReadPermissions', 'Synchronize', 'Read', 'ReadAndExecute')
_READ_BITS = 0x1 | 0x8 | 0x20 | 0x80 | 0x20000 | 0x100000 | 0x20000000 | 0x80000000
_authority = {'dir': AUTHORITY_DIR, 'check_acl': True, 'node': PROTECTED_NODE}
_legacy_notice_shown = False


def trusted_env():
    """The only environment a trust-related child process gets: system folders, nothing the user account chose."""
    return {'SystemRoot': _WINDOWS, 'windir': _WINDOWS, 'SystemDrive': 'C:',
            'PATH': _WINDOWS + r'\System32;' + _WINDOWS + ';' + _WINDOWS + r'\System32\WindowsPowerShell\v1.0',
            'PSModulePath': _WINDOWS + r'\System32\WindowsPowerShell\v1.0\Modules', 'TEMP': _WINDOWS + r'\Temp', 'TMP': _WINDOWS + r'\Temp'}


def _set_authority_for_tests(directory, check_acl=False, node=None):
    """Tests only: a temporary authority folder; optionally skip the Windows ACL query. Never used by tools."""
    _authority.update(dir=str(directory), check_acl=check_acl, node=node or PROTECTED_NODE)


def _reset_authority():
    _authority.update(dir=AUTHORITY_DIR, check_acl=True, node=PROTECTED_NODE)


def rights_are_read_only(rights, mask=None):
    if not isinstance(rights, str):
        return False
    tokens = [t.strip() for t in rights.split(',') if t.strip()]
    if not tokens or not all(t in _READ_ONLY_RIGHTS for t in tokens):
        return False
    if mask is not None:
        if isinstance(mask, bool) or not isinstance(mask, int) or mask < 0:
            return False
        if mask & ~_READ_BITS & 0xFFFFFFFF:
            return False
    return True


def acl_problems(acl, label='location', owners=_ADMIN_OWNERS):
    """Same rules as aclProblems() in _shared/acl_check.mjs: missing, malformed or unrecognised data fails closed."""
    if not isinstance(acl, dict):
        return [f'{label}: permission details could not be read']
    if acl.get('exists') is not True:
        return [f'{label}: missing']
    p = []
    if acl.get('reparse') is not False:
        p.append(f'{label}: ' + ('is a link (reparse point)' if acl.get('reparse') is True else 'link status could not be read'))
    owner = acl.get('owner')
    if not isinstance(owner, str) or not owner:
        p.append(f'{label}: owner could not be read')
    elif owner not in owners:
        p.append(f'{label}: owner is {owner}, not Administrators or SYSTEM')
    aces = acl.get('aces')
    if not isinstance(aces, list) or not aces:
        p.append(f'{label}: no permission entries could be read')
    else:
        for ace in aces:
            if (not isinstance(ace, dict) or not isinstance(ace.get('identity'), str) or not ace.get('identity')
                    or not isinstance(ace.get('rights'), str) or ace.get('type') not in ('Allow', 'Deny')):
                p.append(f'{label}: a permission entry could not be read')
                continue
            if ace['type'] == 'Allow' and ace['identity'] not in _TRUSTED_WRITERS and not rights_are_read_only(ace['rights'], ace.get('mask')):
                extra = f", mask {ace['mask']}" if 'mask' in ace else ''
                p.append(f"{label}: {ace['identity']} has rights that are not provably read-only ({ace['rights'] or 'empty'}{extra})")
    return p


def _read_acls(paths, run=None):
    import subprocess
    quoted = ', '.join("'" + x.replace("'", "''") + "'" for x in paths)
    script = '\n'.join([
        "$ErrorActionPreference = 'Stop'", f'$paths = @({quoted})', '$out = @{}',
        'foreach ($p in $paths) {',
        '  if (-not (Test-Path -LiteralPath $p)) { $out[$p] = @{ exists = $false }; continue }',
        '  $i = Get-Item -LiteralPath $p -Force; $a = Get-Acl -LiteralPath $p',
        '  $out[$p] = @{ exists = $true; reparse = [bool]($i.Attributes -band [IO.FileAttributes]::ReparsePoint); owner = [string]$a.Owner',
        '    aces = @($a.Access | ForEach-Object { @{ identity = [string]$_.IdentityReference; rights = [string]$_.FileSystemRights; mask = [int64]$_.FileSystemRights.value__; type = [string]$_.AccessControlType } }) }',
        '}', '$out | ConvertTo-Json -Depth 5'])
    if run is None:
        require(os.path.isfile(POWERSHELL), f'the system PowerShell was not found at {POWERSHELL}')
        run = subprocess.run
    out = run([POWERSHELL, '-NoProfile', '-NonInteractive', '-Command', script], capture_output=True, text=True, timeout=120,
              env=trusted_env(), cwd=_WINDOWS + r'\System32')
    require(out.returncode == 0, 'the authority folder permissions could not be read')
    return json.loads(out.stdout)


def _check_authority(scope_bytes):
    """None when no authority exists at the fixed path. Otherwise the EXACT scope bytes the caller decided on (V6-01)
    are verified by the PROTECTED verifier, which runs only after this module has checked (itself) that the folder,
    its files and node.exe are admin-only. V6-07: only a genuinely absent path means "not installed"; a regular
    file, a link or an unreadable entry there is refused, never treated as absent."""
    import subprocess
    import stat as _stat
    global _legacy_notice_shown
    directory = _authority['dir']
    try:
        st = os.lstat(directory)
    except FileNotFoundError:
        if not _legacy_notice_shown:
            _legacy_notice_shown = True
            print('(protected authority NOT installed: operator attestations only)', file=sys.stderr)
        return None
    except OSError as e:
        raise InputError(f'the protected authority path could not be examined ({e.__class__.__name__})') from None
    attrs = getattr(st, 'st_file_attributes', 0)
    is_link = _stat.S_ISLNK(st.st_mode) or bool(attrs & getattr(_stat, 'FILE_ATTRIBUTE_REPARSE_POINT', 0x400))
    require(not is_link, f'the protected authority path {directory} is a link; refusing')
    require(_stat.S_ISDIR(st.st_mode), f'the protected authority path {directory} exists but is not a folder; refusing')
    node = _authority['node']
    if _authority['check_acl']:
        parent = os.path.dirname(directory)
        targets = [directory] + [os.path.join(directory, f) for f in AUTHORITY_FILES]
        try:
            acls = _read_acls([parent, node] + targets)
        except (OSError, ValueError, InputError) as e:
            raise InputError(f'the protected authority folder is not trustworthy: permissions unreadable ({e})') from None
        problems = []
        prec = acls.get(parent) or {}
        if prec.get('exists') is not True or prec.get('reparse') is not False:
            problems.append(f'{parent}: missing, a link, or unreadable')
        problems += acl_problems(acls.get(node), node, owners=_NODE_OWNERS)
        for t in targets:
            problems += acl_problems(acls.get(t), t)
        require(not problems, 'the protected authority folder is not trustworthy: ' + '; '.join(problems))
    require(os.path.isfile(node), f'the protected verifier needs {node}')
    env = trusted_env()  # V6-03: no NODE_OPTIONS or anything else the user account chose
    r = subprocess.run([node, os.path.join(directory, 'authority_cli.mjs'), 'verify', '-'], input=scope_bytes,
                       capture_output=True, timeout=60, env=env, cwd=directory)
    out = (r.stdout + r.stderr).decode('utf-8', 'replace')
    require(r.returncode == 0, 'blocked by the protected authority: ' + ' '.join(out.split())[:600])
    return True


def _authorize_file(path, action):
    # V6-01: the scope is read ONCE. These exact bytes are both validated here and sent to the protected verifier;
    # re-reading the path for the signature check would let a swap between the two reads pass a different scope.
    data = Path(path).read_bytes()
    require(len(data) <= 2_000_000, 'the scope file is too large')
    s = json.loads(data.decode('utf-8'))
    errors = validate_scope(s)
    require(not errors, 'the incident scope is invalid: ' + '; '.join(errors))
    require(s['status'] == 'open', 'the incident scope is stopped; start a new scope to continue')
    require(timestamp(s['expires_at']) > dt.datetime.now(dt.timezone.utc), 'the incident scope has expired; start a new scope to continue')
    require((s.get('permissions') or {}).get(action) is True, f'"{action}" is not permitted in this scope')
    require(action not in (s.get('deny_actions') or []), f'"{action}" is listed in deny_actions; nothing overrides that')
    if action == 'save_local':
        require(s.get('persistence') == 'local', 'the scope says persistence is "transient": nothing may be saved')
    _check_authority(data)  # F01: also at every later write (recheck_scope calls this function)
    return s

def require_scope(path, action='save_local'):
    """Same contract as _shared/scope.mjs (shared scope_schema.json): a complete, valid, open, unexpired incident scope
    that permits the action; for saving, persistence must be "local". The scope then stays active: every later write
    re-reads the file and re-checks it, so a stop or expiry during the command blocks the next save (F12)."""
    global _active_scope
    require(path, 'this command saves incident data and needs --scope <scope.json> (create one with incident_intake template)')
    s = _authorize_file(path, action)
    _active_scope = (path, action)
    print(f'(scope "{s.get("incident_id")}": {action} allowed)', file=sys.stderr)
    return s


def clear_active_scope():
    global _active_scope
    _active_scope = None


def recheck_scope():
    """Re-read and re-check the active scope (no-op when no command has authorized one)."""
    if _active_scope:
        try:
            _authorize_file(*_active_scope)
        except InputError as e:
            raise InputError(f'scope re-check failed, so nothing more is saved: {e}') from None


_TEXT_SECRETS = [
    (re.compile(r'\b(authorization|proxy-authorization|cookie|set-cookie|x-api-key)(\s*[:=]\s*)[^\r\n]*', re.I), r'\1\2[REDACTED]'),
    (re.compile(r'\bBearer\s+[A-Za-z0-9._~+/=-]{16,}'), 'Bearer [REDACTED]'),
    (re.compile(r'\bgh[pousr]_[A-Za-z0-9]{20,}\b'), '[REDACTED_GITHUB_TOKEN]'),
    (re.compile(r'\bgithub_pat_[A-Za-z0-9_]{20,}\b'), '[REDACTED_GITHUB_TOKEN]'),
    (re.compile(r'\b(?:AKIA|ASIA)[A-Z0-9]{16}\b'), '[REDACTED_AWS_KEY]'),
    (re.compile(r'\bxox[abprs]-[A-Za-z0-9-]{10,}\b'), '[REDACTED_SLACK_TOKEN]'),
    (re.compile(r'\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}'), '[REDACTED_JWT]'),
    (re.compile(r'-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----'), '[REDACTED_PRIVATE_KEY]'),
    (re.compile(r'([?&](?:[^=&#\s]*(?:token|secret|passw|session|auth)[^=&#\s]*|key|api[-_]?key|apikey|sig|signature|code|otp|x-amz-[^=&#\s]*)=)[^&#\s]*', re.I), r'\1REDACTED'),
    (re.compile(r'#[^\s#]*?(?:access_token|id_token|token|code|secret)=\S*', re.I), '#REDACTED'),
    (EMAIL, '[contact detail removed]'),
    (PHONE, '[contact detail removed]'),
]


def scrub_text(text):
    """Output guard for Python reports (same rules as _shared/output.mjs): secrets, contacts, secret URL parts."""
    for pattern, replacement in _TEXT_SECRETS:
        text = pattern.sub(replacement, text)
    return text


# Owner's decision (#10, option b): NOTHING is stored unmasked. Same rules as maskForStorage() in common.mjs.
_URL_CREDENTIALS = re.compile(r'(\b[a-z][a-z0-9+.-]*://)[^\s/@:]+(?::[^\s/@]*)?@', re.I)


def mask_for_storage(text):
    """Mask text before it is stored: credentials in URLs (first, so 'user:pw@host' is not half-matched as an email
    address), then secrets, secret URL parameters, email addresses and phone numbers."""
    return scrub_text(_URL_CREDENTIALS.sub(r'\1[REDACTED]@', text))


def _as_text(data):
    if b'\x00' in data:
        return None
    try:
        return data.decode('utf-8')
    except UnicodeDecodeError:
        return None


def image_metadata(data):
    """Metadata blocks still present in a PNG/JPEG (empty list = clean); None when it is not a PNG/JPEG."""
    if data[:8] == b'\x89PNG\r\n\x1a\n':
        found, i = [], 8
        while i + 8 <= len(data):
            length = int.from_bytes(data[i:i + 4], 'big')
            kind = data[i + 4:i + 8].decode('latin-1')
            if kind in ('tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME'):
                found.append(kind)
            if kind == 'IEND':
                break
            i += 12 + length
        return found
    if data[:2] == b'\xff\xd8':
        found, i = [], 2
        while i + 4 <= len(data) and data[i] == 0xFF:
            marker = data[i + 1]
            if marker in (0xDA, 0xD9):
                break
            if (0xE1 <= marker <= 0xEF and marker not in (0xE2, 0xEE)) or marker == 0xFE:
                found.append('COM' if marker == 0xFE else f'APP{marker - 0xE0}')
            i += 2 + int.from_bytes(data[i + 2:i + 4], 'big')
        return found
    return None


# V6-02: images are REBUILT from a strict parse (same policy as _shared/image_policy.mjs). Hidden bytes (unknown
# chunks/segments, metadata anywhere, data after the image or after the compressed stream) cannot survive. The pixel
# values themselves are not inspected: visible content still needs a person's review.
_PNG_SIG = b'\x89PNG\r\n\x1a\n'
# V8-02: decoded-byte budget, checked before decompression and enforced during it (same as image_policy.mjs). It bounds
# the decompressed output, not total process memory (input, copies and per-row objects come on top).
MAX_DECODED_BYTES = 64 * 1024 * 1024


def _png_chunk(kind, data):
    import zlib as _z
    return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', _z.crc32(kind + data) & 0xFFFFFFFF)


def parse_png(buf):
    """Strict parse into canonical parts (same as parsePng in image_policy.mjs). `hidden` lists what the canonical
    form removes (unknown chunks, padding bits, unused palette entries…), for exact backups."""
    import zlib as _z
    require(buf[:8] == _PNG_SIG, 'image refused: not a PNG')
    chunks, i = [], 8
    while True:
        require(i + 12 <= len(buf), 'image refused: truncated chunk')
        length = int.from_bytes(buf[i:i + 4], 'big')
        kind = buf[i + 4:i + 8]
        require(kind.isalpha() and kind.isascii(), 'image refused: malformed chunk type')
        end = i + 12 + length
        require(length <= 0x7FFFFFFF and end <= len(buf), 'image refused: truncated chunk')
        data = buf[i + 8:i + 8 + length]
        require(_z.crc32(buf[i + 4:i + 8 + length]) & 0xFFFFFFFF == int.from_bytes(buf[i + 8 + length:end], 'big'),
                f'image refused: bad checksum in {kind.decode()}')
        chunks.append((kind, data))
        i = end
        if kind == b'IEND':
            break
    require(i == len(buf), 'image refused: bytes after the end of the image')
    require(chunks[0][0] == b'IHDR' and len(chunks[0][1]) == 13, 'image refused: first chunk must be a valid IHDR')
    require(chunks[-1][1] == b'', 'image refused: IEND must be empty')
    ihdr = chunks[0][1]
    width, height, depth, color = int.from_bytes(ihdr[0:4], 'big'), int.from_bytes(ihdr[4:8], 'big'), ihdr[8], ihdr[9]
    require(ihdr[10] == 0 and ihdr[11] == 0, 'image refused: unknown compression or filter method')
    require(ihdr[12] == 0, 'image refused: interlaced PNGs are not accepted')
    require(0 < width and 0 < height and width * height <= 50_000_000, 'image refused: image size out of range')
    depths = {0: (1, 2, 4, 8, 16), 2: (8, 16), 3: (1, 2, 4, 8), 4: (8, 16), 6: (8, 16)}.get(color)
    require(depths is not None and depth in depths, 'image refused: invalid colour type / bit depth')
    channels = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[color]
    for kind, _ in chunks[1:-1]:
        require(not kind[:1].isupper() or kind in (b'PLTE', b'IDAT'), f'image refused: unknown critical chunk {kind.decode()}')
    idat = [k for k, (kind, _) in enumerate(chunks) if kind == b'IDAT']
    require(idat and idat[-1] - idat[0] == len(idat) - 1, 'image refused: pixel data missing or not contiguous')

    def once(kind):
        found = [d for k, d in chunks if k == kind]
        require(len(found) <= 1, f'image refused: more than one {kind.decode()}')
        return found[0] if found else None
    plte, trns = once(b'PLTE'), once(b'tRNS')
    hidden = [k.decode() for k, _ in chunks[1:-1] if k not in (b'PLTE', b'tRNS', b'IDAT')]
    stride = (width * depth * channels + 7) // 8
    expected = height * (1 + stride)  # known from the header BEFORE anything is decompressed (V8-02)
    require(expected <= MAX_DECODED_BYTES, f'image refused: decoded image would exceed the {MAX_DECODED_BYTES}-byte limit')
    d = _z.decompressobj()
    try:
        # At most expected + 1 bytes are ever produced: one byte more than the header allows proves an overrun
        # without materializing the rest. There is no flush() afterwards (it would ignore the limit).
        raw = d.decompress(b''.join(chunks[k][1] for k in idat), expected + 1)
    except _z.error:
        raise InputError('image refused: pixel data does not decompress') from None
    require(len(raw) <= expected, 'image refused: pixel data is larger than the header says (stopped at the limit)')
    # Under the limit, all input was offered to the decompressor, so an unconsumed tail cannot be output-limited.
    require(not d.unconsumed_tail, 'image refused: pixel data could not be fully read')
    require(d.eof, 'image refused: the compressed pixel stream is truncated')
    require(not d.unused_data, 'image refused: data after the compressed pixel stream')
    require(len(raw) == expected, 'image refused: pixel data is not the size the header says')
    pixels = _png_unfilter(raw, height, stride, max(1, (depth * channels) >> 3))
    rem = (width * depth * channels) % 8
    if rem:  # bits after the last pixel of each row are not pixel data: zeroed
        keep = (0xFF << (8 - rem)) & 0xFF
        for r in range(height):
            k = r * stride + stride - 1
            if pixels[k] & ~keep & 0xFF:
                pixels[k] &= keep
                if 'row padding bits' not in hidden:
                    hidden.append('row padding bits')
    palette = alpha = None
    if color == 3:
        require(plte is not None and plte and len(plte) % 3 == 0 and len(plte) <= 768, 'image refused: palette missing or invalid')
        require(trns is None or len(trns) <= len(plte) // 3, 'image refused: transparency has more entries than the palette')
        if depth == 8:
            used = set(pixels)
        else:
            used, mask = set(), (1 << depth) - 1
            for r in range(height):
                base = r * stride
                for x in range(width):
                    bit = x * depth
                    used.add((pixels[base + (bit >> 3)] >> (8 - depth - (bit & 7))) & mask)
        top = max(used)
        require(top < len(plte) // 3, 'image refused: pixel uses a palette entry that does not exist')
        # V8-01: EVERY entry no pixel references is not pixel data, wherever it sits (below the highest used index
        # too). Indices are kept, so each pixel renders exactly as before; unused entries become black and their
        # transparency fully opaque (the value omitted entries have anyway). Then the unused tail is trimmed.
        pal = bytearray(plte[:(top + 1) * 3])
        unused_palette = any(plte[(top + 1) * 3:])
        for k in range(top + 1):
            if k not in used and any(pal[3 * k:3 * k + 3]):
                pal[3 * k:3 * k + 3] = b'\0\0\0'
                unused_palette = True
        if unused_palette:
            hidden.append('unused palette entries')
        palette = bytes(pal)
        if trns is not None:
            a = bytearray(trns[:min(len(trns), top + 1)])
            unused_alpha = any(v != 255 for v in trns[len(a):])
            for k in range(len(a)):
                if k not in used and a[k] != 255:
                    a[k] = 255
                    unused_alpha = True
            if unused_alpha:
                hidden.append('unused transparency entries')
            while a and a[-1] == 255:  # trailing opaque entries carry nothing: omitted entries are opaque
                a.pop()
            alpha = bytes(a) or None
    else:
        require(not (plte is not None and color in (0, 4)), 'image refused: a palette is not allowed for this colour type')
        if plte is not None:
            hidden.append('suggested palette')  # colour types 2 and 6: optional, not pixel data
        if trns is not None:
            require(color not in (4, 6), 'image refused: a transparency chunk is not allowed with an alpha channel')
            n = 1 if color == 0 else 3
            require(len(trns) == 2 * n, 'image refused: transparency chunk has the wrong size')
            require(all(int.from_bytes(trns[2 * k:2 * k + 2], 'big') < 2 ** depth for k in range(n)), 'image refused: transparency value out of range')
            alpha = trns
    rows = b''.join(b'\0' + bytes(pixels[r * stride:(r + 1) * stride]) for r in range(height))  # canonical: filter 0
    return {'ihdr': ihdr, 'palette': palette, 'alpha': alpha, 'rows': rows, 'hidden': hidden}


def _png_unfilter(raw, height, stride, bpp):
    out = bytearray(height * stride)
    for r in range(height):
        f = raw[r * (stride + 1)]
        require(f <= 4, 'image refused: invalid row filter')
        src = raw[r * (stride + 1) + 1:(r + 1) * (stride + 1)]
        base, prev = r * stride, (r - 1) * stride
        for x in range(stride):
            a = out[base + x - bpp] if x >= bpp else 0
            b = out[prev + x] if r else 0
            c = out[prev + x - bpp] if r and x >= bpp else 0
            if f == 0:
                p = 0
            elif f == 1:
                p = a
            elif f == 2:
                p = b
            elif f == 3:
                p = (a + b) >> 1
            else:
                pa, pb, pc = abs(b - c), abs(a - c), abs(a + b - 2 * c)
                p = a if pa <= pb and pa <= pc else (b if pb <= pc else c)
            out[base + x] = (src[x] + p) & 0xFF
    return out


def sanitize_png(buf):
    import zlib as _z
    p = parse_png(buf)
    out = _PNG_SIG + _png_chunk(b'IHDR', p['ihdr'])
    if p['palette'] is not None:
        out += _png_chunk(b'PLTE', p['palette'])
    if p['alpha'] is not None:
        out += _png_chunk(b'tRNS', p['alpha'])
    return out + _png_chunk(b'IDAT', _z.compress(p['rows'], 9)) + _png_chunk(b'IEND', b'')


def _jpeg_check_segment(m, body):
    """Every kept segment must be EXACTLY its structure, fields in range (same as checkSegment in image_policy.mjs)."""
    def bad(what):
        raise InputError(f'image refused: malformed {what}')
    if 0xC0 <= m <= 0xC2:
        nf = body[5] if len(body) > 5 else 0
        if len(body) < 6 or len(body) != 6 + 3 * nf or not 1 <= nf <= 4:
            bad('frame header')
        if body[0] != 8 and not (m != 0xC0 and body[0] == 12):
            bad('frame header (precision)')
        if not int.from_bytes(body[1:3], 'big') or not int.from_bytes(body[3:5], 'big'):
            bad('frame header (size)')
        for k in range(nf):
            hv, tq = body[7 + 3 * k], body[8 + 3 * k]
            if not (1 <= hv >> 4 <= 4 and 1 <= hv & 15 <= 4) or tq > 3:
                bad('frame header (component)')
    elif m == 0xDB:
        p = 0
        if not body:
            bad('quantization table')
        while p < len(body):
            pq, tq = body[p] >> 4, body[p] & 15
            size = 64 * (pq + 1)
            if pq > 1 or tq > 3 or p + 1 + size > len(body):
                bad('quantization table')
            vals = [int.from_bytes(body[p + 1 + 2 * k:p + 3 + 2 * k], 'big') for k in range(64)] if pq else body[p + 1:p + 65]
            if not all(vals):
                bad('quantization table (zero value)')
            p += 1 + size
    elif m == 0xC4:
        p = 0
        if not body:
            bad('Huffman table')
        while p < len(body):
            if p + 17 > len(body) or body[p] >> 4 > 1 or body[p] & 15 > 3:
                bad('Huffman table')
            total = sum(body[p + 1:p + 17])
            if not total or total > 256 or p + 17 + total > len(body):
                bad('Huffman table')
            p += 17 + total
    elif m == 0xDD:
        if len(body) != 2:
            bad('restart interval')
    elif m == 0xDA:
        ns = body[0] if body else 0
        if not 1 <= ns <= 4 or len(body) != 4 + 2 * ns:
            bad('scan header')
        for k in range(ns):
            if body[2 + 2 * k] >> 4 > 3 or body[2 + 2 * k] & 15 > 3:
                bad('scan header (tables)')
        ss, se, a = body[1 + 2 * ns], body[2 + 2 * ns], body[3 + 2 * ns]
        if ss > 63 or se > 63 or ss > se or a >> 4 > 13 or a & 15 > 13:
            bad('scan header (spectral selection)')


def sanitize_jpeg(buf):
    require(len(buf) >= 4 and buf[0] == 0xFF and buf[1] == 0xD8, 'image refused: not a JPEG')
    out, i, frame, scan = [b'\xff\xd8'], 2, False, False
    while True:
        require(i < len(buf) and buf[i] == 0xFF, 'image refused: malformed segment')
        while i + 1 < len(buf) and buf[i + 1] == 0xFF:
            i += 1
        require(i + 1 < len(buf), 'image refused: truncated segment')
        m = buf[i + 1]
        if m == 0xD9:
            out.append(b'\xff\xd9'); i += 2
            break
        require(i + 4 <= len(buf), 'image refused: truncated segment')
        length = int.from_bytes(buf[i + 2:i + 4], 'big')
        require(length >= 2 and i + 2 + length <= len(buf), 'image refused: truncated segment')
        seg = buf[i:i + 2 + length]
        i += 2 + length
        if 0xE0 <= m <= 0xEF or m == 0xFE:
            continue  # application segments (JFIF, EXIF, XMP, ICC, Adobe…) and comments: dropped
        if m in (0xC0, 0xC1, 0xC2, 0xC4, 0xDB, 0xDD, 0xDA):
            _jpeg_check_segment(m, seg[4:])
        if m in (0xC0, 0xC1, 0xC2):
            require(not frame, 'image refused: more than one frame header')
            frame = True; out.append(seg); continue
        if m in (0xC4, 0xDB, 0xDD):
            out.append(seg); continue
        if m == 0xDA:
            require(frame, 'image refused: scan before frame header')
            scan, j = True, i
            while j < len(buf):
                if buf[j] == 0xFF and j + 1 < len(buf):
                    n = buf[j + 1]
                    if n == 0x00 or 0xD0 <= n <= 0xD7:
                        j += 2; continue
                    break
                j += 1
            require(j < len(buf), 'image refused: scan data runs off the end')
            out += [seg, buf[i:j]]
            i = j
            continue
        raise InputError(f'image refused: unknown segment 0x{m:02x}')
    require(i == len(buf), 'image refused: bytes after the end of the image')
    require(frame and scan, 'image refused: no image data')
    return b''.join(out)


def sanitize_image(data):
    """A PNG or JPEG rebuilt by the strict policy above, or InputError. Idempotent."""
    if data[:8] == _PNG_SIG:
        return sanitize_png(data)
    if data[:2] == b'\xff\xd8':
        return sanitize_jpeg(data)
    raise InputError('image refused: only PNG and JPEG images are accepted')


# V6-06: JSON is masked by VALUE after parsing (same as maskStoredText in common.mjs), so it stays valid JSON.
_SENSITIVE_KEY = re.compile(r'^(?:[\w-]*[_-])?(?:token|secret|password|passwd|passphrase|api[_-]?key|access[_-]?key|private[_-]?key|'
                            r'authorization|cookie|set-cookie|session[_-]?id|credentials?)$', re.I)


def _mask_json_value(v, key=None):
    sensitive = isinstance(key, str) and bool(_SENSITIVE_KEY.match(key))
    # v7 review: under a sensitive key EVERYTHING is replaced whole (strings, numbers, objects, arrays); only null and
    # booleans, which cannot carry a secret, are kept.
    if sensitive and v is not None and not isinstance(v, bool):
        return '[REDACTED]'
    if isinstance(v, str):
        return mask_for_storage(v)
    if isinstance(v, list):
        return [_mask_json_value(x, key) for x in v]
    if isinstance(v, dict):
        return {mask_for_storage(k): _mask_json_value(x, k) for k, x in v.items()}
    return v


def mask_stored_text(text):
    """Mask text for storage: JSON structurally (V6-06), anything else line by line."""
    head = text.lstrip()[:1]
    if head in ('{', '['):
        try:
            parsed = json.loads(text)
        except ValueError:
            parsed = None
        else:
            masked = _mask_json_value(parsed)
            if masked == parsed:
                return text  # nothing to mask: keep the exact bytes
            m = re.search(r'\n( +)\S', text)
            out = json.dumps(masked, indent=len(m.group(1)) if m else None, ensure_ascii=False, allow_nan=False)
            return out + ('\n' if text.endswith('\n') else '')
    return mask_for_storage(text)


def image_has_only_core_parts(data):
    """True if a strictly valid image holds nothing beyond its core parts (PNG: IHDR/PLTE/tRNS/IDAT/IEND only;
    JPEG: nothing the rebuild would drop). Such an image can be kept byte-for-byte without hidden data."""
    sanitize_image(data)  # strict validation first (raises on anything malformed or trailing)
    if data[:8] == _PNG_SIG:
        # v7 review: nothing the canonical form removes (unknown chunks, unused palette or transparency entries, a
        # suggested palette, row padding bits). Row filter choice and the deflate encoding are not compared.
        return not parse_png(data)['hidden']
    # JPEG: identical to its rebuild, except that a plain JFIF header with validated fields may stay (storage drops
    # it; an exact backup cannot). Its density values are the one residual non-pixel field kept in backups.
    if data[2:4] == b'\xff\xe0':
        length = int.from_bytes(data[4:6], 'big')
        app0 = data[2:4 + length]
        plain = (length == 16 and app0[4:9] == b'JFIF\x00' and app0[9] == 1 and app0[10] <= 2 and app0[11] <= 2
                 and int.from_bytes(app0[12:14], 'big') and int.from_bytes(app0[14:16], 'big') and app0[16] == 0 and app0[17] == 0)
        if not plain:
            return False
        data = data[:2] + data[4 + length:]
    return sanitize_jpeg(data) == data


def prepare_for_storage(data, binary=None, require_unchanged=False):
    """#10: text is masked (JSON by value, V6-06); `binary='image'` stores the image REBUILT by the strict policy
    (V6-02); any other binary is refused. `require_unchanged` (backups) keeps content byte-for-byte only if it is
    already safe: text that masking would not change, and images with nothing beyond their core parts."""
    text = _as_text(data)
    if text is not None:
        masked = mask_stored_text(text)
        if require_unchanged:
            require(masked == text, 'Refusing to keep this file: it contains secret- or contact-shaped content. A masked '
                                    'copy would not be a faithful backup, and unmasked copies are not kept.')
        return masked.encode('utf-8')
    if binary == 'image':
        meta = image_metadata(data)
        require(not meta, 'Refusing to save: the image still has metadata (%s); run metadata_scrub first' % ', '.join(meta or []))
        rebuilt = sanitize_image(data)
        if require_unchanged:
            require(image_has_only_core_parts(data), 'Refusing to keep this image: it carries data beyond its core image parts '
                                                     '(metadata, extra chunks or segments). A cleaned copy would not be a faithful backup.')
            return data
        return rebuilt
    raise InputError('Refusing to save binary content: it cannot be masked (owner rule: masked copies only; archives '
                     'and other opaque files are not kept)')


def scrub_value(value):
    if isinstance(value, str):
        return scrub_text(value)
    if isinstance(value, list):
        return [scrub_value(v) for v in value]
    if isinstance(value, dict):
        return {k: scrub_value(v) for k, v in value.items()}
    return value


def emit(result, output=None, scope=None):
    """Print a report, or write it to a NEW file inside the toolbox. Returns the shared exit code.
    Every text value passes through the output guard first, whether printed or saved (F07)."""
    state = result.get('result')
    result = scrub_value(result)
    if output:
        require_scope(scope)
        out = inside_toolbox(output)
        require(not out.exists(), 'Report output must be a new file (existing reports are never overwritten)')
        write(out, result)
        print(f'saved {out}')
    else:
        print(json.dumps(result, indent=2, allow_nan=False))
    return 1 if state == 'fail' else (3 if state == 'unresolved' else 0)


def cli(run):
    """Shared error handling: never echo raw inputs or exception internals."""
    import sys
    try:
        sys.exit(run())
    except InputError as e:
        print(f'Input rejected: {e}', file=sys.stderr)
        sys.exit(2)
    except (ValueError, TypeError, KeyError, OSError):
        print('Input rejected or operation unavailable. No raw input or exception details displayed.', file=sys.stderr)
        sys.exit(2)
