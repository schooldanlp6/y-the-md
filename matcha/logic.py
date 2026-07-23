"""Logic / domain layer.

Track normalization and match scoring. Pure: no HTTP, no JSON, no Flask,
no network, no config. Everything here is deterministic and unit-testable.

The scoring model is a weighted composite of title, artist and duration
similarity, plus vetoes that cap confidence when a signal strongly suggests
we found the wrong *version* of a track (live, extended, cover, karaoke).
"""
from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field

from rapidfuzz import fuzz

# --------------------------------------------------------------------------
# Domain objects
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class Track:
    """A track as described by some platform. `id` is platform-scoped."""

    id: str
    title: str
    artists: tuple[str, ...] = ()
    album: str | None = None
    duration_ms: int | None = None
    isrc: str | None = None

    @property
    def artist(self) -> str:
        return ", ".join(self.artists)


@dataclass(frozen=True)
class Score:
    """Why we think two tracks are (or aren't) the same recording."""

    confidence: float
    title: float
    artist: float
    duration: float
    vetoes: tuple[str, ...] = field(default=())

    @property
    def matched(self) -> bool:
        return self.confidence >= ACCEPT_THRESHOLD


# --------------------------------------------------------------------------
# Tuning
# --------------------------------------------------------------------------

ACCEPT_THRESHOLD = 0.75

W_TITLE = 0.40
W_ARTIST = 0.35
W_DURATION = 0.25

# Wrong-version guards. Each caps final confidence rather than zeroing it,
# so a caller inspecting `vetoes` can still see the near-miss.
DURATION_VETO_MS = 30_000
DURATION_VETO_CAP = 0.40
# token_set_ratio never returns 0 for unrelated strings -- two entirely different
# artists still land around 0.2-0.5 on character overlap alone, while the same
# artist spelled differently sits well above 0.8. A floor of 0.30 let karaoke
# credits through; 0.50 sits in the empty band between the two populations.
ARTIST_VETO_FLOOR = 0.50
ARTIST_VETO_CAP = 0.45

# Bracketed segments containing any of these are noise, not part of the title.
# We only strip *known* noise — blanket-stripping brackets would destroy real
# titles like "Sgt. Pepper's Lonely Hearts Club Band (Reprise)", where the
# parenthetical marks a genuinely different recording.
_NOISE_TOKENS = (
    "remaster",
    "remastered",
    "radio edit",
    "single version",
    "album version",
    "original mix",
    "mono",
    "stereo",
    "deluxe",
    "bonus track",
    "official video",
    "official music video",
    "official audio",
    "music video",
    "lyric video",
    "lyrics video",
    "lyrics",
    "visualizer",
    "audio only",
    "hd",
    "hq",
    "4k",
    "explicit",
    "clean",
    "feat",
    "ft",
    "featuring",
    "with lyrics",
)

_BRACKETED = re.compile(r"[\(\[\{]([^\)\]\}]*)[\)\]\}]")
_FEAT_INLINE = re.compile(r"\s+(?:feat|ft|featuring)\.?\s+.*$", re.IGNORECASE)
_DASH_SUFFIX = re.compile(r"\s+-\s+([^-]*)$")
# Deleted, not spaced: platforms disagree on straight vs curly apostrophes, and
# splitting "Pepper's" into "pepper s" costs real similarity against "Peppers".
_APOSTROPHE = re.compile(r"['’ʼ`´]")
_NON_ALNUM = re.compile(r"[^a-z0-9\s]")
_WHITESPACE = re.compile(r"\s+")

# Artist credits that mark a re-recording rather than the artist we asked for.
# Rife in YouTube Music search results specifically.
_IMPOSTOR_ARTIST_TOKENS = (
    "karaoke",
    "tribute",
    "made popular by",
    "in the style of",
    "as made famous by",
    "cover band",
    "instrumental version",
    "backing track",
)


def _is_noise(segment: str) -> bool:
    low = segment.lower()
    return any(token in low for token in _NOISE_TOKENS)


def normalize_title(title: str) -> str:
    """Strip version noise and punctuation so titles compare fairly.

    "Bohemian Rhapsody (Remastered 2011)" and "Bohemian Rhapsody - Official
    Video" both reduce to "bohemian rhapsody".
    """
    if not title:
        return ""

    text = _BRACKETED.sub(lambda m: "" if _is_noise(m.group(1)) else m.group(0), title)
    text = _FEAT_INLINE.sub("", text)

    # A trailing " - Remastered 2011" is the same noise in dash form, but a
    # dash can also be structural ("Marie - Single Version" vs "Jack - Jill").
    dash = _DASH_SUFFIX.search(text)
    if dash and _is_noise(dash.group(1)):
        text = text[: dash.start()]

    return _clean(text)


def normalize_artist(artist: str) -> str:
    """Normalize an artist string, dropping the noise-word 'the'."""
    cleaned = _clean(_FEAT_INLINE.sub("", artist or ""))
    words = [w for w in cleaned.split() if w != "the"]
    return " ".join(words) or cleaned


def _clean(text: str) -> str:
    """Casefold, strip accents and punctuation, collapse whitespace."""
    decomposed = unicodedata.normalize("NFKD", text)
    ascii_only = "".join(c for c in decomposed if not unicodedata.combining(c))
    deapostrophed = _APOSTROPHE.sub("", ascii_only)
    lowered = _NON_ALNUM.sub(" ", deapostrophed.lower())
    return _WHITESPACE.sub(" ", lowered).strip()


# --------------------------------------------------------------------------
# Similarity
# --------------------------------------------------------------------------


def title_similarity(a: str, b: str) -> float:
    """Token-set ratio, so word order and extra words are forgiven."""
    na, nb = normalize_title(a), normalize_title(b)
    if not na or not nb:
        return 0.0
    return fuzz.token_set_ratio(na, nb) / 100.0


def artist_similarity(a: tuple[str, ...], b: tuple[str, ...]) -> float:
    """Best pairwise match across the two artist lists.

    Collaborations list artists inconsistently across platforms, so one solid
    overlap is worth more than comparing the joined strings.
    """
    left = [normalize_artist(x) for x in a if x and x.strip()]
    right = [normalize_artist(x) for x in b if x and x.strip()]
    if not left or not right:
        return 0.0

    best = max(
        fuzz.token_set_ratio(x, y) for x in left for y in right
    ) / 100.0
    joined = fuzz.token_set_ratio(" ".join(left), " ".join(right)) / 100.0
    return max(best, joined)


def _is_impostor_credit(track: Track) -> bool:
    """True if the artist or title credit announces a re-recording."""
    haystack = _clean(" ".join(track.artists) + " " + (track.title or ""))
    return any(token in haystack for token in _IMPOSTOR_ARTIST_TOKENS)


def duration_similarity(a: int | None, b: int | None) -> float:
    """Graded closeness of two runtimes.

    Neutral (0.5) when either side is unknown, so a missing duration neither
    rewards nor punishes.
    """
    if not a or not b:
        return 0.5

    delta = abs(a - b)
    if delta <= 2_000:
        return 1.0
    if delta <= 5_000:
        return 0.90
    if delta <= 10_000:
        return 0.70
    if delta <= 20_000:
        return 0.35
    return 0.0


# --------------------------------------------------------------------------
# Scoring
# --------------------------------------------------------------------------


def score(source: Track, candidate: Track) -> Score:
    """Score a candidate against the source track."""
    t = title_similarity(source.title, candidate.title)
    a = artist_similarity(source.artists, candidate.artists)
    d = duration_similarity(source.duration_ms, candidate.duration_ms)

    confidence = (t * W_TITLE) + (a * W_ARTIST) + (d * W_DURATION)

    # Same album is weak corroboration; cheap to include, capped small.
    if source.album and candidate.album:
        if fuzz.token_set_ratio(_clean(source.album), _clean(candidate.album)) >= 90:
            confidence = min(1.0, confidence + 0.05)

    vetoes: list[str] = []

    # A big runtime gap on a title that otherwise matches is the signature of
    # a live cut, extended mix or sped-up edit -- not the track we asked for.
    if source.duration_ms and candidate.duration_ms:
        if abs(source.duration_ms - candidate.duration_ms) > DURATION_VETO_MS:
            vetoes.append("duration_gap")
            confidence = min(confidence, DURATION_VETO_CAP)

    # Right title, wrong artist means a cover, karaoke or tribute version.
    if a < ARTIST_VETO_FLOOR:
        vetoes.append("artist_mismatch")
        confidence = min(confidence, ARTIST_VETO_CAP)

    # Some re-recordings announce themselves in the credit. Catch them by name
    # rather than relying on the similarity floor, which they can clear when the
    # real artist's name is also present ("Bohemian Rhapsody - Made Popular By Queen").
    if _is_impostor_credit(candidate) and not _is_impostor_credit(source):
        vetoes.append("impostor_credit")
        confidence = min(confidence, ARTIST_VETO_CAP)

    return Score(
        confidence=round(confidence, 4),
        title=round(t, 4),
        artist=round(a, 4),
        duration=round(d, 4),
        vetoes=tuple(vetoes),
    )


def best_match(source: Track, candidates: list[Track]) -> tuple[Track, Score] | None:
    """Highest-scoring candidate, or None if the list is empty.

    Returns the best candidate regardless of threshold -- deciding whether the
    score is good enough is `Score.matched`, so callers can log near-misses.
    """
    if not candidates:
        return None

    scored = [(c, score(source, c)) for c in candidates]
    scored.sort(key=lambda pair: pair[1].confidence, reverse=True)
    return scored[0]
