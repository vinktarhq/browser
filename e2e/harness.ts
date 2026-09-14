import { createServer, type IncomingMessage, type Server } from 'node:http';
import { gunzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';

/**
 * Two local servers on two origins: a site that serves the page and the bundle, and an ingest
 * stand-in that answers like ingest does. The page's origin (`localhost`) differs from ingest's
 * (`127.0.0.1`), so every send is a real cross-origin request with a real CORS preflight, which is
 * exactly what a customer's page does.
 */
export interface Received {
  readonly path: string;
  readonly headers: Record<string, string>;
  readonly body: Record<string, unknown>;
  readonly beacon: boolean;
  readonly status: number;
}

export interface Scripted {
  readonly status: number;
  readonly body?: unknown;
  readonly headers?: Record<string, string>;
}

export interface Ingest {
  readonly url: string;
  /** Serve a page from the ingest origin itself, for comparing same-origin with cross-origin behaviour. */
  host(page: string): void;
  readonly received: Received[];
  /** How many preflight requests arrived. */
  readonly preflights: () => number;
  /** Answer the next POST with this, instead of a 202. */
  respond(response: Scripted): void;
  close(): Promise<void>;
  waitFor(predicate: (r: Received[]) => boolean, timeoutMs?: number): Promise<Received[]>;
}

export interface Site {
  readonly url: string;
  close(): Promise<void>;
}

const bundle = (): string => readFileSync(new URL('../dist/vinktar.min.js', import.meta.url), 'utf8');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Expose-Headers': 'Retry-After, X-RateLimit-Categories',
};

export async function startIngest(): Promise<Ingest> {
  const received: Received[] = [];
  const script: Scripted[] = [];
  let preflights = 0;
  let hosted: string | null = null;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (hosted !== null && req.method === 'GET') {
      if (url.pathname === '/vinktar.min.js') res.writeHead(200, { 'Content-Type': 'application/javascript' }).end(bundle());
      else res.writeHead(200, { 'Content-Type': 'text/html' }).end(hosted);

      return;
    }
    if (req.method === 'OPTIONS') {
      preflights += 1;
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, Content-Encoding, X-Vinktar-Key',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Max-Age': '600',
      }).end();

      return;
    }
    if (url.pathname.startsWith('/v1/')) {
      const raw = await body(req);
      const text = req.headers['content-encoding'] === 'gzip' ? gunzipSync(raw).toString('utf8') : raw.toString('utf8');
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers[k] = v;
      const next = script.shift() ?? { status: 202, body: { received: 1, rejected: 0, errors: [] } };
      received.push({ path: url.pathname, headers, body: JSON.parse(text), beacon: url.searchParams.has('_k'), status: next.status });
      res.writeHead(next.status, { 'Content-Type': 'application/json', ...CORS, ...(next.headers ?? {}) }).end(JSON.stringify(next.body ?? null));

      return;
    }
    res.writeHead(404).end();
  });

  const url = await listen(server, '127.0.0.1');

  return {
    url,
    host: (page) => {
      hosted = page;
    },
    received,
    preflights: () => preflights,
    respond: (response) => void script.push(response),
    close: () => new Promise((resolve) => server.close(() => resolve())),
    waitFor: async (predicate, timeoutMs = 5000) => {
      const started = Date.now();
      while (!predicate(received)) {
        if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting; received ${JSON.stringify(received.map((r) => [r.path, r.status]))}`);
        await new Promise((r) => setTimeout(r, 25));
      }

      return received;
    },
  };
}

/**
 * The customer's site: the page and the bundle, on its own origin. With E2E_SAME_ORIGIN=1 the page
 * is served by ingest instead, which is how the suite compares an engine's behaviour across the two.
 */
export async function startSite(ingestUrl: string, extra = '', ingest?: Ingest): Promise<Site> {
  if (process.env['E2E_SAME_ORIGIN'] === '1' && ingest !== undefined) {
    ingest.host(pageHtml(ingestUrl, ingestUrl, extra));

    return { url: ingestUrl, close: async () => {} };
  }
  let origin = '';
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/vinktar.min.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript' }).end(bundle());

      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' }).end(pageHtml(origin, ingestUrl, extra));
  });
  const address = await listen(server, '127.0.0.1');
  // Same socket, a different host name: a different site as far as the browser is concerned, as a
  // customer's page and ingest are. E2E_SITE_HOST=127.0.0.1 keeps it cross-origin but same-site.
  origin = address.replace('127.0.0.1', process.env['E2E_SITE_HOST'] ?? 'localhost');

  return { url: origin, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

function listen(server: Server, host: string): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, host, () => {
      const address = server.address();
      resolve(`http://${host}:${typeof address === 'object' && address !== null ? address.port : 0}`);
    });
  });
}

function body(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

/** The test page: the bundle from the site, auto-initialised against the ingest origin. */
function pageHtml(site: string, ingest: string, extra: string): string {
  return `<!doctype html><html><head><title>e2e</title>
<script src="${site}/vinktar.min.js" data-key="vnk_pk_e2e" data-host="${ingest}" data-filter-bots="false" data-debug></script>
</head><body><h1>e2e</h1><button id="buy">Buy</button>${extra}</body></html>`;
}
