import { createServer } from 'node:http';
import type { IncomingMessage, Server } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import type { StatementSync } from 'node:sqlite';
import { Readable } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import { MAX_FRAME_BYTES } from '@marifold/workspace-protocol';
import { Relay } from '../relay/Relay';
import type { ConnectionState, RelaySocket } from '../relay/Relay';
import { handleHttp, MIN_TOKEN_LENGTH } from '../relay/http';
import { RelayStore } from '../relay/RelayStore';
import type { Sql } from '../relay/RelayStore';

export interface BridgeOptions {
  registrationToken: string;
  /** SQLite database file, or `:memory:` for a disposable bridge. */
  database: string;
}
class NodeSocket implements RelaySocket {
  state: ConnectionState | undefined;
  constructor(readonly ws: WebSocket) {}
  get bufferedAmount(): number {
    return this.ws.bufferedAmount;
  }
  send(text: string): void {
    if (this.ws.readyState === WebSocket.OPEN) { this.ws.send(text); }
  }
  close(code: number, reason: string): void {
    this.ws.close(code, reason);
  }
}
export function openSqlite(file: string): { sql: Sql; close: () => void } {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;');
  const statements = new Map<string, StatementSync>();
  const prepare = (query: string) => {
    let statement = statements.get(query);
    if (!statement) {
      statement = db.prepare(query);
      statements.set(query, statement);
    }
    return statement;
  };
  return {
    sql: {
      run: (query, ...params) => {
        prepare(query).run(...params);
      },
      all: (query, ...params) => prepare(query).all(...params) as Array<Record<string, unknown>>,
    },
    close: () => db.close(),
  };
}
function toRequest(req: IncomingMessage): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (typeof value === 'string') { headers.set(name, value); }
  }
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  return new Request(new URL(req.url ?? '/', 'http://bridge.invalid'), {
    method: req.method,
    headers,
    ...(hasBody ? { body: Readable.toWeb(req) as ReadableStream<Uint8Array>, duplex: 'half' } : {}),
  } as RequestInit);
}

/** The bridge as a Node HTTP server with WebSockets on `/v1/connect`. */
export function createBridge(options: BridgeOptions): Server {
  if (options.registrationToken.length < MIN_TOKEN_LENGTH) {
    throw new Error(`Bridge registration token must contain at least ${MIN_TOKEN_LENGTH} characters.`);
  }
  const database = openSqlite(options.database);
  const sockets = new Set<NodeSocket>();
  const relay = new Relay({ store: new RelayStore(database.sql), sockets: () => sockets });
  const server = createServer((req, res) => {
    void handleHttp(toRequest(req), relay, options.registrationToken)
      .then(async (response) => {
        res.writeHead(response.status, Object.fromEntries(response.headers));
        res.end(await response.text());
      })
      .catch(() => {
        res.writeHead(500);
        res.end('{}');
      });
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES, perMessageDeflate: false });
  server.on('upgrade', (request, socket, head) => {
    if (relay.full() || request.url !== '/v1/connect') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      const connection = new NodeSocket(ws);
      sockets.add(connection);
      ws.on('message', (data, isBinary) => relay.message(connection, isBinary ? undefined : data.toString()));
      ws.on('close', () => {
        sockets.delete(connection);
        relay.closed(connection);
      });
      ws.on('error', () => undefined);
      relay.open(connection);
    });
  });
  const sweeper = setInterval(() => relay.sweep(), 1000);
  sweeper.unref();
  server.on('close', () => {
    clearInterval(sweeper);
    relay.close();
    for (const connection of sockets) { connection.ws.terminate(); }
    wss.close();
    database.close();
  });
  return server;
}
