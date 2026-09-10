import { byteLength } from '../core/bytes.js';
import { parseRetryAfter } from '../core/decide.js';
import type { Delivery, Outbound, SendOptions, Transport } from '../core/dispatcher.js';
import type { Logger } from '../core/logger.js';
import { parseJson } from '../core/normalize.js';
import { natives } from './natives.js';

/**
 * HTTP for the browser, with the three constraints that shape it:
 *
 * **Only three request headers exist**: `Content-Type`, `Content-Encoding` and `X-Vinktar-Key`.
 * Anything else fails the CORS preflight, the failure is cached for a day, and every send on the
 * page dies with it. SDK identity rides inside the body, in `context.$lib`.
 *
 * **`fetch(..., { keepalive })` has a shared 64 KiB in-flight budget** per page. Under it, an
 * unload send can carry the write key in a header like any other request; over it, the request is
 * refused outright. So keepalive is used only for bodies under ~51 KiB with fewer than fifteen in
 * flight, and the unload path falls back to `sendBeacon`, whose body must stay CORS-simple
 * (`text/plain`, never `application/json`) because a preflight cannot complete while the page is
 * going away. The server parses JSON regardless of the declared type, so nothing is lost.
 *
 * **Third-party code patches `fetch`**, sometimes to throw synchronously. The SDK holds the
 * pristine reference from `natives.ts` and still wraps the call, so a wrapper installed before
 * this module loaded cannot turn an analytics send into an unhandled rejection on the page.
 */
export interface BrowserTransportOptions {
  readonly host: string;
  readonly writeKey: string;
  readonly timeoutMs: number;
  readonly logger: Logger;
  readonly useBeacon: boolean;
}

export const GZIP_THRESHOLD_BYTES = 1024;
export const KEEPALIVE_BODY_LIMIT = Math.floor(64 * 1024 * 0.8);
export const KEEPALIVE_MAX_INFLIGHT = 15;
export const BEACON_SPLIT_FLOOR_BYTES = 16 * 1024;

const NETWORK_ERROR = /Failed to fetch|NetworkError|Load failed|network error/i;

export class BrowserTransport implements Transport {
  private inFlight = 0;
  private inFlightBytes = 0;
  private gzipBroken = false;

  constructor(private readonly options: BrowserTransportOptions) {}

  get canCompress(): boolean {
    return natives.CompressionStream !== undefined && !this.gzipBroken;
  }

  async send(out: Outbound, { gzip }: SendOptions): Promise<Delivery> {
    const fetch = natives.fetch;
    if (fetch === undefined) return { status: 0, body: null };

    const headers: Record<string, string> = { 'Content-Type': 'application/json', 'X-Vinktar-Key': this.options.writeKey };
    let body: BodyInit = out.body;
    const size = byteLength(out.body);

    if (gzip && this.canCompress && size >= GZIP_THRESHOLD_BYTES) {
      const compressed = await this.compress(out.body);
      if (compressed !== null) {
        body = compressed as BodyInit;
        headers['Content-Encoding'] = 'gzip';
      }
    }

    const controller = natives.AbortController !== undefined ? new natives.AbortController() : undefined;
    let timedOut = false;
    // Detected by flag, not by comparing the rejection against the abort reason: not every browser
    // propagates the reason, and an explicit reason at least keeps "signal is aborted without
    // reason" out of the customer's console.
    const timer = natives.setTimeout(() => {
      timedOut = true;
      controller?.abort(new Error('vinktar: request timed out'));
    }, this.options.timeoutMs);

    try {
      const bytes = typeof body === 'string' ? size : (body as Uint8Array).byteLength;
      const keepalive = bytes <= KEEPALIVE_BODY_LIMIT && this.inFlight < KEEPALIVE_MAX_INFLIGHT;
      this.inFlight += 1;
      this.inFlightBytes += bytes;

      let response: Response;
      try {
        response = await fetch(`${this.options.host}${out.endpoint}`, {
          method: 'POST',
          headers,
          body,
          keepalive,
          credentials: 'omit',
          mode: 'cors',
          referrerPolicy: 'strict-origin-when-cross-origin',
          ...(controller !== undefined ? { signal: controller.signal } : {}),
        });
      } finally {
        this.inFlight -= 1;
        this.inFlightBytes -= bytes;
      }

      let text = '';
      try {
        text = await response.text();
      } catch {
        // An empty or unreadable body is decided on status alone.
      }

      return {
        status: response.status,
        body: parseJson(text) ?? null,
        retryAfter: parseRetryAfter(header(response, 'Retry-After')),
        rateLimitCategories: header(response, 'X-RateLimit-Categories') ?? '',
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Ad blockers, offline devices and CORS failures all surface as one generic TypeError with a
      // browser-specific message. Logged at debug, not warn: a transport failure of the SDK's own
      // must never become an error the SDK then reports.
      this.options.logger.debug(timedOut ? 'request timed out' : NETWORK_ERROR.test(message) ? 'network error' : 'request failed', { message });

      return { status: 0, body: null };
    } finally {
      natives.clearTimeout(timer);
    }
  }

  /**
   * One attempt, synchronous, for `pagehide`. Returns whether the browser accepted the request;
   * "accepted" is all a beacon ever says. A refusal at a body over the split floor means the
   * payload is too big; under it, the page's beacon quota is exhausted and halving will not help.
   */
  sendOnUnload(out: Outbound): 'sent' | 'too_large' | 'refused' {
    const size = byteLength(out.body);

    if (natives.fetch !== undefined && size <= KEEPALIVE_BODY_LIMIT && this.inFlight < KEEPALIVE_MAX_INFLIGHT) {
      try {
        void natives
          .fetch(`${this.options.host}${out.endpoint}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Vinktar-Key': this.options.writeKey },
            body: out.body,
            keepalive: true,
            credentials: 'omit',
            mode: 'cors',
          })
          .catch(() => {});

        return 'sent';
      } catch {
        // Fall through to the beacon.
      }
    }

    if (!this.options.useBeacon || natives.sendBeacon === undefined || natives.Blob === undefined) {
      return size > KEEPALIVE_BODY_LIMIT ? 'too_large' : 'refused';
    }

    try {
      const blob = new natives.Blob([out.body], { type: 'text/plain' });
      const url = `${this.options.host}${out.endpoint}?_k=${encodeURIComponent(this.options.writeKey)}`;
      if (natives.sendBeacon(url, blob)) return 'sent';
    } catch {
      // A beacon that throws is a beacon that was refused.
    }

    return size > BEACON_SPLIT_FLOOR_BYTES ? 'too_large' : 'refused';
  }

  private async compress(text: string): Promise<Uint8Array | null> {
    try {
      const stream = new Blob([text]).stream().pipeThrough(new natives.CompressionStream!('gzip'));
      const buffer = await new Response(stream).arrayBuffer();

      return new Uint8Array(buffer);
    } catch (error) {
      // Latched: a runtime whose CompressionStream is broken is broken for the rest of the page,
      // and every request would otherwise pay to find that out again.
      this.gzipBroken = true;
      this.options.logger.debug('compression unavailable; sending uncompressed', { error: String(error) });

      return null;
    }
  }
}

function header(response: Response, name: string): string | null {
  try {
    return response.headers.get(name);
  } catch {
    return null;
  }
}
