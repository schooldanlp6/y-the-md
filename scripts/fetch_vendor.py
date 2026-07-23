#!/usr/bin/env python3
"""Fetch the dependencies apt does not carry into `<repo>/vendor/`.

No pip, no venv, nothing written outside the repo -- see AGENTS.md. Each
package is downloaded from PyPI as a pure-Python wheel, checksum-verified, and
unzipped into `vendor/`, which `matcha/_vendor.py` puts on `sys.path`.

    python3 scripts/fetch_vendor.py            # install everything missing
    python3 scripts/fetch_vendor.py --check    # report only, change nothing
    python3 scripts/fetch_vendor.py --force    # re-download even if present

Offline? Download the wheel by hand from the project's PyPI "Download files"
page and unzip it into `vendor/` yourself; the result is identical.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import shutil
import sys
import tempfile
import urllib.request
import zipfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
VENDOR_DIR = REPO_ROOT / "vendor"

# name -> pinned version. Only packages with no python3-* Debian package belong
# here; anything apt ships must come from apt instead.
PACKAGES: dict[str, str] = {
    "ytmusicapi": "1.12.1",
}

# Import name, when it differs from the distribution name.
IMPORT_NAMES: dict[str, str] = {}


def import_name(package: str) -> str:
    return IMPORT_NAMES.get(package, package.replace("-", "_"))


def find_spec_outside_vendor(package: str) -> str | None:
    """Where python resolves this package from right now, if anywhere."""
    try:
        spec = importlib.util.find_spec(import_name(package))
    except (ImportError, ValueError):
        return None
    return spec.origin if spec is not None else None


def resolve_wheel(package: str, version: str) -> tuple[str, str, str]:
    """Return (filename, url, sha256) for the pure-Python wheel on PyPI."""
    url = f"https://pypi.org/pypi/{package}/{version}/json"
    with urllib.request.urlopen(url, timeout=30) as response:
        payload = json.load(response)

    candidates = [
        entry
        for entry in payload.get("urls", [])
        if entry.get("packagetype") == "bdist_wheel"
        and entry.get("filename", "").endswith("-none-any.whl")
    ]
    if not candidates:
        raise SystemExit(
            f"{package} {version} has no pure-Python (none-any) wheel. It is not "
            f"safe to vendor this way -- see DEPENDENCIES.md."
        )

    entry = candidates[0]
    return entry["filename"], entry["url"], entry["digests"]["sha256"]


def download(url: str, expected_sha256: str, dest: Path) -> None:
    digest = hashlib.sha256()
    with urllib.request.urlopen(url, timeout=60) as response, dest.open("wb") as handle:
        for chunk in iter(lambda: response.read(64 * 1024), b""):
            digest.update(chunk)
            handle.write(chunk)

    actual = digest.hexdigest()
    if actual != expected_sha256:
        dest.unlink(missing_ok=True)
        raise SystemExit(
            f"checksum mismatch for {dest.name}\n"
            f"  expected {expected_sha256}\n  got      {actual}"
        )


def unpack(wheel: Path, target: Path) -> list[str]:
    with zipfile.ZipFile(wheel) as archive:
        names = archive.namelist()
        for name in names:
            # Refuse paths that would escape the vendor directory.
            resolved = (target / name).resolve()
            if not resolved.is_relative_to(target.resolve()):
                raise SystemExit(f"unsafe path in wheel: {name}")
        archive.extractall(target)
    return sorted({name.split("/")[0] for name in names})


def vendored_dir(package: str) -> Path:
    return VENDOR_DIR / import_name(package)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="report only")
    parser.add_argument("--force", action="store_true", help="re-download")
    args = parser.parse_args()

    VENDOR_DIR.mkdir(exist_ok=True)
    status = 0

    for package, version in PACKAGES.items():
        target = vendored_dir(package)
        origin = find_spec_outside_vendor(package)
        system_copy = origin is not None and str(VENDOR_DIR) not in str(origin)

        if system_copy:
            print(f"{package}: provided by the system ({origin}) -- skipping")
            continue
        if target.exists() and not args.force:
            print(f"{package}: already in vendor/ ({target.relative_to(REPO_ROOT)})")
            continue
        if args.check:
            print(f"{package}: MISSING -- run scripts/fetch_vendor.py")
            status = 1
            continue

        filename, url, sha256 = resolve_wheel(package, version)
        print(f"{package}: fetching {filename}")
        with tempfile.TemporaryDirectory() as tmp:
            wheel = Path(tmp) / filename
            download(url, sha256, wheel)
            if args.force and target.exists():
                shutil.rmtree(target)
            tops = unpack(wheel, VENDOR_DIR)
        print(f"{package}: unpacked into vendor/ ({', '.join(tops)})")

    if not args.check:
        print("\nverify with: python3 -c 'import matcha, ytmusicapi; print(ytmusicapi.__file__)'")
    return status


if __name__ == "__main__":
    sys.exit(main())
