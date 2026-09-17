import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUi from '@fastify/swagger-ui';
import type { FastifyInstance } from 'fastify';
import { jsonSchemaTransform } from 'fastify-type-provider-zod';

import { MIME_EXTENSIONS } from './lucida/download.ts';

/**
 * `jsonSchemaTransform` documents every response as JSON. `/download` answers with
 * audio, so its 200 is re-declared under the content types lucida actually sends.
 */
function audioAwareTransform(input: Parameters<typeof jsonSchemaTransform>[0]) {
  const result = jsonSchemaTransform(input);
  const responses = (result.schema as { response?: Record<string, unknown> }).response;

  if (input.url === '/download' && responses?.['200'] !== undefined) {
    responses['200'] = {
      description: 'the track audio, streamed through from lucida',
      content: Object.fromEntries(
        Object.keys(MIME_EXTENSIONS).map((mimeType) => [
          mimeType,
          { schema: { type: 'string', format: 'binary' } },
        ]),
      ),
    };
  }

  return result;
}

/** Swagger UI at /docs, the OpenAPI document at /docs/json. */
export async function registerDocs(app: FastifyInstance): Promise<void> {
  await app.register(fastifySwagger, {
    openapi: {
      info: {
        title: 'lucida-api',
        description:
          'Streams music from [lucida.to](https://lucida.to/). Find an Amazon Music track ' +
          'by artist and title, then stream it straight through as a file.',
        version: '1.0.0',
      },
      tags: [
        { name: 'lucida', description: 'downloading' },
        { name: 'meta', description: 'service health' },
      ],
    },
    transform: audioAwareTransform,
  });

  await app.register(fastifySwaggerUi, { routePrefix: '/docs' });
}
