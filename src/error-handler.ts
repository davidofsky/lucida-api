import type { FastifyInstance } from 'fastify';
import { hasZodFastifySchemaValidationErrors } from 'fastify-type-provider-zod';

import { HttpError } from './errors.ts';

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: unknown, _request, reply) => {
    if (hasZodFastifySchemaValidationErrors(error)) {
      return reply.code(400).send({ error: `invalid request: ${error.message}` });
    }

    if (error instanceof HttpError) {
      return reply.code(error.statusCode).send({ error: error.message });
    }

    if (error instanceof Error && error.name === 'AbortError') {
      return reply.code(499).send({ error: 'client disconnected' });
    }

    app.log.error(error);
    const statusCode = (error as { statusCode?: number }).statusCode ?? 500;
    return reply.code(statusCode).send({ error: (error as Error).message });
  });
}
