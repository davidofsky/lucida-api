export const BASE_URL = 'https://lucida.to/';

export const TRANSIENT_PAGE_ERRORS = [
  'An error occured trying to process your request.',
  'Message: "Cannot contact any valid server"',
  'An error occurred. Had an issue getting that item, try again.',
];

export const MAX_ATTEMPTS = 5;

/**
 * A rejected load or an unparsable page is usually a one-off from whichever
 * lucida server answered — the same request typically succeeds straight after —
 * so the first retry goes out almost immediately and only repeats back off.
 */
const RETRY_DELAYS_MS = [500, 2000, 5000, 5000];

export const retryDelayMs = (attempt: number): number => RETRY_DELAYS_MS[attempt - 1] ?? 5000;

// Overall budget for getting a track prepared, across every attempt.
export const PROCESSING_TIMEOUT_MS = 300_000;
export const STATUS_POLL_INTERVAL_MS = 1000;

export const PREPARE_ATTEMPTS = 5;

// A transfer that dies mid-body is resumed by re-ripping the track and asking
// for the rest with `Range`. The overlap is re-fetched and compared against the
// bytes already sent, so a rip that is not identical fails instead of stitching.
export const RESUME_ATTEMPTS = 3;
export const RESUME_OVERLAP_BYTES = 64 * 1024;
