import { isBlockedId } from '../core/blocked.js';
import { looksLikeId, uuidv7 } from '../core/ids.js';
import type { Logger } from '../core/logger.js';
import { parseJson } from '../core/normalize.js';
import { hashUnit } from '../core/sampling.js';
import type { Stores } from './storage.js';

/**
 * Who this is: the device, the person (once known), and the session.
 *
 * ## Two ids, and what `reset()` does to them
 *
 * `device_id` is minted here and persisted; it keeps being sent after login, because the device
 * is still the device once you know who is holding it. `user_id` is whatever the application
 * calls its user. The server links the two the first time both appear, and the FIRST link wins
 * forever, so a shared browser must get a fresh device id on logout: `reset()` always mints one,
 * and the SDK warns when it sees a rebind, because the server never reports one.
 *
 * ## Sessions across tabs
 *
 * The session is one tuple, `[lastActivity, sessionId, sessionStart]`, in the identity store so
 * every tab on the origin shares it. Activity is written at most every five seconds (a write per
 * event would hammer `document.cookie`), and before this tab declares the session idle it
 * re-reads the tuple, because a sibling tab may have kept it alive. Every time comparison uses
 * `Math.abs`, so a clock that jumps backwards (NTP, devtools) cannot make a session immortal.
 */
export type Consent = 'pending' | 'granted' | 'denied';

export interface IdentityOptions {
  readonly sessionTimeoutMs: number;
  readonly sessionMaxMs: number;
  readonly optOutByDefault: boolean;
  readonly now?: () => number;
}

const ACTIVITY_WRITE_INTERVAL_MS = 5_000;
const MAX_LINKS_REMEMBERED = 20;

type SessionTuple = [lastActivity: number, id: string, start: number];

/** The storage-key prefix for one write key, shared by everything that persists. */
export function namespaceFor(writeKey: string): string {
  return `vk_${Math.floor(hashUnit(writeKey) * 0xffffffff).toString(36)}`;
}

export class Identity {
  private readonly k: Record<'did' | 'uid' | 'ses' | 'opt' | 'lnk', string>;
  private readonly now: () => number;
  private device = '';
  private user: string | null = null;
  private session: SessionTuple | null = null;
  private lastSessionWrite = 0;
  private links: string[] = [];
  private consentState: Consent = 'pending';

  constructor(
    private readonly stores: Stores,
    writeKey: string,
    private readonly options: IdentityOptions,
    private readonly logger: Logger,
  ) {
    // Namespaced by a hash of the write key so two projects on one origin (staging and production
    // on the same host, a marketing site and an app) never share a device id.
    const ns = namespaceFor(writeKey);
    this.k = { did: `${ns}_did`, uid: `${ns}_uid`, ses: `${ns}_ses`, opt: `${ns}_opt`, lnk: `${ns}_lnk` };
    this.now = options.now ?? Date.now;
    this.load();
  }

  private load(): void {
    const did = this.stores.identity.get(this.k.did);
    this.device = looksLikeId(did) ? did : this.mintDevice();

    const uid = this.stores.identity.get(this.k.uid);
    this.user = typeof uid === 'string' && uid !== '' && !isBlockedId(uid) ? uid : null;

    this.session = this.readSession();

    const opt = this.stores.identity.get(this.k.opt);
    this.consentState = opt === '1' ? 'granted' : opt === '0' ? 'denied' : 'pending';

    const links = parseJson(this.stores.data.get(this.k.lnk));
    this.links = Array.isArray(links) ? links.filter((l): l is string => typeof l === 'string').slice(-MAX_LINKS_REMEMBERED) : [];
  }

  private mintDevice(): string {
    const id = uuidv7(this.now());
    this.stores.identity.set(this.k.did, id);

    return id;
  }

  get deviceId(): string {
    return this.device;
  }

  get userId(): string | null {
    return this.user;
  }

  /** Persist the person. Returns what the link means for the server. */
  setUser(userId: string): 'new' | 'known' | 'rebind' {
    const previous = this.user;
    this.user = userId;
    this.stores.identity.set(this.k.uid, userId);

    const link = `${this.device}:${userId}`;
    if (this.links.includes(link)) return 'known';

    const rebind = this.links.some((l) => l.startsWith(`${this.device}:`)) || (previous !== null && previous !== userId);
    this.links = [...this.links, link].slice(-MAX_LINKS_REMEMBERED);
    this.stores.data.set(this.k.lnk, JSON.stringify(this.links));

    return rebind ? 'rebind' : 'new';
  }

  /** Forget the person and mint a new device. Consent is left alone: it belongs to the browser, not the user. */
  reset(): void {
    this.user = null;
    this.stores.identity.remove(this.k.uid);
    this.links = [];
    this.stores.data.remove(this.k.lnk);
    this.device = this.mintDevice();
    this.session = null;
    this.stores.identity.remove(this.k.ses);
    this.lastSessionWrite = 0;
  }

  /**
   * Re-read the shared identity. Another tab may have logged out (a new device, no user) or
   * identified someone; a tab that kept its own copy in memory would go on sending the previous
   * person's ids. Returns whether anything changed.
   */
  reload(): boolean {
    const did = this.stores.identity.get(this.k.did);
    const uid = this.stores.identity.get(this.k.uid);
    const user = typeof uid === 'string' && uid !== '' && !isBlockedId(uid) ? uid : null;
    const device = looksLikeId(did) ? did : this.device;
    const opt = this.stores.identity.get(this.k.opt);
    const consent: Consent = opt === '1' ? 'granted' : opt === '0' ? 'denied' : 'pending';
    if (device === this.device && user === this.user && consent === this.consentState) return false;

    this.device = device;
    this.user = user;
    this.consentState = consent;
    const links = parseJson(this.stores.data.get(this.k.lnk));
    this.links = Array.isArray(links) ? links.filter((l): l is string => typeof l === 'string').slice(-MAX_LINKS_REMEMBERED) : [];
    this.session = this.readSession();

    return true;
  }

  // Sessions ------------------------------------------------------------------------------------

  /** The current session id, extending it with this activity. */
  sessionId(): string {
    return this.currentSession(true)[1];
  }

  /** The current session id without counting this as activity. */
  peekSessionId(): string {
    return this.currentSession(false)[1];
  }

  /** When the current session began, from the tuple. */
  sessionStart(): number {
    return this.currentSession(false)[2];
  }

  private currentSession(touch: boolean): SessionTuple {
    const now = this.now();
    let session = this.session;

    // The idle decision is made on the freshest view: a sibling tab may have extended the session
    // (or rotated it) since this tab last read the store.
    if (session === null || this.idle(session, now) || this.tooLong(session, now)) {
      const stored = this.readSession();
      if (stored !== null && !this.idle(stored, now) && !this.tooLong(stored, now)) {
        session = stored;
      } else {
        session = [now, uuidv7(now), now];
        this.session = session;
        this.writeSession(session, now);
        this.logger.debug('new session', { id: session[1] });
      }
      this.session = session;
    }

    if (touch) {
      session[0] = Math.max(session[0], now);
      if (Math.abs(now - this.lastSessionWrite) >= ACTIVITY_WRITE_INTERVAL_MS) this.writeSession(session, now);
    }

    return session;
  }

  private idle(session: SessionTuple, now: number): boolean {
    return Math.abs(now - session[0]) > this.options.sessionTimeoutMs;
  }

  private tooLong(session: SessionTuple, now: number): boolean {
    return Math.abs(now - session[2]) > this.options.sessionMaxMs;
  }

  private readSession(): SessionTuple | null {
    const parsed = parseJson(this.stores.identity.get(this.k.ses));
    if (!Array.isArray(parsed) || parsed.length !== 3) return null;
    const [last, id, start] = parsed as unknown[];
    if (typeof last !== 'number' || typeof start !== 'number' || !looksLikeId(id)) return null;

    return [last, id, start];
  }

  private writeSession(session: SessionTuple, now: number): void {
    // A sibling that already rotated must not be clobbered with this tab's stale tuple.
    const stored = this.readSession();
    if (stored !== null && stored[1] !== session[1] && stored[0] > session[0]) {
      this.session = stored;

      return;
    }
    this.lastSessionWrite = now;
    this.stores.identity.set(this.k.ses, JSON.stringify(session));
  }

  /** Called on unload: write the latest activity through, unless a sibling moved on. */
  flushSession(): void {
    if (this.session !== null) this.writeSession(this.session, this.now());
  }

  // Consent -------------------------------------------------------------------------------------

  get consent(): Consent {
    return this.consentState;
  }

  /** Whether anything may leave the page right now. */
  get allowed(): boolean {
    if (this.consentState === 'denied') return false;
    if (this.consentState === 'pending') return !this.options.optOutByDefault;

    return true;
  }

  setConsent(granted: boolean): void {
    this.consentState = granted ? 'granted' : 'denied';
    this.stores.identity.set(this.k.opt, granted ? '1' : '0');
  }
}
