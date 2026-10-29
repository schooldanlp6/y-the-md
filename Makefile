# Thin wrapper around scripts/build.py, which is the whole build.
# Everything here delegates to it; see the Build section of README.md.

PYTHON ?= python3
BUILD  := $(PYTHON) scripts/build.py

.PHONY: all matcha y-the-md spice-ify check help

all:
	$(BUILD)
	cp dist/spice-ify.js dist/yt-music-jam-api.js

matcha y-the-md:
	$(BUILD) $@

spice-ify:
	$(BUILD) $@
	cp dist/spice-ify.js dist/yt-music-jam-api.js

check:
	$(BUILD) --check

help:
	@echo "make            build all three into dist/ (python3 scripts/build.py)"
	@echo "make matcha     build dist/matcha only"
	@echo "make y-the-md   build dist/y-the-md only"
	@echo "make spice-ify  build dist/spice-ify.js and its yt-music-jam-api.js alias"
	@echo "make check      report missing build tools, build nothing"
