"""Makes the repo's `vendor/` directory importable.

Some dependencies -- currently only `ytmusicapi` -- have no Debian package, and
system python is PEP 668 EXTERNALLY-MANAGED so pip is not an option. Those get
unpacked into `<repo>/vendor/` by hand; see `vendor/README.md`.

The directory is *appended* to `sys.path`, never prepended, so anything apt
provides keeps winning and a stale copy under `vendor/` can never shadow a
properly packaged module.

Imported for its side effect by `matcha/__init__.py`, which runs before any
provider imports its client. Safe when `vendor/` is absent or empty.
"""
from __future__ import annotations

import sys
from pathlib import Path

VENDOR_DIR = Path(__file__).resolve().parent.parent / "vendor"


def activate(vendor_dir: Path | None = None) -> bool:
    """Put `vendor/` on `sys.path`.

    Returns True if the directory exists and is now importable, False if there
    is nothing to add. Idempotent.
    """
    directory = VENDOR_DIR if vendor_dir is None else vendor_dir
    if not directory.is_dir():
        return False

    path = str(directory)
    if path not in sys.path:
        sys.path.append(path)
    return True
