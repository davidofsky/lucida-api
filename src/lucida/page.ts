import JSON5 from 'json5';
import { setTimeout as sleep } from 'node:timers/promises';

import { LucidaError, request } from './client.ts';
import { BASE_URL, MAX_ATTEMPTS, retryDelayMs, TRANSIENT_PAGE_ERRORS } from './constants.ts';
import { parseEnclosedValue } from './text.ts';
import type { PageData, Track } from './types.ts';

/** Resolves a service URL to the page data lucida embeds in its HTML. */
export async function resolvePage(
  url: string,
  country: string,
  signal: AbortSignal,
): Promise<PageData> {
  for (let attempt = 1; ; attempt++) {
    const target = new URL(BASE_URL);
    target.searchParams.set('url', url);
    target.searchParams.set('country', country);

    const response = await request(target.href, { signal });

    let error: string | undefined;

    if (response.status === 403) {
      throw new LucidaError(
        'lucida answered with a captcha challenge; the clearance cookie is stale or invalid',
        503,
      );
    } else if (!response.ok) {
      error = `lucida returned ${response.status} when resolving the URL`;
    } else {
      const html = await response.text();
      const pageError = TRANSIENT_PAGE_ERRORS.find((candidate) => html.includes(candidate));

      if (pageError === undefined) {
        const parsed = parsePageData(html);

        if (parsed.ok) return parsed.data;

        error = parsed.error;
      } else {
        error = `lucida failed to resolve the URL: ${pageError}`;
      }
    }

    if (attempt === MAX_ATTEMPTS) {
      throw new LucidaError(error, 502);
    }

    await sleep(retryDelayMs(attempt), undefined, { signal });
  }
}

type ParseResult = { ok: true; data: PageData } | { ok: false; error: string };

/**
 * lucida occasionally serves a payload that will not parse. A re-fetch comes back
 * clean, so this reports the failure instead of throwing and lets the resolve loop
 * treat it like any other transient page error.
 */
function parsePageData(html: string): ParseResult {
  try {
    const data = parseEnclosedValue(',{"type":"data","data":', ',"uses":{"url":1}}];\n', html);

    try {
      return { ok: true, data: JSON5.parse<PageData>(data) };
    } catch (cause) {
      const column = (cause as { columnNumber?: number }).columnNumber ?? 0;
      const near = data.slice(Math.max(0, column - 100), column + 50);

      return { ok: false, error: `unreadable page data (${(cause as Error).message}) near ${near}` };
    }
  } catch (cause) {
    return { ok: false, error: (cause as Error).message };
  }
}

// Builds the `Track` the download API expects out of a resolved single-track page.
export function trackFromPage(pageData: PageData): Track {
  const { info } = pageData;

  if (info.type !== 'track') {
    throw new LucidaError(
      `this URL points to a ${info.type}; only track URLs can be downloaded`,
      400,
    );
  }

  return {
    title: info.title,
    url: info.url,
    artists: info.artists,
    csrf: pageData.token ?? null,
    csrfFallback: null,
  };
}
