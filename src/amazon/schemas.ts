import { z } from 'zod';

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
