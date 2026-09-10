import { gunzipSync } from 'node:zlib';
import { vi } from 'vitest';

/**
 * A stand-in for ingest: records every request the client makes and answers from a script. Must
 * be installed BEFORE the SDK modules load, because they capture the pristine `fetch` at import.
 */
export interface Recorded {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: Record<string, unknown>;
  readonly keepalive: boolean;
  readonly gzip: boolean;
}

export interface Harness {
  readonly requests: Recorded[];
  respond(status: number, body?: unknown, headers?: Record<string, string>): void;
  batches(): Array<Record<string, unknown>>;
  errors(): Array<Record<string, unknown>>;
  reset(): void;
}

export function installHarness(): Harness {
  const requests: Recorded[] = [];
  const script: Array<{ status: number; body: unknown; headers: Record<string, string> }> = [];

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => (headers[key.toLowerCase()] = value));
    // Bodies of 1 KiB and over arrive gzipped, exactly as they would at ingest.
    const bytes = typeof init?.body === 'string' ? Buffer.from(init.body) : Buffer.from(init?.body as Uint8Array);
    const raw = headers['content-encoding'] === 'gzip' ? gunzipSync(bytes).toString('utf8') : bytes.toString('utf8');
    requests.push({ url, method: init?.method ?? 'GET', headers, body: JSON.parse(raw), keepalive: init?.keepalive === true, gzip: headers['content-encoding'] === 'gzip' });
    const next = script.shift() ?? { status: 202, body: { received: 1, rejected: 0, errors: [] }, headers: {} };

    return new Response(JSON.stringify(next.body), { status: next.status, headers: next.headers });
  });
  vi.stubGlobal('fetch', fetchMock);

  return {
    requests,
    respond: (status, body = null, headers = {}) => void script.push({ status, body, headers }),
    batches: () => requests.filter((r) => r.url.includes('/v1/batch')).flatMap((r) => (r.body['batch'] as Array<Record<string, unknown>>) ?? []),
    errors: () => requests.filter((r) => r.url.includes('/v1/errors')).flatMap((r) => (r.body['errors'] as Array<Record<string, unknown>>) ?? []),
    reset: () => void requests.splice(0),
  };
}

export const tick = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
