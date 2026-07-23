"""Song-matching service for the YouTube Music <-> Spotify bridge."""
from ._vendor import activate as _activate_vendor

# Runs before any provider imports its client, so packages dropped into
# `vendor/` are importable without PYTHONPATH. See vendor/README.md.
_activate_vendor()
