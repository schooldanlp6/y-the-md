# vendor/ — drop packages apt doesn't carry in here

This is the one place in the repo where third-party Python code lives. Anything
unpacked here becomes importable: `matcha/__init__.py` calls
`matcha/_vendor.py`, which appends this directory to `sys.path` at import time.
No `PYTHONPATH`, no venv, no `pip install`, nothing written outside the repo.

Right now exactly one package needs this: **`ytmusicapi`** (pure-Python wheel,
only runtime dep is `requests`, which apt provides). Everything else comes from
apt — see [`../DEPENDENCIES.md`](../DEPENDENCIES.md).

## Fill it (scripted)

```bash
python3 scripts/fetch_vendor.py          # downloads + checksum-verifies + unpacks
python3 scripts/fetch_vendor.py --check  # report what's missing, change nothing
```

The script pins versions, refuses anything that isn't a `py3-none-any` wheel,
verifies the PyPI SHA-256, and skips any package the system already provides —
so installing `python3-ytmusicapi` later (if Debian ever ships it) silently
takes over and this directory stops mattering.

## Fill it (by hand)

Same result, no script:

1. Grab the `.whl` (not the `.tar.gz`) from
   <https://pypi.org/project/ytmusicapi/#files>.
2. `unzip -o ytmusicapi-*.whl -d vendor/`

You should end up with:

```
vendor/
├── README.md
├── ytmusicapi/                 ← the package itself
└── ytmusicapi-1.12.1.dist-info/
```

A wheel is just a zip whose top-level entries are the import packages, so
unzipping it here is exactly what an installer would do minus the metadata
bookkeeping.

## Rules

- **Pure-Python wheels only** (`*-py3-none-any.whl`). Anything with compiled
  extensions is interpreter- and arch-specific and does not belong in a repo
  directory — get it from apt or leave it out.
- **apt wins.** This directory is *appended* to `sys.path`, so a Debian package
  of the same name always shadows what's here. That's deliberate: a stale copy
  in `vendor/` can never break a properly packaged module.
- **Nothing here is committed.** `.gitignore` keeps everything except this
  README out of git. A fresh clone starts empty and you re-run the fetch script.
- **Don't put project code here.** This is dependencies only.

## Verify

```bash
python3 -c "import matcha, ytmusicapi; print(ytmusicapi.__file__)"
# .../vendor/ytmusicapi/__init__.py   ← vendored
# /usr/lib/python3/dist-packages/...  ← apt, vendor/ unused

python3 -m pytest tests/ -q            # green without any of this
curl -s localhost:8080/api/v1/health   # "providers": {"ytm": true} once it's live
```

## Reset

```bash
rm -rf vendor/ytmusicapi vendor/ytmusicapi-*.dist-info
```

Nothing outside the repo is touched, so that's the whole uninstall.
