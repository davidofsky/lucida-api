import JSON5 from 'json5';
import { setTimeout as sleep } from 'node:timers/promises';

import { HttpError } from '../errors.ts';
import { LucidaError, request } from './client.ts';
import { BASE_URL, retryDelayMs } from './constants.ts';
import { type TrackQuery, normalize, score, splitFeature, tokensOf } from './matching.ts';
import type { TrackMatch } from './schemas.ts';

/** Each SvelteKit page node is embedded like this; the search results sit in one of them. */
const DATA_MARKER = '{"type":"data","data":';
const DATA_END = ',"uses"';

/**
 * lucida's search backend fails in bursts, answering every query — on every
 * service — with the same error until it recovers. Retrying past a couple of
 * attempts only makes a caller wait longer for the same answer.
 */
const SEARCH_ATTEMPTS = 3;

const MAX_RESULTS = 5;

type SearchOutcome =
  | { kind: 'tracks'; tracks: LucidaTrack[] }
  | { kind: 'error'; message: string }
  | { kind: 'unreadable' };

interface LucidaTrack {
  id?: string;
  title?: string;
  url?: string;
  artists?: { name?: string }[];
}

// Finds the best-matching tracks, most likely first.
export async function searchTracks(query: TrackQuery, signal: AbortSignal): Promise<TrackMatch[]> {
  const keyword = `${query.artist} ${query.track}`;
  const artistTokens = tokensOf(query.artist);
  const trackTokens = tokensOf(query.track);
  const feature = splitFeature(query.track);
  const coreTokens = tokensOf(feature.title);
  const featuredTokens = tokensOf(feature.featured);

  /**
   * Both sides must be accounted for. A query that cannot be satisfied comes
   * back as the artist's most popular songs, and a title searched on its own
   * pulls in every other act who recorded something by that name — so a
   * candidate matching only one side is the wrong track, and no result beats a
   * wrong one.
   */
  const best = (matches: TrackMatch[]): TrackMatch[] => {
    const ranked = matches
      .map((match) => score(match, artistTokens, trackTokens, coreTokens, featuredTokens))
      .filter((candidate) => candidate.titleComplete && candidate.artistComplete)
      .sort((a, b) => b.score - a.score);

    // The same recording turns up under several releases with different ids, so
    // collapse on what the caller actually sees. Genuine variants — a live take,
    // a radio edit — differ in title and are kept as separate choices.
    const seen = new Set<string>();
    const results: TrackMatch[] = [];

    for (const { match } of ranked) {
      const key = `${normalize(match.title)}|${normalize(match.artist)}`;

      if (seen.has(key)) continue;

      seen.add(key);
      results.push(match);

      if (results.length === MAX_RESULTS) break;
    }

    return results;
  };

  const primary = best(await fetchTracks(keyword, signal));

  if (primary.length > 0) return primary;

  // Pairing the two can drown the title: "Daft Punk Musique" returns Daft Punk's
  // ten most popular tracks and not "Musique", which the title alone finds first.
  const byTitle = best(await fetchTracks(query.track, signal));

  if (byTitle.length > 0) return byTitle;

  throw new HttpError(`no track found for "${query.track}" by "${query.artist}"`, 404);
}

/**
 * Asks lucida to search Amazon Music, which is how its own search page works:
 * `/search?query=…&service=amazon`, with the results server-rendered into the
 * page's hydration payload.
 *
 * Amazon's catalog API used to be queried directly, but it stopped handing out
 * anonymous access tokens and now answers every search with a "Service error".
 * lucida is already authenticated for the download, so it costs nothing extra.
 */
async function fetchTracks(query: string, signal: AbortSignal): Promise<TrackMatch[]> {
  const target = new URL('search', BASE_URL);
  target.searchParams.set('query', query);
  target.searchParams.set('service', 'amazon');

  for (let attempt = 1; ; attempt++) {
    let error: string;

    const response = await request(target.href, { signal });

    if (response.ok) {
      const outcome = read(await response.text());

      // An empty result set is an answer, not a failure: the caller decides
      // whether to widen the query.
      if (outcome.kind === 'tracks') {
        return outcome.tracks.map(toMatch).filter((match) => match !== null);
      }

      error =
        outcome.kind === 'error'
          ? `lucida could not search: ${outcome.message}`
          : 'lucida returned a search page that could not be read';
    } else {
      error = `lucida returned ${response.status} for the search`;
    }

    if (attempt === SEARCH_ATTEMPTS) throw new LucidaError(error, 502);

    await sleep(retryDelayMs(attempt), undefined, { signal });
  }
}

/**
 * Reads the search outcome out of the page.
 *
 * lucida reports a backend failure as `success: false` with a message rather
 * than an HTTP error, so that is told apart from a payload that will not parse
 * at all — the first is worth reporting to the caller, the second is worth
 * re-fetching.
 *
 * The page carries one data node per SvelteKit layer (translations in one, the
 * results in another), so every node is tried rather than assuming an order.
 */
function read(html: string): SearchOutcome {
  for (let index = html.indexOf(DATA_MARKER); index !== -1; index = html.indexOf(DATA_MARKER, index + 1)) {
    const tail = html.slice(index + DATA_MARKER.length);
    const end = tail.indexOf(DATA_END);

    if (end === -1) continue;

    try {
      const node = JSON5.parse<{
        results?: { success?: boolean; error?: string; results?: { tracks?: LucidaTrack[] } };
      }>(tail.slice(0, end));

      if (node.results === undefined) continue;

      const tracks = node.results.results?.tracks;

      if (Array.isArray(tracks)) return { kind: 'tracks', tracks };

      if (node.results.success === false) {
        return { kind: 'error', message: node.results.error ?? 'no reason given' };
      }
    } catch {
      // not the node we are after, or lucida served a payload that will not parse
    }
  }

  return { kind: 'unreadable' };
}

function toMatch(track: LucidaTrack): TrackMatch | null {
  const artist = (track.artists ?? [])
    .map((entry) => entry.name)
    .filter((name) => name !== undefined && name !== '')
    .join(', ');

  if (track.id === undefined || track.id === '' || track.url === undefined) return null;

  return {
    id: track.id,
    title: track.title ?? 'Unknown Title',
    artist: artist === '' ? 'Unknown Artist' : artist,
    url: track.url,
  };
}
