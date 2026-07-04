import { FastifyReply } from 'fastify';

/** Response headers for a server-sent-event stream over a hijacked reply. */
export const SSE_HEADERS = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  // Tells buffering reverse proxies (nginx) to pass frames through untouched.
  'X-Accel-Buffering': 'no',
} as const;

const HEARTBEAT_INTERVAL_MS = 15_000;

/** Write one SSE frame. `id` (when given) becomes the frame's `id:` field so
 * EventSource reconnects report it back via the Last-Event-ID header. */
export function writeSse(reply: FastifyReply, event: string, data: unknown, id?: number): void {
  if (id !== undefined) reply.raw.write(`id: ${id}\n`);
  reply.raw.write(`event: ${event}\n`);
  reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
}

/** Suggest a client reconnect delay (EventSource honors `retry:`). */
export function writeSseRetry(reply: FastifyReply, delayMs: number): void {
  reply.raw.write(`retry: ${delayMs}\n\n`);
}

/** Periodic comment frames so idle streams keep proxies and clients from
 * timing out the connection. Returns the stop function; call it on close. */
export function startSseHeartbeat(reply: FastifyReply, intervalMs = HEARTBEAT_INTERVAL_MS): () => void {
  const timer = setInterval(() => {
    reply.raw.write(': ping\n\n');
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
