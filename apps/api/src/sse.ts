import type { FastifyReply, FastifyRequest } from 'fastify';

export interface SseStream {
  send(data: unknown): void;
  close(): void;
}

/**
 * Take over the reply as a Server-Sent-Events stream. After this call fastify
 * no longer manages the response — CORS headers must be written manually.
 */
export function openSse(request: FastifyRequest, reply: FastifyReply): SseStream {
  reply.hijack();
  const res = reply.raw;
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
    'access-control-allow-origin': request.headers.origin ?? '*',
  });
  res.write(': connected\n\n');

  // Heartbeat keeps proxies/browsers from timing out idle streams.
  const ping = setInterval(() => {
    if (!res.writableEnded) res.write(': ping\n\n');
  }, 15_000);

  return {
    send(data: unknown) {
      if (!res.writableEnded) res.write(`data: ${JSON.stringify(data)}\n\n`);
    },
    close() {
      clearInterval(ping);
      if (!res.writableEnded) res.end();
    },
  };
}
