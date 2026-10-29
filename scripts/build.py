#!/usr/bin/env python3
"""Build the three programs into `<repo>/dist/`.

    python3 scripts/build.py                  # all three
    python3 scripts/build.py matcha y-the-md  # just these
    python3 scripts/build.py --check          # report missing tools, build nothing

Output:

    dist/matcha        single executable (PyInstaller onefile; needs glibc + zlib)
    dist/y-the-md      single executable (bun --compile; needs glibc)
    dist/spice-ify.js  single JS file, loaded by Spicetify inside Spotify

Nothing is installed or downloaded here -- every tool must already be present
(see the Requirements section of README.md). Intermediate files go to
`build/`, which is gitignored.
"""
from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DIST_DIR = REPO_ROOT / "dist"
BUILD_DIR = REPO_ROOT / "build"

# Debian's own module tree. matcha is built against this and `vendor/` only:
# `/usr/local` and `~/.local` come *first* on the default sys.path, so a stray
# `sudo pip install` there would otherwise be what gets frozen into the binary.
APT_SITE = Path("/usr/lib/python3/dist-packages")

# PyInstaller needs a script, not `-m matcha.main`. Kept out of the package so
# the binary build doesn't dictate matcha's source layout.
#
# Frozen, matcha's `__file__` points into a temp dir that is deleted on exit,
# so config.py's defaults would find no `.env` and put the match cache
# somewhere that vanishes every restart. The shim re-anchors both before
# anything else reads config: `.env` from the working directory (as when run
# from the repo root), the cache under XDG data. Real env vars still win.
MATCHA_ENTRY = """\
import importlib
import logging
import os
from pathlib import Path

from matcha import config

config.load_env_file(Path.cwd() / ".env")
if not config.env("DB"):
    data_home = Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local" / "share")
    os.environ["MATCHA_DB"] = str(data_home / "matcha" / "matches.db")
importlib.reload(config)

from matcha.main import app

logging.basicConfig(
    level=logging.DEBUG if config.DEBUG else logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
app.run(host=config.HOST, port=config.PORT, debug=False)
"""


def apt_python_env() -> dict[str, str]:
    """Environment for a `python3 -S` that sees only apt packages and vendor/."""
    env = dict(os.environ)
    env["PYTHONPATH"] = os.pathsep.join([str(APT_SITE), str(REPO_ROOT / "vendor")])
    env["PYTHONNOUSERSITE"] = "1"
    return env


def apt_has(module: str) -> bool:
    probe = f"import importlib.util, sys; sys.exit(importlib.util.find_spec({module!r}) is None)"
    return subprocess.run([sys.executable, "-S", "-c", probe], env=apt_python_env()).returncode == 0


def missing_tools(target: str) -> list[str]:
    """Name what `target` needs that isn't on this machine."""
    missing: list[str] = []
    if target == "matcha":
        if shutil.which("objcopy") is None:
            missing.append("objcopy  (sudo apt install binutils)")
        apt_packages = {
            "PyInstaller": "python3-pyinstaller",
            "flask": "python3-flask",
            "rapidfuzz": "python3-rapidfuzz",
            "spotipy": "python3-spotipy",
            "requests": "python3-requests",
            "certifi": "python3-certifi",
        }
        for mod, pkg in apt_packages.items():
            if not apt_has(mod):
                missing.append(f"{mod}  (sudo apt install {pkg})")
        if not apt_has("ytmusicapi"):
            missing.append("ytmusicapi  (python3 scripts/fetch_vendor.py)")
    else:
        if shutil.which("bun") is None:
            missing.append("bun  (not in Debian; see README.md, Requirements)")
        if target == "y-the-md" and not (REPO_ROOT / "y-the-md" / "node_modules").is_dir():
            missing.append("y-the-md/node_modules  (cd mt-peer && bun install; y-the-md/node_modules links there)")
    return missing


def build_matcha() -> Path:
    work = BUILD_DIR / "matcha"
    work.mkdir(parents=True, exist_ok=True)
    entry = work / "matcha_entry.py"
    entry.write_text(MATCHA_ENTRY)
    # vendor/ goes on PYTHONPATH as well as `--paths`: the latter only reaches
    # import analysis, while `--collect-all` resolves the package in a separate
    # step that ignores it -- and then silently skips ytmusicapi's locale
    # files, which YTMusic() needs at construction.
    subprocess.run(
        [
            sys.executable, "-S", "-m", "PyInstaller",
            "--onefile", "--noconfirm", "--clean",
            "--name", "matcha",
            "--paths", str(REPO_ROOT),
            "--paths", str(REPO_ROOT / "vendor"),
            "--collect-all", "ytmusicapi",
            "--distpath", str(DIST_DIR),
            "--workpath", str(work / "pyinstaller"),
            "--specpath", str(work),
            "--log-level", "WARN",
            str(entry),
        ],
        env=apt_python_env(),
        check=True,
    )
    out = DIST_DIR / "matcha"
    verify_bundle(out)
    return out


# Files PyInstaller has been seen to drop without failing the build. Each one
# breaks matcha at runtime, not at boot, so check for them here instead.
REQUIRED_IN_BUNDLE = (
    "ytmusicapi/locales/en/LC_MESSAGES/base.mo",
    "rapidfuzz/fuzz_cpp.",
)


def verify_bundle(binary: Path) -> None:
    from PyInstaller.archive.readers import CArchiveReader

    names = list(CArchiveReader(str(binary)).toc)
    absent = [want for want in REQUIRED_IN_BUNDLE if not any(n.startswith(want) for n in names)]
    if absent:
        raise SystemExit(f"{binary.name}: bundle is missing {', '.join(absent)}")


def build_y_the_md() -> Path:
    out = DIST_DIR / "y-the-md"
    subprocess.run(["bun", "build.ts", str(out)], cwd=REPO_ROOT / "y-the-md", check=True)
    return out


def build_spice_ify() -> Path:
    out = DIST_DIR / "spice-ify.js"
    subprocess.run(
        # IIFE: Spicetify concatenates extensions into one page, and top-level
        # `var`s from a plain bundle would become globals other extensions see.
        ["bun", "build", "src/spice-ify.ts", "--format", "iife", "--outfile", str(out)],
        cwd=REPO_ROOT / "spice-ify",
        check=True,
    )
    return out


TARGETS = {
    "matcha": build_matcha,
    "y-the-md": build_y_the_md,
    "spice-ify": build_spice_ify,
}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("targets", nargs="*", metavar="target", help=f"any of {', '.join(TARGETS)} (default: all)")
    parser.add_argument("--check", action="store_true", help="report missing tools only")
    args = parser.parse_args()
    unknown = [t for t in args.targets if t not in TARGETS]
    if unknown:
        parser.error(f"unknown target(s): {', '.join(unknown)}")
    targets = args.targets or list(TARGETS)

    problems = {t: missing_tools(t) for t in targets}
    for target, missing in problems.items():
        for item in missing:
            print(f"[MISSING] {target}: {item}")
    if any(problems.values()):
        return 1
    if args.check:
        print("all build tools present")
        return 0

    DIST_DIR.mkdir(exist_ok=True)
    for target in targets:
        print(f"==> {target}")
        out = TARGETS[target]()
        print(f"    {out.relative_to(REPO_ROOT)}  ({out.stat().st_size / 1e6:.1f} MB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
