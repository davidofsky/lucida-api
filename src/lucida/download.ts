import { setTimeout as sleep } from 'node:timers/promises';

import { LucidaError, request } from './client.ts';
import {
  BASE_URL,
  MAX_ATTEMPTS,
  PREPARE_ATTEMPTS,
  PROCESSING_TIMEOUT_MS,
  RESUME_ATTEMPTS,
  RESUME_OVERLAP_BYTES,
  retryDelayMs,
  STATUS_POLL_INTERVAL_MS,
} from './constants.ts';
import type { DownloadConfig, Track, TrackDownload, TrackDownloadStatus } from './types.ts';

/** Just the part of fastify's logger this module uses. */
export interface Logger {
  info(payload: Record<string, unknown>, message: string): void;
}

/** lucida hands each download to one of its servers, addressed by subdomain. */
const handoffUrl = (download: TrackDownload): string =>
  `https://${download.server}.lucida.to/api/fetch/request/${download.handoff}`;

/**
 * The same status, fetched through lucida.to instead of the server directly.
 * lucida's own page polls both once a second, and a handoff nobody asks for
 * through the front door is liable to be dropped, so this mirrors it.
 */
const proxiedHandoffUrl = (download: TrackDownload): string =>
  `${BASE_URL}api/load?url=${encodeURIComponent(`/api/fetch/request/${download.handoff}`)}` +
  `&force=${download.server}`;

async function requestTrackDownload(
  track: Track,
  tokenExpiry: number,
  config: DownloadConfig,
  signal: AbortSignal,
  log: Logger,
): Promise<TrackDownload> {
  for (let attempt = 1; ; attempt++) {
    const loadUrl =
      `${BASE_URL}api/load?url=%2Fapi%2Ffetch%2Fstream%2Fv2` +
      (config.server === undefined ? '' : `&force=${encodeURIComponent(config.server)}`);

    const response = await request(loadUrl, {
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
        log.info({ server: body.server, attempt }, 'lucida handed the rip to a server');
        return body;
      }

      error = `lucida rejected the download request: ${body.error}`;
    } else {
      error = `lucida returned ${response.status} when requesting the download`;
    }

    if (attempt === MAX_ATTEMPTS) {
      throw new LucidaError(error, 502);
    }

    log.info({ attempt, error }, 'lucida refused the download request; retrying');
    await sleep(retryDelayMs(attempt), undefined, { signal });
  }
}

/**
 * Polls until lucida has the track ready.
 *
 * Returns `retry` instead of throwing when a handoff goes bad. lucida drops
 * handoffs that stop making progress — the status endpoint starts 404ing — and
 * the only way forward is to ask for a fresh one.
 *
 * That 404 is the only reliable sign a handoff is dead. The status payload is
 * just `{status, message}` with no progress in it, and a phase sits on one
 * fixed message for as long as it runs — `ripping` alone holds
 * "Ripping {item}..." for a minute on a full-length FLAC. So a status that
 * stops changing means nothing, and treating it as a wedge only throws away
 * handoffs that were working. The overall deadline is the backstop instead.
 */
async function waitUntilReady(
  download: TrackDownload,
  deadline: number,
  signal: AbortSignal,
  log: Logger,
): Promise<'ready' | 'retry'> {
  const started = Date.now();
  let seen = '';
  while (true) {
    const [response] = await Promise.all([
      request(handoffUrl(download), { signal }),
      // Kept alive alongside the direct poll; its body is of no interest here.
      request(proxiedHandoffUrl(download), { signal })
        .then((proxied) => proxied.text())
        .catch(() => undefined),
    ]);

    // lucida garbage-collects handoffs it has given up on
    if (response.status === 404 || response.status === 500) {
      log.info({ status: response.status }, 'lucida dropped the handoff; asking for another');
      return 'retry';
    }

    if (response.ok) {
      const status = (await response.json().catch(() => null)) as TrackDownloadStatus | null;

      if (status?.status === 'completed') {
        log.info({ ms: Date.now() - started }, 'lucida finished preparing the track');
        return 'ready';
      }

      if (status !== null && status.status !== seen) {
        seen = status.status;
        log.info({ phase: status.status, ms: Date.now() - started }, 'lucida is preparing the track');
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
 *
 * The body it returns survives a transfer dying halfway, which lucida's servers
 * do regularly on a long file — see `resumingBody`.
 */
export async function streamTrack(
  track: Track,
  tokenExpiry: number,
  config: DownloadConfig,
  signal: AbortSignal,
  log: Logger,
): Promise<TrackStream> {
  const stream = await prepareStream(track, tokenExpiry, config, signal, 0, log);

  return {
    mimeType: stream.mimeType,
    extension: stream.extension,
    // The client is told the size of the whole file, not of this first transfer.
    contentLength: stream.total === null ? null : String(stream.total),
    body: resumingBody(
      stream,
      (offset) => prepareStream(track, tokenExpiry, config, signal, offset, log),
      signal,
    ),
  };
}

/**
 * Asks lucida to prepare the track and opens the audio, starting at `offset`.
 * Each call gets its own budget: a resume happens after the first byte has
 * already been sent, so the original request's deadline says nothing about it.
 */
async function prepareStream(
  track: Track,
  tokenExpiry: number,
  config: DownloadConfig,
  signal: AbortSignal,
  offset: number,
  log: Logger,
): Promise<OpenStream> {
  const deadline = Date.now() + PROCESSING_TIMEOUT_MS;

  for (let attempt = 1; attempt <= PREPARE_ATTEMPTS; attempt++) {
    const download = await requestTrackDownload(track, tokenExpiry, config, signal, log);

    if ((await waitUntilReady(download, deadline, signal, log)) === 'ready') {
      const stream = await openTrackStream(download, deadline, signal, offset);

      if (stream !== null) return stream;
    }

    if (Date.now() >= deadline) break;
  }

  throw new LucidaError('lucida could not prepare this track; it may be unavailable', 504);
}

/**
 * Keeps one response going across as many upstream transfers as it takes.
 *
 * lucida hands out a prepared file exactly once — the handoff 404s the moment
 * its download connection ends — so a transfer that dies halfway cannot be
 * picked up where it stopped. The only way forward is a fresh rip, which the
 * `Range` header then fast-forwards to the byte we got to. Two rips of the same
 * track are byte-identical, and the overlap check below refuses to stitch
 * rather than emit a corrupt file if that ever stops being true.
 *
 * The client sees one continuous body throughout, just with a pause in it.
 */
function resumingBody(
  initial: OpenStream,
  reopen: (offset: number) => Promise<OpenStream>,
  signal: AbortSignal,
): ReadableStream<Uint8Array> {
  let reader = initial.body.getReader();
  let delivered = 0;
  let resumes = 0;
  // The last stretch of what went out, to match the re-ripped file against.
  let tail: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  // Bytes read past the overlap while resuming, owed to the client.
  let pending: Uint8Array<ArrayBufferLike> | null = null;

  const remember = (chunk: Uint8Array) => {
    const merged = concat([tail, chunk]);
    tail = merged.length <= RESUME_OVERLAP_BYTES ? merged : merged.subarray(merged.length - RESUME_OVERLAP_BYTES);
  };

  /** A body that stops short of the length lucida promised is a broken transfer. */
  const truncated = () => initial.total !== null && delivered < initial.total;

  const resume = async (cause: unknown): Promise<void> => {
    // The client walked away, or lucida never told us how long the file is and
    // a short body is indistinguishable from a complete one. Nothing to salvage.
    if (signal.aborted || !truncated() || resumes >= RESUME_ATTEMPTS) throw cause;
    resumes++;

    const overlap = Math.min(RESUME_OVERLAP_BYTES, delivered);
    const next = await reopen(delivered - overlap);

    if (next.total !== initial.total) {
      await next.body.cancel().catch(() => {});
      throw new LucidaError('lucida re-ripped this track at a different size; refusing to stitch it', 502);
    }

    const nextReader = next.body.getReader();

    if (overlap > 0) {
      const { head, rest } = await readExactly(nextReader, overlap);

      if (!Buffer.from(head).equals(Buffer.from(tail.subarray(tail.length - overlap)))) {
        await nextReader.cancel().catch(() => {});
        throw new LucidaError('lucida re-ripped this track differently; refusing to stitch it', 502);
      }

      pending = rest;
    }

    reader = nextReader;
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      while (true) {
        if (pending !== null) {
          const chunk = pending;
          pending = null;

          if (chunk.length > 0) {
            delivered += chunk.length;
            remember(chunk);
            controller.enqueue(chunk);
            return;
          }
        }

        let chunk: Awaited<ReturnType<typeof reader.read>>;

        try {
          chunk = await reader.read();
        } catch (error) {
          // Upstream died mid-body: re-rip and carry on, or give up for good.
          await resume(error);
          continue;
        }

        if (chunk.done) {
          if (truncated()) {
            await resume(new LucidaError('lucida closed the connection before the file was done', 502));
            continue;
          }

          controller.close();
          return;
        }

        delivered += chunk.value.length;
        remember(chunk.value);
        controller.enqueue(chunk.value);
        return;
      }
    },
    cancel(reason) {
      void reader.cancel(reason).catch(() => {});
    },
  });
}

/** Reads exactly `count` bytes, handing back whatever came over with them. */
async function readExactly(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  count: number,
): Promise<{ head: Uint8Array; rest: Uint8Array }> {
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (total < count) {
    const { value, done } = await reader.read();

    if (done) throw new LucidaError('lucida sent a shorter file when asked to resume', 502);

    chunks.push(value);
    total += value.length;
  }

  const all = concat(chunks);

  return { head: all.subarray(0, count), rest: all.subarray(count) };
}

function concat(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 1) return chunks[0]!;

  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let at = 0;

  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }

  return out;
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

/** One upstream transfer, which may be the whole file or the tail of it. */
interface OpenStream {
  body: ReadableStream<Uint8Array>;
  mimeType: string;
  extension: string;
  /** Size of the complete file, however much of it this transfer carries. */
  total: number | null;
}

async function openTrackStream(
  download: TrackDownload,
  deadline: number,
  signal: AbortSignal,
  offset: number,
): Promise<OpenStream | null> {
  for (let attempt = 1; ; attempt++) {
    const response = await request(
      `${handoffUrl(download)}/download`,
      offset > 0 ? { headers: { range: `bytes=${offset}-` }, signal } : { signal },
    );

    if (response.ok && response.body !== null) {
      const mimeType = response.headers.get('content-type') ?? 'application/octet-stream';
      const extension = MIME_EXTENSIONS[mimeType.split(';')[0]!.trim()];

      if (extension === undefined) {
        throw new LucidaError(`lucida returned unexpected audio type ${mimeType}`, 502);
      }

      const total = totalLength(response);

      // A 200 to a ranged request is the whole file over again, which would
      // duplicate everything already sent. Ask for a different handoff.
      if (offset > 0 && response.status !== 206) {
        await response.body.cancel().catch(() => {});
        return null;
      }

      return { body: response.body, mimeType, extension, total };
    }

    if (response.status === 404 || response.status === 500) return null;

    if (Date.now() >= deadline) {
      throw new LucidaError(`lucida returned ${response.status} when downloading the track`, 502);
    }

    await sleep(retryDelayMs(attempt), undefined, { signal });
  }
}

/** Size of the whole file: `content-range` knows it, `content-length` only does at offset 0. */
function totalLength(response: Response): number | null {
  const contentRange = response.headers.get('content-range');

  if (contentRange !== null) {
    const total = Number(contentRange.split('/')[1]);

    return Number.isFinite(total) ? total : null;
  }

  const contentLength = response.headers.get('content-length');

  return contentLength === null ? null : Number(contentLength);
}
