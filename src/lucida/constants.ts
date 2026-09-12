export const BASE_URL = 'https://lucida.to/';

export const TRANSIENT_PAGE_ERRORS = [
  'An error occured trying to process your request.',
  'Message: "Cannot contact any valid server"',
  'An error occurred. Had an issue getting that item, try again.',
];

export const RETRY_DELAY_MS = 5000;
export const MAX_ATTEMPTS = 5;

// Overall budget for getting a track prepared, across every attempt.
export const PROCESSING_TIMEOUT_MS = 300_000;
export const STATUS_POLL_INTERVAL_MS = 1000;

// How long an unchanging status may sit before the handoff is written off. 
export const STUCK_TIMEOUT_MS = 30_000;
export const PREPARE_ATTEMPTS = 5;

// A transfer that dies mid-body is resumed by re-ripping the track and asking
// for the rest with `Range`. The overlap is re-fetched and compared against the
// bytes already sent, so a rip that is not identical fails instead of stitching.
export const RESUME_ATTEMPTS = 3;
export const RESUME_OVERLAP_BYTES = 64 * 1024;
