import { createServer, type IncomingMessage, type Server } from 'node:http';
import { gunzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';

/**
 * A stand-in for ingest plus a page to load the bundle in, on one local origin, so the browser
 * makes a real cross-origin request to a real server that answers like ingest does.
 */
export interface Received {
  readonly path: string;
  readonly headers: Record<string, string>;
  readonly body: Record<string, unknown>;
  readonly beacon: boolean;
}

export interface Ingest {
  readonly url: string;
  readonly received: Received[];
  close(): Promise<void>;
  waitFor(predicate: (r: Received[]) => boolean, timeoutMs?: number): Promise<Received[]>;
}

const bundle = (): string => readFileSync(new URL('../dist/vinktar.min.js', import.meta.url), 'utf8');

export async function startIngest(page: string): Promise<Ingest> {
  const received: Received[] = [];
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/vinktar.min.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript' }).end(bundle());

      return;
    }
    if (url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html' }).end(page);

      return;
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, Content-Encoding, X-Vinktar-Key',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
      }).end();

      return;
    }
    if (url.pathname.startsWith('/v1/')) {
      const raw = await body(req);
      const text = req.headers['content-encoding'] === 'gzip' ? gunzipSync(raw).toString('utf8') : raw.toString('utf8');
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers[k] = v;
      received.push({ path: url.pathname, headers, body: JSON.parse(text), beacon: url.searchParams.has('_k') });
      res.writeHead(202, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }).end(JSON.stringify({ received: 1, rejected: 0, errors: [] }));

      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  return {
    url: `http://127.0.0.1:${port}`,
    received,
    close: () => new Promise((resolve) => server.close(() => resolve())),
    waitFor: async (predicate, timeoutMs = 5000) => {
      const started = Date.now();
      while (!predicate(received)) {
        if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting; received ${JSON.stringify(received.map((r) => r.path))}`);
        await new Promise((r) => setTimeout(r, 25));
      }

      return received;
    },
  };
}

function body(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

/** The test page: the bundle from the same origin, auto-initialised against that origin as ingest. */
export function pageHtml(origin: string, extra = ''): string {
  return `<!doctype html><html><head><title>e2e</title>
<script src="${origin}/vinktar.min.js" data-key="vnk_pk_e2e" data-host="${origin}" data-filter-bots="false" data-debug></script>
</head><body><h1>e2e</h1><button id="buy">Buy</button>${extra}</body></html>`;
}
