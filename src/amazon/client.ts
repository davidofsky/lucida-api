/**
 * Track search against Amazon Music's private catalog API, so a lucida download
 * can start from a song name instead of a URL.
 */

import { HttpError } from '../errors.ts';
import type { TrackMatch } from './schemas.ts';

const CONFIG_URL = 'https://music.amazon.com/config.json';
const TRACKS_SEARCH_URL = 'https://eu.mesk.skill.music.a2z.com/api/searchCatalogTracks';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36';

export const DEFAULT_DOMAIN = 'music.amazon.com';

export const FALLBACK_DOMAINS = [
  'music.amazon.co.uk',
  'music.amazon.de',
  'music.amazon.co.jp',
  'music.amazon.in',
  'music.amazon.ca',
  'music.amazon.fr',
  'music.amazon.it',
  'music.amazon.es',
  'music.amazon.com.au',
  'music.amazon.com.br',
  'music.amazon.com.mx',
];

// Stops a few unresponsive marketplaces stretching a no-hit query out forever.
export const FALLBACK_DEADLINE_MS = 8000;
const REQUEST_TIMEOUT_MS = 5000;
const CONFIG_TTL_MS = 1_800_000;

export class AmazonError extends HttpError {}

interface AmazonConfig {
  accessToken?: string;
  deviceId?: string;
  sessionId?: string;
  version?: string;
  csrf?: { token?: string; ts?: string | number; rnd?: string | number };
}

let cachedConfig: { value: AmazonConfig; expires: number } | null = null;

export async function amazonConfig(signal: AbortSignal): Promise<AmazonConfig> {
  if (cachedConfig !== null && Date.now() < cachedConfig.expires) return cachedConfig.value;

  const response = await fetch(CONFIG_URL, {
    headers: { 'user-agent': USER_AGENT, accept: '*/*' },
    signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
  });

  if (!response.ok) {
    throw new AmazonError(`Amazon returned ${response.status} for its player config`, 502);
  }

  const value = (await response.json()) as AmazonConfig;
  cachedConfig = { value, expires: Date.now() + CONFIG_TTL_MS };

  return value;
}

/** The `x-amzn-*` header bundle the web player sends, passed as a JSON string. */
function amazonHeaders(config: AmazonConfig, domain: string, pageUrl: string): Record<string, string> {
  return {
    'x-amzn-authentication': JSON.stringify({
      interface: 'ClientAuthenticationInterface.v1_0.ClientTokenElement',
      accessToken: config.accessToken ?? '',
    }),
    'x-amzn-device-model': 'WEBPLAYER',
    'x-amzn-device-width': '1920',
    'x-amzn-device-height': '1080',
    'x-amzn-device-family': 'WebPlayer',
    'x-amzn-device-id': config.deviceId ?? '',
    'x-amzn-session-id': config.sessionId ?? '',
    'x-amzn-user-agent': USER_AGENT,
    'x-amzn-request-id': Math.random().toString(36).slice(2, 15),
    'x-amzn-device-language': 'en_US',
    'x-amzn-currency-of-preference': 'USD',
    'x-amzn-os-version': '1.0',
    'x-amzn-application-version': config.version ?? '',
    'x-amzn-device-time-zone': 'UTC',
    'x-amzn-timestamp': String(Date.now()),
    'x-amzn-csrf': JSON.stringify({
      interface: 'CSRFInterface.v1_0.CSRFHeaderElement',
      token: config.csrf?.token ?? '',
      timestamp: String(config.csrf?.ts ?? ''),
      rndNonce: String(config.csrf?.rnd ?? ''),
    }),
    'x-amzn-music-domain': domain,
    'x-amzn-referer': domain,
    'x-amzn-page-url': pageUrl,
    'x-amzn-affiliate-tags': '',
    'x-amzn-ref-marker': '',
    'x-amzn-weblab-id-overrides': '',
    'x-amzn-video-player-token': '',
    'x-amzn-feature-flags': 'hd-supported,uhd-supported',
    'x-amzn-has-profile-id': '',
    'x-amzn-age-band': '',
  };
}

export interface SearchItem {
  iconButton?: { observer?: { storageKey?: string } };
  primaryText?: { text?: string };
  secondaryText?: string;
}

function itemsOf(body: unknown): SearchItem[] {
  const widgets = (body as { methods?: { template?: { widgets?: { items?: SearchItem[] }[] } }[] })
    ?.methods?.[0]?.template?.widgets;

  return widgets?.[0]?.items ?? [];
}

export async function searchOnDomain(
  config: AmazonConfig,
  domain: string,
  query: string,
  signal: AbortSignal,
): Promise<SearchItem[]> {
  const pageUrl = `https://${domain}/search/${encodeURIComponent(query)}/songs`;

  const response = await fetch(TRACKS_SEARCH_URL, {
    method: 'POST',
    headers: {
      accept: '*/*',
      'content-type': 'text/plain;charset=UTF-8',
      origin: `https://${domain}`,
      referer: `https://${domain}/`,
      'user-agent': USER_AGENT,
    },
    body: JSON.stringify({
      keyword: query,
      userHash: JSON.stringify({ level: 'LIBRARY_MEMBER' }),
      headers: JSON.stringify(amazonHeaders(config, domain, pageUrl)),
    }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
  });

  if (!response.ok) return [];

  return itemsOf(await response.json().catch(() => null));
}

// The track id lives in the play button's storage key, as `albumId:trackId`.
export function toMatch(item: SearchItem): TrackMatch | null {
  const id = item.iconButton?.observer?.storageKey?.split(':')[1];

  if (id === undefined || id === '') return null;

  return {
    id,
    title: item.primaryText?.text ?? 'Unknown Title',
    artist: item.secondaryText ?? 'Unknown Artist',
    url: `https://music.amazon.com/tracks/${id}`,
  };
}
