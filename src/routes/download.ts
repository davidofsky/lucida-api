import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { Readable } from 'node:stream';

import { contentDisposition, signalOf } from '../http.ts';
import { streamTrack } from '../lucida/download.ts';
import { resolvePage, trackFromPage } from '../lucida/page.ts';
import { AudioSchema, QuerySchema } from '../lucida/schemas.ts';
import { formatTrackStem } from '../lucida/text.ts';
import { ErrorSchema } from '../schemas.ts';

export const downloadRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/download',
    {
      schema: {
        tags: ['lucida'],
        summary: 'Stream a single track',
        description:
          `Resolves the track, asks lucida to prepare it, then pipes the audio through with a 'Content-Disposition' filename. 
          Takes **track** URLs only. You can get this url using /search.`,
        querystring: QuerySchema,
        response: {
          200: AudioSchema,
          400: ErrorSchema,
          502: ErrorSchema,
          503: ErrorSchema,
          504: ErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const signal = signalOf(request);

      const pageData = await resolvePage(request.query.url, request.query.country, signal);
      const track = trackFromPage(pageData);

      const stream = await streamTrack(
        track,
        pageData.tokenExpiry,
        request.query,
        signal,
        request.log,
      );
      const fileName = `${formatTrackStem(track, undefined, 1)}.${stream.extension}`;

      reply.header('content-type', stream.mimeType);
      reply.header('content-disposition', contentDisposition(fileName));

      if (stream.contentLength !== null) {
        reply.header('content-length', stream.contentLength);
      }

      return reply.send(Readable.fromWeb(stream.body) as unknown as string);
    },
  );
};
