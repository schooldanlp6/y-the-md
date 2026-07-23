"""Tests for the vendor/ sys.path bootstrap.

Pure: no network, no credentials, no real wheel needed.
"""
from __future__ import annotations

import sys

import pytest

from matcha import _vendor


@pytest.fixture
def saved_path():
    original = list(sys.path)
    yield
    sys.path[:] = original


def test_missing_directory_is_a_no_op(tmp_path, saved_path):
    before = list(sys.path)
    assert _vendor.activate(tmp_path / "nope") is False
    assert sys.path == before


def test_existing_directory_is_appended_not_prepended(tmp_path, saved_path):
    assert _vendor.activate(tmp_path) is True
    # Appended, so apt-provided packages always shadow anything vendored.
    assert sys.path[-1] == str(tmp_path)


def test_activate_is_idempotent(tmp_path, saved_path):
    _vendor.activate(tmp_path)
    _vendor.activate(tmp_path)
    assert sys.path.count(str(tmp_path)) == 1


def test_vendor_dir_is_repo_root_vendor():
    assert _vendor.VENDOR_DIR.name == "vendor"
    assert (_vendor.VENDOR_DIR.parent / "matcha").is_dir()
