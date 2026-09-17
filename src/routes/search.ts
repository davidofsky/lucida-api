import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';

import { ErrorSchema } from '../schemas.ts';

/**
 * Search is switched off rather than removed, so callers get a clear answer
 * instead of a 404 they have to interpret.
 *
 * Amazon stopped handing out anonymous catalog tokens, which killed the direct
 * search, and lucida's own search proved too unreliable to stand in for it.
 */
export const searchRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/search',
    {
      schema: {
        tags: ['lucida'],
        summary: 'Temporarily disabled',
        description:
          'Track search is temporarily disabled. Pass an Amazon Music track URL to `/download` instead.',
        response: { 503: ErrorSchema },
      },
    },
    async (_request, reply) =>
      reply
        .code(503)
        .send({ error: 'search is temporarily disabled; pass a track URL to /download instead' }),
  );
};
