"""Unit tests for the pure scoring layer.

No network, no credentials, no Flask. These cover the parts that are actually
subtle: version-noise stripping and the wrong-version vetoes.
"""
from __future__ import annotations

import pytest

from matcha.logic import (
    ACCEPT_THRESHOLD,
    Track,
    artist_similarity,
    best_match,
    duration_similarity,
    normalize_artist,
    normalize_title,
    score,
    title_similarity,
)


def track(title, artists=("Artist",), duration_ms=210_000, **kw) -> Track:
    return Track(
        id=kw.pop("id", "x"),
        title=title,
        artists=tuple(artists),
        duration_ms=duration_ms,
        **kw,
    )


# --------------------------------------------------------------------------
# Normalization
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("Bohemian Rhapsody", "bohemian rhapsody"),
        ("Bohemian Rhapsody (Remastered 2011)", "bohemian rhapsody"),
        ("Bohemian Rhapsody [Official Video]", "bohemian rhapsody"),
        ("Bohemian Rhapsody - Remastered 2011", "bohemian rhapsody"),
        ("Bohemian Rhapsody (Official Music Video)", "bohemian rhapsody"),
        ("Levitating (feat. DaBaby)", "levitating"),
        ("Levitating feat. DaBaby", "levitating"),
        ("Blinding Lights - Radio Edit", "blinding lights"),
        ("Song (Lyrics)", "song"),
        ("Café del Mar", "cafe del mar"),
        ("¿Dónde Estás?", "donde estas"),
    ],
)
def test_normalize_title_strips_version_noise(raw, expected):
    assert normalize_title(raw) == expected


@pytest.mark.parametrize(
    "raw,expected",
    [
        # A parenthetical that names a genuinely different recording must survive.
        ("Sgt. Pepper's Lonely Hearts Club Band (Reprise)", "sgt peppers lonely hearts club band reprise"),
        ("Blue Monday (1988)", "blue monday 1988"),
        ("Marie - Jack", "marie jack"),
    ],
)
def test_normalize_title_keeps_meaningful_brackets(raw, expected):
    assert normalize_title(raw) == expected


@pytest.mark.parametrize(
    "raw",
    [
        "Sgt. Pepper's Lonely Hearts Club Band",   # straight quote
        "Sgt. Pepper’s Lonely Hearts Club Band",  # curly quote
        "Sgt. Peppers Lonely Hearts Club Band",    # no apostrophe at all
    ],
)
def test_apostrophe_variants_normalize_identically(raw):
    # Platforms disagree on straight vs curly vs omitted apostrophes; all three
    # spellings must collapse to the same string or similarity is lost for free.
    assert normalize_title(raw) == "sgt peppers lonely hearts club band"


def test_normalize_artist_drops_leading_the():
    assert normalize_artist("The Beatles") == "beatles"
    assert normalize_artist("Beatles") == "beatles"


def test_normalize_title_handles_empty():
    assert normalize_title("") == ""


# --------------------------------------------------------------------------
# Similarity primitives
# --------------------------------------------------------------------------


def test_title_similarity_ignores_version_noise():
    assert title_similarity("Bohemian Rhapsody", "Bohemian Rhapsody (Remastered)") == 1.0


def test_title_similarity_distinguishes_different_songs():
    assert title_similarity("Bohemian Rhapsody", "Another One Bites the Dust") < 0.5


def test_artist_similarity_survives_collaborator_ordering():
    a = ("Calvin Harris", "Dua Lipa")
    b = ("Dua Lipa", "Calvin Harris")
    assert artist_similarity(a, b) == 1.0


def test_artist_similarity_matches_on_partial_credit_list():
    # Platforms disagree about whether featured artists are credited.
    assert artist_similarity(("Dua Lipa",), ("Dua Lipa", "DaBaby")) > 0.9


def test_artist_similarity_empty_is_zero():
    assert artist_similarity((), ("Someone",)) == 0.0


@pytest.mark.parametrize(
    "a,b,expected",
    [
        (210_000, 210_000, 1.0),
        (210_000, 211_500, 1.0),
        (210_000, 214_000, 0.90),
        (210_000, 219_000, 0.70),
        (210_000, 228_000, 0.35),
        (210_000, 400_000, 0.0),
    ],
)
def test_duration_similarity_grades_by_gap(a, b, expected):
    assert duration_similarity(a, b) == expected


def test_duration_similarity_is_neutral_when_unknown():
    assert duration_similarity(None, 210_000) == 0.5
    assert duration_similarity(210_000, None) == 0.5


# --------------------------------------------------------------------------
# Scoring
# --------------------------------------------------------------------------


def test_identical_track_scores_high():
    src = track("Bohemian Rhapsody", ("Queen",), 354_000)
    assert score(src, src).confidence >= 0.99


def test_remaster_still_matches_the_original():
    src = track("Bohemian Rhapsody", ("Queen",), 354_000)
    cand = track("Bohemian Rhapsody (Remastered 2011)", ("Queen",), 355_000)
    result = score(src, cand)
    assert result.matched
    assert not result.vetoes


def test_live_version_is_vetoed_on_duration():
    src = track("Bohemian Rhapsody", ("Queen",), 354_000)
    cand = track("Bohemian Rhapsody (Live at Wembley)", ("Queen",), 402_000)
    result = score(src, cand)
    assert "duration_gap" in result.vetoes
    assert not result.matched


def test_cover_is_vetoed_on_artist():
    src = track("Bohemian Rhapsody", ("Queen",), 354_000)
    cand = track("Bohemian Rhapsody", ("Karaoke Hits Ensemble",), 354_000)
    result = score(src, cand)
    assert "artist_mismatch" in result.vetoes
    assert not result.matched


@pytest.mark.parametrize(
    "impostor",
    [
        ("Karaoke Band",),
        ("The Karaoke Channel",),
        ("Tribute Players",),
        ("Made Popular By Queen",),
        ("In The Style Of Queen",),
    ],
)
def test_impostor_credits_are_vetoed(impostor):
    # These clear the artist-similarity floor when the real name is present in
    # the credit, so they need catching by name.
    src = track("Bohemian Rhapsody", ("Queen",), 354_000)
    result = score(src, track("Bohemian Rhapsody", impostor, 354_000))
    assert not result.matched
    assert result.vetoes


def test_impostor_veto_does_not_fire_when_source_is_also_karaoke():
    # Syncing a karaoke track should still find the karaoke track.
    src = track("Bohemian Rhapsody", ("Karaoke Band",), 354_000)
    cand = track("Bohemian Rhapsody", ("Karaoke Band",), 354_000)
    assert "impostor_credit" not in score(src, cand).vetoes


def test_different_song_same_artist_does_not_match():
    src = track("Bohemian Rhapsody", ("Queen",), 354_000)
    cand = track("Another One Bites the Dust", ("Queen",), 215_000)
    assert not score(src, cand).matched


def test_missing_duration_does_not_block_a_good_match():
    src = track("Bohemian Rhapsody", ("Queen",), None)
    cand = track("Bohemian Rhapsody", ("Queen",), 354_000)
    assert score(src, cand).matched


def test_album_agreement_nudges_confidence_up():
    src = Track("a", "Song", ("Artist",), "The Album", 210_000)
    with_album = Track("b", "Song", ("Artist",), "The Album", 210_000)
    without = Track("c", "Song", ("Artist",), "Other Record", 210_000)
    assert score(src, with_album).confidence >= score(src, without).confidence


def test_score_is_bounded():
    src = Track("a", "Song", ("Artist",), "Album", 210_000)
    assert 0.0 <= score(src, src).confidence <= 1.0


# --------------------------------------------------------------------------
# Candidate selection
# --------------------------------------------------------------------------


def test_best_match_prefers_the_studio_cut_over_the_live_one():
    src = track("Creep", ("Radiohead",), 238_000)
    candidates = [
        track("Creep (Live)", ("Radiohead",), 295_000, id="live"),
        track("Creep", ("Radiohead",), 238_000, id="studio"),
        track("Creep", ("Some Cover Band",), 238_000, id="cover"),
    ]
    best, result = best_match(src, candidates)
    assert best.id == "studio"
    assert result.matched


def test_best_match_returns_none_for_no_candidates():
    assert best_match(track("Anything"), []) is None


def test_best_match_returns_near_miss_below_threshold():
    src = track("Creep", ("Radiohead",), 238_000)
    best, result = best_match(src, [track("Creep", ("Karaoke Band",), 238_000)])
    # Returned for logging, but flagged as not good enough to act on.
    assert best is not None
    assert not result.matched
    assert result.confidence < ACCEPT_THRESHOLD
