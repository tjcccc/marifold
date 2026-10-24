import { DurableObject } from 'cloudflare:workers';
import { Relay } from '../relay/Relay';
import type { ConnectionState, RelaySocket } from '../relay/Relay';
import { handleHttp, healthResponse } from '../relay/http';
import { RelayStore } from '../relay/RelayStore';
import type { Sql } from '../relay/RelayStore';

interface Env {
  BRIDGE: DurableObjectNamespace<BridgeRelay>;
  MARIFOLD_BRIDGE_REGISTRATION_TOKEN?: string;
}
// The attachment is the connection's only state that survives hibernation.
function wrap(ws: WebSocket): RelaySocket {
  return {
    get state() {
      return (ws.deserializeAttachment() as ConnectionState | null) ?? undefined;
    },
    set state(value) {
      ws.serializeAttachment(value);
    },
    send(text) {
      try {
        ws.send(text);
      } catch {
        /* the socket closed; its frames stay stored until acknowledged */
      }
    },
    close(code, reason) {
      try {
        ws.close(code, reason);
      } catch {
        /* already closed */
      }
    },
  };
}
function storage(sql: SqlStorage): Sql {
  return {
    run: (query, ...params) => {
      sql.exec(query, ...params);
    },
    all: (query, ...params) => sql.exec(query, ...params).toArray(),
  };
}

/** One Durable Object holds every bridge connection and its SQLite state, so
 * the relay behaves exactly like a single Node process. */
export class BridgeRelay extends DurableObject<Env> {
  private relay: Relay;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.relay = new Relay({ store: new RelayStore(storage(ctx.storage.sql)), sockets: () => ctx.getWebSockets().map(wrap) });
  }
  async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname !== '/v1/connect') {
      return handleHttp(request, this.relay, this.env.MARIFOLD_BRIDGE_REGISTRATION_TOKEN);
    }
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') { return new Response(null, { status: 426 }); }
    if (this.relay.full()) { return new Response(null, { status: 503 }); }
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    this.relay.open(wrap(server));
    await this.scheduleSweep();
    return new Response(null, { status: 101, webSocket: client });
  }
  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    this.relay.message(wrap(ws), message);
  }
  webSocketClose(ws: WebSocket): void {
    this.relay.closed(wrap(ws));
  }
  webSocketError(ws: WebSocket): void {
    this.relay.closed(wrap(ws));
  }
  async alarm(): Promise<void> {
    const next = this.relay.sweep();
    if (next !== undefined) { await this.ctx.storage.setAlarm(next); }
  }
  private async scheduleSweep(): Promise<void> {
    const pending = await this.ctx.storage.getAlarm();
    const next = this.relay.sweep();
    if (next !== undefined && (pending === null || pending > next)) { await this.ctx.storage.setAlarm(next); }
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    // Health checks stay out of the Durable Object's request budget.
    if (request.method === 'GET' && url.pathname === '/health') { return healthResponse(); }
    if (url.pathname !== '/v1/connect' && url.pathname !== '/v1/hosts') { return new Response('{}', { status: 404 }); }
    return env.BRIDGE.get(env.BRIDGE.idFromName('relay')).fetch(request);
  },
} satisfies ExportedHandler<Env>;
