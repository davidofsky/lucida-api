/** Aborts the upstream lucida requests as soon as the client goes away. */
export function signalOf(request: {
  raw: NodeJS.ReadableStream & { on(event: 'close', cb: () => void): unknown };
}): AbortSignal {
  const controller = new AbortController();
  request.raw.on('close', () => controller.abort());
  return controller.signal;
}

export function contentDisposition(fileName: string): string {
  const ascii = fileName.replaceAll(/[^\x20-\x7e]/g, '_').replaceAll('"', "'");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}
