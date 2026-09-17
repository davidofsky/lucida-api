import { z } from 'zod';

/** 
 * `z.stringbool()` also accepts `1`/`0`, `yes`/`no`, and `on`/`off`, but documenting
 * the canonical pair keeps generated clients and the Swagger UI dropdown sane.
 */
const BOOLEAN_META = { type: 'string', enum: ['true', 'false'] } as const;

/** Query parameters for the download endpoint. */
export const QuerySchema = z.object({
  url: z.url().describe('an Amazon Music track URL, as returned by /search'),
  country: z.string().min(1).default('auto').describe('country to use lucida accounts from'),
  server: z
    .string()
    .min(1)
    .optional()
    .describe('pin the rip to one of lucida\'s servers (e.g. `maus`); otherwise lucida picks'),
  metadata: z
    .stringbool()
    .default(true)
    .meta({ ...BOOLEAN_META, description: 'let lucida embed metadata in the file (default true)' }),
  private: z.stringbool().default(false).meta({
    ...BOOLEAN_META,
    description: "hide the track from lucida's recent downloads (default false)",
  }),
});

export type Query = z.infer<typeof QuerySchema>;

export const HealthSchema = z.object({
  status: z
    .enum(['available', 'captcha', 'unavailable'])
    .describe('captcha means CF_CLEARANCE and USER_AGENT need to be set'),
});

/** lucida streams the audio through verbatim, so the body is opaque bytes. */
export const AudioSchema = z
  .string()
  .meta({ format: 'binary', description: 'the track audio (FLAC, MP3, M4A, or Opus)' });

/** Query parameters for the search endpoint. */
export const SearchQuerySchema = z.object({
  artist: z.string().min(1).describe('performing artist, e.g. "Radiohead"'),
  track: z.string().min(1).describe('song title, e.g. "Weird Fishes"'),
});

export const TrackMatchSchema = z.object({
  id: z.string(),
  title: z.string(),
  artist: z.string(),
  url: z.string().describe('pass this to /download'),
});

export type TrackMatch = z.infer<typeof TrackMatchSchema>;

/** Up to five candidates, most likely first. */
export const TrackMatchesSchema = z.array(TrackMatchSchema);
