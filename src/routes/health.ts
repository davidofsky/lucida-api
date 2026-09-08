import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';

import { checkAvailability } from '../lucida/client.ts';
import { HealthSchema } from '../lucida/schemas.ts';

export const healthRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/health',
    {
      schema: {
        tags: ['meta'],
        response: { 200: HealthSchema },
      },
    },
    async () => ({ status: await checkAvailability() }),
  );
};
