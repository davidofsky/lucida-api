/** The parts of lucida's page and API JSON that this API actually reads. */

import type { Query } from './schemas.ts';

export interface Artist {
  name: string;
}

export interface Track {
  title: string;
  url: string;
  artists: Artist[];
  csrf?: string | null;
  csrfFallback?: string | null;
}

/** Only a track is downloadable; the other kinds exist so we can say which it was. */
export type Info =
  | { type: 'track'; url: string; title: string; artists: Artist[] }
  | { type: 'album' }
  | { type: 'playlist' }
  | { type: 'artist' };

export interface PageData {
  info: Info;
  token?: string | null;
  tokenExpiry: number;
}

// `POST /api/load?url=/api/fetch/stream/v2` response.
export interface TrackDownload {
  handoff: string;
  server: string; // <-- For example Katze or Hund
}

export interface TrackDownloadStatus {
  status: string;
  message: string;
}

/** The download options, i.e. everything the query carries except the URL. */
export type DownloadConfig = Omit<Query, 'url'>;
