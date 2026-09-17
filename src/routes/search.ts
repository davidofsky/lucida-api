import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';

import { signalOf } from '../http.ts';
import { SearchQuerySchema, TrackMatchesSchema } from '../lucida/schemas.ts';
import { searchTracks } from '../lucida/search.ts';
import { ErrorSchema } from '../schemas.ts';

export const searchRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/search',
    {
      schema: {
        tags: ['lucida'],
        summary: 'Find tracks on Amazon Music by artist and title',
        description: `Searches Amazon Music's catalogue and returns up to five matches, most likely first.`,
        querystring: SearchQuerySchema,
        response: { 200: TrackMatchesSchema, 400: ErrorSchema, 404: ErrorSchema, 502: ErrorSchema },
      },
    },
    async (request) => {
      const { artist, track } = request.query;

      return searchTracks({ artist, track }, signalOf(request));
    },
  );
};
