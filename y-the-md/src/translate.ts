/**
 * Translation between endpoint shapes and matcha's wire format.
 *
 * Kept separate from both so neither has to know the other's field names.
 */
import type { MatchaTrack } from './matcha.ts';
import type { NowPlaying, QueueItem } from './endpoints/types.ts';

/**
 * Split a credit string into artists.
 *
 * api-server gives one string; YouTube Music credits collaborations with a
 * variety of separators. matcha scores artists pairwise, so splitting helps it
 * match "A & B" against Spotify's ["A", "B"].
 */
export function splitArtists(credit: string | undefined): string[] {
  if (!credit?.trim()) return [];
  return credit
    .split(/\s*(?:,|&|feat\.?|ft\.?|featuring|\bx\b|\+)\s*/i)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function nowPlayingToMatcha(song: NowPlaying): MatchaTrack | undefined {
  if (!song.title) return undefined;
  return {
    id: song.videoId,
    title: song.title,
    artists: splitArtists(song.artist),
    album: song.album,
    duration_ms: song.durationMs,
  };
}

export function queueItemToMatcha(item: QueueItem): MatchaTrack {
  return {
    id: item.videoId,
    title: item.title ?? item.videoId,
    artists: splitArtists(item.artist),
    duration_ms: item.durationMs,
  };
}
