"""metadata_scrub: remove hidden metadata (EXIF/GPS, XMP, comments, text chunks) from JPEG and PNG screenshots
before sharing them as evidence.

Rewritten from the earlier proof-image scrubber: no Pillow needed, pixels are not re-encoded, originals are
never modified, and cleaned copies go to a NEW folder inside this toolbox.

  python metadata_scrub.py INPUT_FOLDER_OR_FILE [--output-dir DIR]

Kept: image data, JFIF header, ICC colour profile, Adobe colour marker, PNG structure/colour chunks.
Removed: JPEG APP1 (EXIF/GPS/XMP), APP3-APP13, APP15, COM; PNG tEXt, zTXt, iTXt, eXIf, tIME.
Other formats (HEIC, WebP, GIF) are skipped and reported, not guessed at.
"""
import argparse
import datetime as dt
import json
from pathlib import Path
import struct
import sys

sys.dont_write_bytecode = True  # no __pycache__ files in the toolkit
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / '_shared'))
from gb2l_core import TOOLBOX_ROOT, InputError, cli, contained, make_dirs, no_links, require, require_scope, write_bytes_safely

PNG_SIG = b'\x89PNG\r\n\x1a\n'
PNG_DROP = {b'tEXt', b'zTXt', b'iTXt', b'eXIf', b'tIME'}
JPEG_KEEP_APP = {0xE0, 0xE2, 0xEE}  # JFIF, ICC profile, Adobe colour transform
MAX_BYTES = 50_000_000


def scrub_png(data):
    require(data.startswith(PNG_SIG), 'Not a PNG')
    out, removed, i = [PNG_SIG], [], len(PNG_SIG)
    while i < len(data):
        require(i + 8 <= len(data), 'Truncated PNG chunk header')
        length, ctype = struct.unpack('>I4s', data[i:i + 8])
        end = i + 12 + length
        require(end <= len(data), 'Truncated PNG chunk')
        if ctype in PNG_DROP:
            removed.append(ctype.decode('ascii'))
        else:
            out.append(data[i:end])
        i = end
        if ctype == b'IEND':
            break
    return b''.join(out), removed


def scrub_jpeg(data):
    require(data[:2] == b'\xff\xd8', 'Not a JPEG')
    out, removed, i = [b'\xff\xd8'], [], 2
    while i < len(data):
        require(data[i] == 0xFF, 'Malformed JPEG marker')
        while i < len(data) and data[i] == 0xFF and i + 1 < len(data) and data[i + 1] == 0xFF:
            i += 1  # fill bytes
        marker = data[i + 1]
        if marker == 0xDA or marker == 0xD9:  # start of scan / end: copy the rest unchanged
            out.append(data[i:])
            break
        if 0xD0 <= marker <= 0xD7 or marker == 0x01:
            out.append(data[i:i + 2]); i += 2
            continue
        require(i + 4 <= len(data), 'Truncated JPEG segment')
        length = struct.unpack('>H', data[i + 2:i + 4])[0]
        end = i + 2 + length
        require(length >= 2 and end <= len(data), 'Truncated JPEG segment')
        is_app = 0xE0 <= marker <= 0xEF
        if (is_app and marker not in JPEG_KEEP_APP) or marker == 0xFE:
            removed.append('COM' if marker == 0xFE else f'APP{marker - 0xE0}')
        else:
            out.append(data[i:end])
        i = end
    return b''.join(out), removed


def scrub_file(path):
    data = path.read_bytes()
    require(len(data) <= MAX_BYTES, 'File too large')
    if data.startswith(PNG_SIG):
        return scrub_png(data)
    if data[:2] == b'\xff\xd8':
        return scrub_jpeg(data)
    raise InputError('Unsupported format (only JPEG and PNG)')


def run(source, output_dir=None):
    source = no_links(source)
    require(source.exists(), 'Input not found')
    files = [source] if source.is_file() else sorted(p for p in source.iterdir() if p.is_file() and not p.is_symlink())
    stamp = dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    # Containment is checked BEFORE anything is created: inside the toolbox, and no symlink/junction/reparse point
    # anywhere in the path (F11). Folders and files are then created through the shared safe helpers.
    out_dir = contained(output_dir or TOOLBOX_ROOT / 'metadata_scrub' / 'cleaned' / stamp)
    require(not out_dir.exists(), 'Output folder must be new')
    results = []
    for f in files:
        try:
            cleaned, removed = scrub_file(f)
        except InputError as e:
            results.append({'file': f.name, 'status': 'skipped', 'reason': str(e)})
            continue
        make_dirs(out_dir)
        write_bytes_safely(out_dir / f.name, cleaned, binary='image')  # new file only; refuses links; re-checks no metadata
        results.append({'file': f.name, 'status': 'cleaned', 'removed': removed, 'bytes_before': f.stat().st_size, 'bytes_after': len(cleaned)})
    return {'output_dir': str(out_dir) if out_dir.exists() else None, 'results': results}


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('source', type=Path)
    p.add_argument('--output-dir', type=Path)
    p.add_argument('--scope', type=Path, required=True, help='incident scope (cleaned copies are saved)')
    args = p.parse_args(argv)
    require_scope(args.scope)
    summary = run(args.source, args.output_dir)
    print(json.dumps(summary, indent=2))
    print('Originals were not modified. Check the cleaned images still show what you need before sharing.', file=sys.stderr)
    return 0


if __name__ == '__main__':
    cli(main)
