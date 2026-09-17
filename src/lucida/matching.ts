import type { TrackMatch } from './schemas.ts';

/** Ranking a search result against what the caller actually asked for. */
export function normalize(text: string): string {
  return text
    // Decompose then drop the accents, so a query for "Bjork" matches "Björk"
    // rather than tearing it into "bj" and "rk".
    .normalize('NFD')
    .replaceAll(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replaceAll('&', ' and ')
    .replaceAll(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function tokensOf(text: string): string[] {
  return normalize(text).split(' ').filter((token) => token !== '');
}

/** Fraction of `words` that appear in `vocabulary`. */
function fractionIn(words: string[], vocabulary: Set<string>): number {
  if (words.length === 0) return 0;

  return words.filter((word) => vocabulary.has(word)).length / words.length;
}

export interface TrackQuery {
  artist: string;
  track: string;
}

/**
 * Words marking a recording that is not the studio original. Amazon's catalogue
 * is thick with live cuts, radio edits and spoken-word commentary that carry the
 * real title *and* the real artist, so no amount of title/artist matching tells
 * them apart — searching "King Crimson / 21st Century Schizoid Man" returns ten
 * variants and no plain studio version.
 */
const VARIANT_MARKERS = new Set([
  'live',
  'commentary',
  'interview',
  'karaoke',
  'instrumental',
  'cover',
  'tribute',
  'remix',
  'mix',
  'edit',
  'version',
  'radio',
  'demo',
  'acoustic',
  'rehearsal',
  'session',
  'sessions',
  'sped',
  'slowed',
]);

/**
 * Splits "Song (feat. X & Y)" into the title proper and the featured credit.
 * Releases file that credit under either field — Amazon lists "Coming up Low"
 * with the guests in the artist — so the two halves are matched separately.
 */
export function splitFeature(track: string): { title: string; featured: string } {
  const marker = /[([]?\s*\b(?:feat|ft|featuring)\b\.?\s*/i.exec(track);

  if (marker === null) return { title: track, featured: '' };

  return {
    title: track.slice(0, marker.index),
    featured: track.slice(marker.index + marker[0].length),
  };
}

/** Articles carrying no identity, so "The Beatles" still matches "Beatles". */
const ARTIST_STOPWORDS = new Set(['the', 'a', 'an', 'and', 'of']);

/** Whether the title advertises a variant the caller did not ask for. */
function isVariant(titleTokens: string[], trackTokens: Set<string>): boolean {
  return titleTokens.some((token) => VARIANT_MARKERS.has(token) && !trackTokens.has(token));
}

/**
 * Amazon ranks results by artist relevance and largely ignores the title, so a
 * search puts the requested song well down the list behind that artist's more
 * popular tracks. Score every candidate instead of trusting the order.
 *
 * Each side of the query is matched against the field it belongs to. Covers
 * advertise themselves as "<title> (<real artist> Cover)", so letting a title
 * satisfy the artist would rank the cover above the original.
 */
interface Scored {
  match: TrackMatch;
  score: number;
  /** Every word of the requested title appears in this result's title. */
  titleComplete: boolean;
  /** Every identifying word of the requested artist appears in this result's artist. */
  artistComplete: boolean;
}

export function score(
  match: TrackMatch,
  artistTokens: string[],
  trackTokens: string[],
  coreTokens: string[],
  featuredTokens: string[],
): Scored {
  const titleTokens = tokensOf(match.title);
  const wanted = new Set(trackTokens);

  const artistVocabulary = new Set(tokensOf(match.artist));

  const titleMatch = fractionIn(trackTokens, new Set(titleTokens));
  const artistMatch = fractionIn(artistTokens, artistVocabulary);

  // Sharing one generic word is not the same artist: "Daft Punk" must not match
  // "Piano Punk". Every identifying word has to be there.
  const named = artistTokens.filter((token) => !ARTIST_STOPWORDS.has(token));

  // How little of the title is padding, to prefer a plain title over a longer one.
  const precision = fractionIn(titleTokens, wanted);

  // Outweighs precision, because a short suffix is not the same as a harmless
  // one: "- Commentary" is tidier than '(Including "Mirrors")' but is not the song.
  const variant = isVariant(titleTokens, wanted) ? 5 : 0;

  const inTitle = new Set(titleTokens);
  const eitherField = new Set([...titleTokens, ...artistVocabulary]);

  return {
    match,
    score: titleMatch * 10 + artistMatch * 6 + precision * 3 - variant,
    titleComplete:
      coreTokens.every((token) => inTitle.has(token)) &&
      featuredTokens.every((token) => eitherField.has(token)),
    artistComplete: named.length > 0 && named.every((token) => artistVocabulary.has(token)),
  };
}
