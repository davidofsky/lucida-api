import {
  AmazonError,
  DEFAULT_DOMAIN,
  FALLBACK_DEADLINE_MS,
  FALLBACK_DOMAINS,
  type SearchItem,
  amazonConfig,
  searchOnDomain,
  toMatch,
} from './client.ts';
import type { TrackMatch } from './schemas.ts';
import { type TrackQuery, normalize, score, splitFeature, tokensOf } from './matching.ts';

const MAX_RESULTS = 5;

// Finds the best-matching tracks, most likely first. 
export async function searchTracks(query: TrackQuery, signal: AbortSignal): Promise<TrackMatch[]> {
  const config = await amazonConfig(signal);
  const keyword = `${query.artist} ${query.track}`;
  const artistTokens = tokensOf(query.artist);
  const trackTokens = tokensOf(query.track);
  const feature = splitFeature(query.track);
  const coreTokens = tokensOf(feature.title);
  const featuredTokens = tokensOf(feature.featured);

  /**
   * Both sides must be accounted for. Amazon answers a query it cannot satisfy
   * with the artist's most popular songs, and a title searched on its own pulls
   * in every other act who recorded something by that name — so a candidate
   * matching only one side is the wrong track, and no result beats a wrong one.
   */
  const best = (items: SearchItem[]): TrackMatch[] => {
    const ranked = items
      .map(toMatch)
      .filter((match) => match !== null)
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

  const primary = best(await searchOnDomain(config, DEFAULT_DOMAIN, keyword, signal));

  if (primary.length > 0) return primary;

  // Pairing the two can drown the title: "Daft Punk Musique" returns Daft Punk's
  // ten most popular tracks and not "Musique", which the title alone finds first.
  const byTitle = best(await searchOnDomain(config, DEFAULT_DOMAIN, query.track, signal));

  if (byTitle.length > 0) return byTitle;

  const startedAt = Date.now();

  for (const domain of FALLBACK_DOMAINS) {
    if (Date.now() - startedAt > FALLBACK_DEADLINE_MS) break;

    try {
      const matches = best(await searchOnDomain(config, domain, keyword, signal));

      if (matches.length > 0) return matches;
    } catch {
      // marketplace unreachable — try the next one
    }
  }

  throw new AmazonError(`no track found for "${query.track}" by "${query.artist}"`, 404);
}
