import type { Track } from './types.ts';

export function sanitizeFileName(name: string): string {
  return name.trim().replaceAll(/[\\/:*?"<>|]/g, '_');
}

// Extracts the text between the first `startMarker` and the next `endMarker`.
export function parseEnclosedValue(startMarker: string, endMarker: string, text: string): string {
  const startIndex = text.indexOf(startMarker);

  if (startIndex === -1) {
    throw new Error(`${startMarker} not found in page`);
  }

  const valueStart = startIndex + startMarker.length;
  const endIndex = text.indexOf(endMarker, valueStart);

  if (endIndex === -1) {
    throw new Error(`${endMarker} not found in page`);
  }

  return text.slice(valueStart, endIndex);
}

// File name without extension, matching lucida-downloader's naming.
export function formatTrackStem(
  track: Track,
  trackNumber: number | undefined,
  trackCount: number,
): string {
  const number =
    trackNumber === undefined
      ? ''
      : `${String(trackNumber).padStart(Math.floor(Math.log10(trackCount)) + 1, '0')}. `;

  const artist = track.artists[0] ? `${sanitizeFileName(track.artists[0].name)} - ` : '';

  return `${number}${artist}${sanitizeFileName(track.title)}`;
}
