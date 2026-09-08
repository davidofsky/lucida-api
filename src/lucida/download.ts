import { setTimeout as sleep } from 'node:timers/promises';

import { LucidaError, request } from './client.ts';
import {
  BASE_URL,
  MAX_ATTEMPTS,
  PREPARE_ATTEMPTS,
  PROCESSING_TIMEOUT_MS,
  RETRY_DELAY_MS,
  STATUS_POLL_INTERVAL_MS,
  STUCK_TIMEOUT_MS,
} from './constants.ts';
import type { DownloadConfig, Track, TrackDownload, TrackDownloadStatus } from './types.ts';

/** lucida hands each download to one of its servers, addressed by subdomain. */
const handoffUrl = (download: TrackDownload): string =>
  `https://${download.server}.lucida.to/api/fetch/request/${download.handoff}`;

async function requestTrackDownload(
  track: Track,
  tokenExpiry: number,
  config: DownloadConfig,
  signal: AbortSignal,
): Promise<TrackDownload> {
  for (let attempt = 1; ; attempt++) {
    const response = await request(`${BASE_URL}api/load?url=%2Fapi%2Ffetch%2Fstream%2Fv2`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        account: { id: config.country, type: 'country' },
        compat: false,
        downscale: 'original',
        handoff: true,
        metadata: config.metadata,
        private: config.private,
        token: {
          expiry: tokenExpiry,
          primary: track.csrf ?? null,
          secondary: track.csrfFallback ?? null,
        },
        upload: { enabled: false },
        url: track.url,
      }),
      signal,
    });

    let error: string;

    if (response.ok) {
      const body = (await response.json()) as TrackDownload | { error: string };

      if ('handoff' in body) {
        return body;
      }

      error = `lucida rejected the download request: ${body.error}`;
    } else {
      error = `lucida returned ${response.status} when requesting the download`;
    }

    if (attempt === MAX_ATTEMPTS) {
      throw new LucidaError(error, 502);
    }

    await sleep(RETRY_DELAY_MS, undefined, { signal });
  }
}

/**
 * Polls until lucida has the track ready.
 *
 * Returns `retry` instead of throwing when a handoff goes bad. lucida drops
 * handoffs that stop making progress — the status endpoint starts 404ing — and
 * the only way forward is to ask for a fresh one.
 */
async function waitUntilReady(
  download: TrackDownload,
  deadline: number,
  signal: AbortSignal,
): Promise<'ready' | 'retry'> {
  let last = { status: '', message: '', since: Date.now() };

  while (true) {
    const response = await request(
      handoffUrl(download),
      { signal },
    );

    // lucida garbage-collects handoffs it has given up on
    if (response.status === 404 || response.status === 500) return 'retry';

    if (response.ok) {
      const status = (await response.json().catch(() => null)) as TrackDownloadStatus | null;

      if (status?.status === 'completed') return 'ready';

      if (status !== null && (status.status !== last.status || status.message !== last.message)) {
        last = { status: status.status, message: status.message, since: Date.now() };
      } else if (Date.now() - last.since >= STUCK_TIMEOUT_MS) {
        return 'retry';
      }
    }

    if (Date.now() >= deadline) {
      throw new LucidaError('timed out waiting for lucida to prepare the track', 504);
    }

    await sleep(STATUS_POLL_INTERVAL_MS, undefined, { signal });
  }
}

/**
 * Gets the track's audio, asking lucida for a brand new handoff whenever the
 * current one goes stale. Mirrors the downloader's `'request_track_download`
 * loop: a dropped handoff, a wedged status, or a failed audio fetch all mean
 * "start over" rather than "give up".
 */
export async function streamTrack(
  track: Track,
  tokenExpiry: number,
  config: DownloadConfig,
  signal: AbortSignal,
): Promise<TrackStream> {
  const deadline = Date.now() + PROCESSING_TIMEOUT_MS;

  for (let attempt = 1; attempt <= PREPARE_ATTEMPTS; attempt++) {
    const download = await requestTrackDownload(track, tokenExpiry, config, signal);

    if ((await waitUntilReady(download, deadline, signal)) === 'ready') {
      const stream = await openTrackStream(download, deadline, signal);

      if (stream !== null) return stream;
    }

    if (Date.now() >= deadline) break;
  }

  throw new LucidaError('lucida could not prepare this track; it may be unavailable', 504);
}

export const MIME_EXTENSIONS: Record<string, string> = {
  'audio/flac': 'flac',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/opus': 'opus',
  // Opus is usually delivered in an Ogg container, under the container's type
  'audio/ogg': 'opus',
};

export interface TrackStream {
  body: ReadableStream<Uint8Array>;
  mimeType: string;
  extension: string;
  contentLength: string | null;
}

async function openTrackStream(
  download: TrackDownload,
  deadline: number,
  signal: AbortSignal,
): Promise<TrackStream | null> {
  while (true) {
    const response = await request(
      `${handoffUrl(download)}/download`,
      { signal },
    );

    if (response.ok && response.body !== null) {
      const mimeType = response.headers.get('content-type') ?? 'application/octet-stream';
      const extension = MIME_EXTENSIONS[mimeType.split(';')[0]!.trim()];

      if (extension === undefined) {
        throw new LucidaError(`lucida returned unexpected audio type ${mimeType}`, 502);
      }

      return {
        body: response.body,
        mimeType,
        extension,
        contentLength: response.headers.get('content-length'),
      };
    }

    if (response.status === 404 || response.status === 500) return null;

    if (Date.now() >= deadline) {
      throw new LucidaError(`lucida returned ${response.status} when downloading the track`, 502);
    }

    await sleep(RETRY_DELAY_MS, undefined, { signal });
  }
}
