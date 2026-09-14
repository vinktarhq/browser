import { installAutocapture } from './browser/autocapture.js';
import { initialAttribution, isLikelyBot, pageContext } from './browser/context.js';
import { installCrumbSources } from './browser/crumbs.js';
import { DOM_COERCERS, installGlobalHandlers, isExtensionError, stampDebugIds, unwrapBrowserValue, type GlobalMechanism } from './browser/errors.js';
import { Identity, namespaceFor } from './browser/identity.js';
import { Instrumentation } from './browser/instrument.js';
import { hasDom, natives } from './browser/natives.js';
import { locationKey, Navigation } from './browser/navigation.js';
import { QueuePersistence } from './browser/persist.js';
import { createStores, type Stores } from './browser/storage.js';
import { BrowserTransport } from './browser/transport.js';
import { Breadcrumbs, toBreadcrumb, type Breadcrumb } from './core/breadcrumbs.js';
import { validUserId } from './core/blocked.js';
import { Dedupe, KeyedValve, Valve } from './core/dedupe.js';
import { Dispatcher, type Endpoint } from './core/dispatcher.js';
import { coerce, CORE_COERCERS, exceptionKey, fromMessage, isMeaningless, issueKey, type WireException } from './core/exception.js';
import { crashFile, DEFAULT_IGNORE, isServerSuppressed, matches } from './core/filters.js';
import { runHooks } from './core/hooks.js';
import { hexId, uuidv7 } from './core/ids.js';
import { MAX_FINGERPRINT_PART_BYTES, MAX_FINGERPRINT_PARTS, MAX_PROPERTIES_PER_EVENT, MAX_TAG_KEY_BYTES, MAX_TAG_VALUE_BYTES, MAX_TAGS, type Level } from './core/limits.js';
import type { Logger } from './core/logger.js';
import { capCombined, normalize, normalizeTags, parseJson, type NormalizeOptions, type Props } from './core/normalize.js';
import type { Entry } from './core/queue.js';
import { sampled } from './core/sampling.js';
import { parseStack, syntheticFrame } from './core/stack.js';
import { describeTraitDrop, parseTraits, type Traits } from './core/traits.js';
import { truncateToBytes } from './core/bytes.js';
import { isLevel, makeLogger, resolve, type Resolved, type VinktarOptions } from './options.js';
import type { CaptureContext, IdentifyOptions, Integration, IntegrationHost, Scope, User } from './types.js';
import { VERSION } from './version.js';

/**
 * The client. One per page, normally reached through the facade in `index.ts`.
 *
 * Everything public is wrapped so a failure inside the SDK never reaches the application, and
 * every drop or refusal is said out loud through the logger. The four things this class has to
 * get right, in order of how expensive they are to get wrong:
 *
 *   1. **Never lose an accepted event.** Capture persists before it sends; the unload path sends
 *      what it can and leaves the persisted copy for the next page to adopt.
 *   2. **Never attribute one person's events to another.** `reset()` mints a new device id, and a
 *      rebind is warned about, because the server keeps the first link forever.
 *   3. **Never let the SDK become the noise.** Own requests, own console lines and own failures are
 *      invisible to breadcrumbs and error capture.
 *   4. **Never throw.** Not from a public method, not from a handler, not from a hook.
 */
const PENDING_ERRORS = 50;
// The persisted queue shares the origin's localStorage quota (about five million characters) with
// the application, so the SDK keeps well under it.
const QUEUE_BYTES = 2 * 1024 * 1024;
const ERROR_QUEUE_BYTES = 512 * 1024;

export class Vinktar {
  readonly version = VERSION;

  private readonly o: Resolved;
  private readonly logger: Logger;
  private readonly stores: Stores;
  private readonly identity: Identity;
  private readonly dispatcher: Dispatcher;
  private readonly transport: BrowserTransport;
  private readonly persistence: QueuePersistence | null;
  private readonly crumbs: Breadcrumbs;
  private readonly instrumentation = new Instrumentation();
  private readonly navigation = new Navigation(this.instrumentation);
  private readonly dedupe = new Dedupe();
  private readonly errorValve: Valve;
  private readonly eventValve: Valve;
  private readonly typeValve: KeyedValve;
  private readonly normalizeOptions: NormalizeOptions;
  private readonly keys: { sup: string; attr: string };
  private readonly teardowns: Array<() => void> = [];

  private tags: Record<string, string>;
  private context: Props;
  private supers: Props = {};
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private closing: Promise<boolean> | null = null;
  private inert: string | null;
  private pageKey = '';
  private pageStarted = 0;
  private pageMaxScroll = 0;

  constructor(options: VinktarOptions = {}) {
    this.logger = makeLogger(options);
    this.o = resolve(options, this.logger);
    this.inert = this.o.inert;
    if (!hasDom) this.inert ??= 'no window: nothing to observe here';
    this.tags = { ...this.o.initialScope.tags };
    this.context = { ...this.o.initialScope.context };
    this.normalizeOptions = {
      maxStringBytes: this.o.maxValueBytes,
      maxDepth: this.o.normalizeDepth,
      maxProperties: 255,
      redactedKeys: this.o.redactedKeys,
      propertyDenylist: this.o.propertyDenylist,
    };

    const ns = namespaceFor(this.o.writeKey);
    this.keys = { sup: `${ns}_sup`, attr: `${ns}_attr` };
    this.stores = createStores({
      disablePersistence: this.o.disablePersistence || this.inert !== null,
      crossSubdomainCookie: this.o.crossSubdomainCookie,
      onLarge: (key, bytes) => this.logger.warn(`the ${key} cookie is ${bytes} bytes; browsers drop cookies near 4 KiB`),
    });
    this.identity = new Identity(
      this.stores,
      this.o.writeKey,
      { sessionTimeoutMs: this.o.sessionTimeoutMs, sessionMaxMs: this.o.sessionMaxMs, optOutByDefault: this.o.optOutByDefault },
      this.logger,
    );
    this.errorValve = new Valve(this.o.maxErrorsPerMinute);
    this.eventValve = new Valve(this.o.maxEventsPerMinute);
    this.typeValve = new KeyedValve(Math.max(1, Math.floor(this.o.maxErrorsPerMinute / 2)));
    this.crumbs = new Breadcrumbs(this.o.maxBreadcrumbs);

    this.transport = new BrowserTransport({
      host: this.o.host,
      writeKey: this.o.writeKey,
      timeoutMs: this.o.requestTimeoutMs,
      logger: this.logger,
      useBeacon: this.o.useBeacon,
    });
    this.dispatcher = new Dispatcher({
      transport: this.transport,
      logger: this.logger,
      maxQueueSize: this.o.maxQueueSize,
      maxPendingErrors: PENDING_ERRORS,
      maxQueueBytes: QUEUE_BYTES,
      maxPendingErrorBytes: ERROR_QUEUE_BYTES,
      gzip: this.o.gzip,
      // The transport has its own deadline; this one only catches a patched fetch that ignores it.
      sendTimeoutMs: this.o.requestTimeoutMs + 1_000,
      timers: { set: (fn, ms) => natives.setTimeout(fn, ms), clear: (handle) => natives.clearTimeout(handle as ReturnType<typeof setTimeout>) },
      isOnline: () => natives.window?.navigator.onLine !== false,
      onShutdown: () => this.persistence?.clear(),
      onBilling: () => this.o.onError?.(new Error('vinktar: the monthly cap was reached; events are paused')),
    });

    this.persistence =
      this.o.persistQueue && this.inert === null && this.stores.data.kind !== 'memory'
        ? new QueuePersistence(this.stores.data, this.stores.tab, ns, this.logger, Date.now, natives.setTimeout, natives.clearTimeout)
        : null;

    if (this.inert !== null) return;

    this.supers = (parseJson(this.stores.data.get(this.keys.sup)) as Props | undefined) ?? {};
    const attribution = initialAttribution(this.stores.data, this.keys.attr, this.o.sendDefaultPii);
    for (const [key, value] of Object.entries(attribution)) this.supers[key] ??= value;

    const restored = this.persistence?.restore();
    if (restored !== undefined) {
      for (const entry of restored.events) this.dispatcher.events.push(entry.category, entry.item);
      for (const entry of restored.errors) this.dispatcher.errors.push(entry.category, entry.item);
    }

    this.install();

    if (this.dispatcher.pending > 0) this.scheduleFlush(0);
  }

  // Installation --------------------------------------------------------------------------------

  private install(): void {
    const win = natives.window!;
    const doc = natives.document!;

    if (this.o.errors) {
      installGlobalHandlers(this.instrumentation, (error) => this.captureGlobal(error.value, error.mechanism, error.location));
    }

    const anyCrumb = Object.values(this.o.breadcrumbs).some(Boolean);
    if ((this.o.errors && anyCrumb) || this.o.propagateIdentity.length > 0) {
      installCrumbSources(this.instrumentation, {
        sources: this.o.errors ? this.o.breadcrumbs : { console: false, network: false, navigation: false, click: false },
        sendDefaultPii: this.o.sendDefaultPii,
        ingestHost: this.o.host,
        propagateTo: this.o.propagateIdentity,
        identity: () => ({ deviceId: this.identity.deviceId, sessionId: this.identity.peekSessionId() }),
        add: (crumb) => this.addBreadcrumb(crumb),
        logger: this.logger,
        navigation: this.navigation,
      });
    }

    if (this.o.analytics && this.o.autoPageviews.enabled) {
      const parts = this.o.autoPageviews;
      this.pageKey = locationKey(win.location.href, parts);
      const unsubscribe = this.navigation.subscribe((change) => {
        const key = locationKey(change.to, parts);
        // A framework can call replaceState a dozen times per transition with only state moving;
        // a pageview is a change in the part of the URL the application said matters.
        if (key === this.pageKey) return;
        if (parts.leave) this.pageLeave();
        this.pageKey = key;
        this.page(undefined, { $navigation_type: change.type });
      });
      this.teardowns.push(unsubscribe);

      if (parts.leave) {
        this.pageStarted = Date.now();
        this.instrumentation.listen(win, 'scroll', () => this.noteScroll(), { passive: true });
      }

      // On the next tick, so an `identify()` in the same script runs first and the first pageview
      // already carries the user.
      natives.setTimeout(() => {
        if (this.closed) return;
        this.page();
        // Sent at once rather than at the interval, so an install screen sees its first event now.
        void this.flush();
      }, 0);
    }

    if (this.o.analytics && (this.o.autocapture.clicks || this.o.autocapture.forms)) {
      installAutocapture(this.instrumentation, {
        clicks: this.o.autocapture.clicks,
        forms: this.o.autocapture.forms,
        sendDefaultPii: this.o.sendDefaultPii,
        track: (name, props) => this.track(name, props),
      });
    }

    // Unload: `pagehide` and `visibilitychange` → hidden, never `unload`, which disables the
    // back/forward cache and does not fire on mobile. `pageshow` undoes the unloading state when
    // the same page instance is restored from that cache.
    this.instrumentation.listen(win, 'pagehide', () => this.onUnload(true));
    this.instrumentation.listen(doc, 'visibilitychange', () => {
      if (doc.visibilityState === 'hidden') this.onUnload(false);
      // A tab coming back may have missed a logout elsewhere (a cookie store fires no event).
      else this.adoptSharedIdentity();
    });
    this.instrumentation.listen(win, 'pageshow', () => {
      if (this.dispatcher.pending > 0) this.scheduleFlush(this.o.flushIntervalMs);
    });
    this.instrumentation.listen(win, 'online', () => {
      this.dispatcher.backoff.clear();
      this.scheduleFlush(0);
    });
    // Another tab logged out or identified: this tab must stop sending the previous person's ids.
    this.instrumentation.listen(win, 'storage', (event) => {
      const key = (event as Partial<StorageEvent>).key;
      // A null key is storage being cleared; anything that is not a string is not worth trusting.
      if (typeof key !== 'string' || key.startsWith(namespaceFor(this.o.writeKey))) this.adoptSharedIdentity();
    });

    const host: IntegrationHost = {
      track: (name, properties) => this.track(name, properties),
      captureException: (error, hint) => this.captureException(error, hint),
      addBreadcrumb: (crumb) => this.addBreadcrumb(crumb),
      logger: { warn: (m) => this.logger.warn(m), debug: (m) => this.logger.debug(m) },
    };
    for (const integration of this.o.integrations) this.setupIntegration(integration, host);
  }

  private setupIntegration(integration: Integration, host: IntegrationHost): void {
    try {
      const teardown = integration.setup(host);
      if (typeof teardown === 'function') this.teardowns.push(teardown);
    } catch (error) {
      this.logger.warn(`integration "${integration.name}" failed to set up and was skipped`, { error: String(error) });
    }
  }

  // Analytics -----------------------------------------------------------------------------------

  track(name: string, properties?: Props): void {
    this.guarded(() => {
      if (!this.ready('track')) return;
      if (typeof name !== 'string' || name.trim() === '') {
        this.logger.warn('track() needs an event name; nothing was sent');

        return;
      }
      if (!this.o.analytics) {
        this.logger.debug(`analytics is off; "${name}" was not sent`);

        return;
      }
      if (this.o.filterBots && isLikelyBot()) {
        this.logger.debug('automated traffic; analytics are not sent');

        return;
      }
      if (!this.eventValve.take()) {
        this.dispatcher.reports.record('ratelimit', 'event');
        this.logger.warn(`more than ${this.o.maxEventsPerMinute} events in a minute; dropping until the valve refills`);

        return;
      }
      if (!sampled(this.identity.deviceId, this.o.sampleRate)) {
        this.dispatcher.reports.record('sample_rate', 'event');

        return;
      }

      const context = normalize(pageContext(this.o), this.normalizeOptions);
      const payload = normalize(
        { ...this.o.superProperties, ...this.supers, ...(typeof properties === 'object' && properties !== null ? properties : {}) },
        this.normalizeOptions,
        (key, reason) => this.logger.warn(`property "${key}" on "${name}" was ${reason === 'truncated' ? 'truncated' : reason === 'depth' ? 'flattened past depth ' + this.o.normalizeDepth : 'dropped: too many properties'}`),
      );
      const event: Record<string, unknown> = {
        name: truncateToBytes(name.trim(), 255),
        event_id: uuidv7(),
        timestamp: new Date().toISOString(),
        device_id: this.identity.deviceId,
        session_id: this.identity.sessionId(),
        payload: this.capProperties(name, payload, context),
        context,
      };
      if (this.identity.userId !== null) event['user_id'] = this.identity.userId;

      const hooked = runHooks(this.o.beforeTrack, event);
      if (hooked.value === null) {
        this.dispatcher.reports.record('before_send', 'event');
        if (hooked.threw !== undefined) this.logger.warn('beforeTrack threw; the event was dropped', { error: String(hooked.threw) });

        return;
      }

      const final = this.o.beforeTrack.length > 0 ? this.renormalizeEvent(name, hooked.value) : hooked.value;
      if (!this.dispatcher.events.push('event', final)) {
        this.dispatcher.reports.record('before_send', 'event');
        this.logger.warn(`"${name}" was dropped: beforeTrack returned something that cannot be sent (a BigInt, a cycle, or a promise)`);

        return;
      }
      this.afterCapture();
    });
  }

  page(name?: string, properties?: Props): void {
    const props: Props = { ...(properties ?? {}) };
    if (typeof name === 'string' && name !== '') props['$page_name'] = name;
    if (this.o.autoPageviews.leave) {
      this.pageStarted = Date.now();
      this.pageMaxScroll = 0;
    }
    this.track('$pageview', props);
  }

  identify(userId: string, traits?: Traits, traitsOnce?: Traits, options?: IdentifyOptions): void {
    this.guarded(() => {
      if (!this.ready('identify')) return;
      const id = validUserId(userId);
      if (id === null) {
        this.logger.warn(`identify(${JSON.stringify(userId)}) was ignored: not a usable user id`);

        return;
      }
      if (options?.deviceId !== undefined) {
        this.logger.warn('identify(): deviceId is ignored in the browser, which mints and persists its own');
      }

      const parsed = parseTraits({ $set: traits, $set_once: traitsOnce, $unset: options?.unset });
      for (const drop of parsed.drops) this.logger.warn(describeTraitDrop(drop));

      const link = this.identity.setUser(id);
      if (link === 'rebind') {
        this.logger.warn(
          `identify("${id}"): this device is already linked to another user and the server keeps the first link. Call reset() on logout so the next person gets a new device id.`,
        );
      }

      const hasOps = Object.keys(parsed.set).length + Object.keys(parsed.setOnce).length + parsed.unset.length > 0;
      if (link === 'known' && !hasOps) {
        this.logger.debug(`identify("${id}"): link already sent and no traits given; nothing to send`);

        return;
      }

      const entry: Record<string, unknown> = { user_id: id, device_id: this.identity.deviceId };
      if (Object.keys(parsed.set).length > 0) entry['$set'] = parsed.set;
      if (Object.keys(parsed.setOnce).length > 0) entry['$set_once'] = parsed.setOnce;
      if (parsed.unset.length > 0) entry['$unset'] = parsed.unset;

      this.dispatcher.events.push('identify', entry);
      this.persist();
      // An identify never waits for the batch valve: it is what makes everything else resolvable.
      void this.flush();
    });
  }

  setTraits(traits: Traits, traitsOnce?: Traits): void {
    this.withUser('setTraits', (id) => this.identify(id, traits, traitsOnce));
  }

  setTraitsOnce(traits: Traits): void {
    this.withUser('setTraitsOnce', (id) => this.identify(id, undefined, traits));
  }

  unsetTraits(keys: string[]): void {
    this.withUser('unsetTraits', (id) => this.identify(id, undefined, undefined, { unset: keys }));
  }

  private withUser(method: string, fn: (id: string) => void): void {
    this.guarded(() => {
      const id = this.identity.userId;
      if (id === null) {
        this.logger.warn(`${method}() was called before identify(); traits need a user, so nothing was sent`);

        return;
      }
      fn(id);
    });
  }

  setUser(user: User | null): void {
    this.guarded(() => {
      if (user === null) {
        this.reset();

        return;
      }
      if (typeof user !== 'object' || typeof user.id !== 'string') {
        this.logger.warn('setUser() needs { id } or null');

        return;
      }
      const { id, ...rest } = user;
      this.identify(id, rest as Traits);
    });
  }

  reset(): void {
    this.guarded(() => {
      if (this.closed) return;
      // Best effort, and safe: queued records already carry the identity they were captured with.
      void this.flush();
      this.identity.reset();
      this.crumbs.clear();
      this.tags = { ...this.o.initialScope.tags };
      this.context = { ...this.o.initialScope.context };
      this.supers = {};
      this.stores.data.remove(this.keys.sup);
      // First-touch attribution belonged to the person who just left. Deriving it again from the
      // logout page would hand the next person a referrer of "/logout", so it is simply gone.
      this.stores.data.remove(this.keys.attr);
      this.logger.debug('reset: new device id', { deviceId: this.identity.deviceId });
    });
  }

  register(properties: Props): void {
    this.guarded(() => {
      if (typeof properties !== 'object' || properties === null) return;
      Object.assign(this.supers, properties);
      this.saveSupers();
    });
  }

  registerOnce(properties: Props): void {
    this.guarded(() => {
      if (typeof properties !== 'object' || properties === null) return;
      for (const [key, value] of Object.entries(properties)) this.supers[key] ??= value;
      this.saveSupers();
    });
  }

  unregister(key: string): void {
    this.guarded(() => {
      delete this.supers[key];
      this.saveSupers();
    });
  }

  private saveSupers(): void {
    const persisted = normalize(this.supers, this.normalizeOptions);
    this.stores.data.set(this.keys.sup, JSON.stringify(persisted));
  }

  // Errors --------------------------------------------------------------------------------------

  captureException(error: unknown, hint?: CaptureContext): string {
    return this.guarded(() => this.capture(error, 'manual', hint?.handled ?? true, hint), '');
  }

  captureMessage(message: string, hint?: CaptureContext): string {
    return this.guarded(() => {
      if (!this.ready('captureMessage')) return '';
      const text = typeof message === 'string' ? message : String(message);
      let frames = this.o.attachStacktrace ? parseStack(new Error().stack) : [];
      // Crash-last: the last two frames are this method and its caller inside the facade.
      if (frames.length > 2) frames = frames.slice(0, -2);
      const exceptions = fromMessage(text, frames);

      // Synthetic: the stack, if any, is the SDK's own call site, not where anything failed.
      return this.emit(exceptions, true, 'manual', hint?.handled ?? true, hint ?? {}, hint?.level ?? 'info');
    }, '');
  }

  private captureGlobal(value: unknown, mechanism: GlobalMechanism, location?: { file: string; line: number; col: number }): void {
    this.guarded(() => {
      if (isMeaningless(value)) return;
      this.capture(value, mechanism, false, undefined, location);
    });
  }

  private capture(
    error: unknown,
    mechanism: GlobalMechanism | 'manual',
    handled: boolean,
    hint: CaptureContext | undefined,
    location?: { file: string; line: number; col: number },
  ): string {
    if (!this.ready('captureException')) return '';
    if (isMeaningless(error)) {
      this.logger.warn('captureException() was given nothing to report');

      return '';
    }

    const value = unwrapBrowserValue(error);
    const coerced = coerce(value, [...DOM_COERCERS, ...CORE_COERCERS], {
      includeRawStack: this.o.includeRawStack,
      fallbackType: mechanism === 'onunhandledrejection' ? 'UnhandledRejection' : 'Error',
    });
    if (coerced.exceptions.length === 0) return '';

    // A cross-origin script gives the browser a location and no Error; fabricate the one frame.
    const first = coerced.exceptions[0]!;
    if (first.stack.length === 0 && location !== undefined) {
      first.stack = syntheticFrame(location.file, location.line, location.col);
    }

    return this.emit(coerced.exceptions, coerced.synthetic, mechanism, handled, hint ?? {}, hint?.level ?? 'error');
  }

  private emit(
    exceptions: WireException[],
    synthetic: boolean,
    mechanism: GlobalMechanism | 'manual',
    handled: boolean,
    hint: CaptureContext,
    level: Level,
  ): string {
    if (!this.o.errors) {
      this.logger.debug('errors is off; nothing was sent');

      return '';
    }
    const first = exceptions[0]!;
    const message = first.value;
    const headline = `${first.type}: ${message}`;

    if (isServerSuppressed(message, first.stack) || isExtensionError(first.stack)) {
      this.logger.debug('known noise; not sent', { message });

      return '';
    }
    if (!this.o.disableErrorDefaults && matches(DEFAULT_IGNORE, message)) return '';
    if (this.o.ignoreErrors.length > 0 && (matches(this.o.ignoreErrors, message) || matches(this.o.ignoreErrors, headline))) {
      this.logger.debug('ignored by ignoreErrors', { message });

      return '';
    }
    const file = crashFile(first.stack);
    if (file !== '') {
      if (this.o.denyUrls.length > 0 && matches(this.o.denyUrls, file)) {
        this.logger.debug('ignored by denyUrls', { file });

        return '';
      }
      if (this.o.allowUrls.length > 0 && !matches(this.o.allowUrls, file)) {
        this.logger.debug('not in allowUrls', { file });

        return '';
      }
    }
    if (this.o.dedupe && this.dedupe.isDuplicate(exceptionKey(exceptions))) {
      this.dispatcher.reports.record('deduplicated', 'error');
      this.logger.debug('repeat of an error sent moments ago; counted, not sent', { message });

      return '';
    }
    if (!this.errorValve.take() || !this.typeValve.take(first.type)) {
      this.dispatcher.reports.record('ratelimit', 'error');
      this.logger.warn(`more than ${this.o.maxErrorsPerMinute} errors in a minute; dropping until the valve refills`);

      return '';
    }
    if (!sampled(issueKey(exceptions), this.o.errorSampleRate)) {
      this.dispatcher.reports.record('sample_rate', 'error');

      return '';
    }

    for (const exception of exceptions) stampDebugIds(exception.stack);

    const id = hexId();
    const event: Record<string, unknown> = {
      event_id: id,
      timestamp: new Date().toISOString(),
      level: isLevel(level) ? level : 'error',
      exceptions,
      mechanism: { type: mechanism, handled, synthetic },
      device_id: this.identity.deviceId,
      session_id: this.identity.peekSessionId(),
      environment: this.o.environment,
      context: normalize({ ...pageContext(this.o), ...this.context, ...(hint.context ?? {}) }, this.normalizeOptions),
    };
    if (this.identity.userId !== null) event['user_id'] = this.identity.userId;
    if (this.o.release !== '') event['release'] = this.o.release;
    const tags = normalizeTags({ ...this.tags, ...(hint.tags ?? {}) }, MAX_TAGS, MAX_TAG_KEY_BYTES, MAX_TAG_VALUE_BYTES, (key) =>
      this.logger.warn(`tag "${key}" dropped: at most ${MAX_TAGS} tags`),
    );
    if (Object.keys(tags).length > 0) event['tags'] = tags;
    const crumbs = this.crumbs.list();
    if (crumbs.length > 0) event['breadcrumbs'] = crumbs;
    if (Array.isArray(hint.fingerprint) && hint.fingerprint.length > 0) {
      event['fingerprint'] = hint.fingerprint.slice(0, MAX_FINGERPRINT_PARTS).map((part) => truncateToBytes(String(part), MAX_FINGERPRINT_PART_BYTES));
    }

    const hooked = runHooks(this.o.beforeSend, event);
    if (hooked.value === null) {
      this.dispatcher.reports.record('before_send', 'error');
      if (hooked.threw !== undefined) this.logger.warn('beforeSend threw; the error was dropped', { error: String(hooked.threw) });

      return '';
    }

    const final = this.o.beforeSend.length > 0 ? this.renormalizeError(hooked.value) : hooked.value;
    if (!this.dispatcher.errors.push('error', final)) {
      this.dispatcher.reports.record('before_send', 'error');
      this.logger.warn('an error was dropped: beforeSend returned something that cannot be sent (a BigInt, a cycle, or a promise)');

      return '';
    }
    this.persist();
    // Errors go now: the page that produced one may be about to go away.
    void this.flush();

    return id;
  }

  addBreadcrumb(crumb: Partial<Breadcrumb>): void {
    this.guarded(() => {
      if (this.closed || this.inert !== null) return;
      const shaped = toBreadcrumb(crumb, Date.now);
      if (shaped === null) return;
      const hooked = runHooks(this.o.beforeBreadcrumb, shaped);
      if (hooked.value === null) return;
      this.crumbs.add(hooked.value);
    });
  }

  setTag(key: string, value: string): void {
    this.guarded(() => {
      if (typeof key !== 'string' || key === '') return;
      this.tags[key] = String(value);
    });
  }

  setTags(tags: Record<string, string>): void {
    this.guarded(() => {
      if (typeof tags !== 'object' || tags === null) return;
      for (const [key, value] of Object.entries(tags)) this.setTag(key, value);
    });
  }

  setContext(context: Props | null): void {
    this.guarded(() => {
      if (context === null) this.context = {};
      else if (typeof context === 'object') Object.assign(this.context, context);
    });
  }

  scope(): Scope {
    return {
      setTag: (key, value) => this.setTag(key, value),
      setTags: (tags) => this.setTags(tags),
      setContext: (context) => this.setContext(context),
    };
  }

  /**
   * Run `work` with tags and context that are discarded afterwards, and return what it returns.
   *
   * Synchronous: the scope is restored when `work` returns, so tags set after an `await` inside it
   * are not isolated. A page has one person at a time and no async context to hang a scope on.
   * An exception from `work` is the application's and goes straight back to it, unreported: the
   * SDK changing control flow, or reporting an error the application is about to handle, would be
   * worse than useless.
   */
  withScope<T>(work: (scope: Scope) => T): T {
    const tags = { ...this.tags };
    const context = { ...this.context };
    try {
      return work(this.scope());
    } finally {
      this.tags = tags;
      this.context = context;
    }
  }

  // Consent -------------------------------------------------------------------------------------

  optOut(): void {
    this.guarded(() => {
      this.identity.setConsent(false);
      // The visitor's own instruction, not a failure: nothing to report, and nowhere to report it.
      this.dispatcher.events.discardAll(null);
      this.dispatcher.errors.discardAll(null);
      this.persistence?.clear();
      this.logger.debug('opted out');
    });
  }

  optIn(): void {
    this.guarded(() => {
      this.identity.setConsent(true);
      this.logger.debug('opted in');
    });
  }

  hasOptedOut(): boolean {
    return !this.identity.allowed;
  }

  // Ids -----------------------------------------------------------------------------------------

  getDeviceId(): string {
    return this.identity.deviceId;
  }

  getSessionId(): string {
    return this.inert !== null ? '' : this.identity.peekSessionId();
  }

  getUserId(): string | null {
    return this.identity.userId;
  }

  // Lifecycle -----------------------------------------------------------------------------------

  /**
   * Send what is queued. True only when everything that was queued when the call started was
   * accepted; false while any of it is still held, retrying, or was refused. Reusable: a false
   * flush can be called again.
   */
  flush(): Promise<boolean> {
    if (this.inert !== null) return Promise.resolve(true);
    if (this.closing !== null) return this.closing;
    if (!this.identity.allowed) return Promise.resolve(true);

    return this.flushNow();
  }

  /**
   * Stop, and make one last bounded attempt to deliver. New captures are refused from the moment
   * it is called. Every call, including one made while the first is still running, gets the same
   * answer. Records it could not deliver stay in the persisted queue for the next page.
   */
  close(): Promise<boolean> {
    if (this.closing === null) {
      this.closed = true;
      this.closing = this.shutdown();
    }

    return this.closing;
  }

  private async flushNow(): Promise<boolean> {
    if (this.flushTimer !== null) {
      natives.clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    const ok = await this.dispatcher.flush();
    this.persist();
    if (this.dispatcher.pending > 0 && this.closing === null && !this.dispatcher.isStopped) {
      this.scheduleFlush(Math.max(this.dispatcher.nextRetryIn(), this.o.flushIntervalMs));
    }

    return ok;
  }

  private async shutdown(): Promise<boolean> {
    if (this.flushTimer !== null) natives.clearTimeout(this.flushTimer);
    this.flushTimer = null;

    let ok = true;
    try {
      if (this.inert === null && this.identity.allowed) ok = await this.bounded(this.flushNow(), this.o.shutdownTimeout);
      if (!ok && this.dispatcher.pending > 0) {
        this.logger.warn(`close(): ${this.dispatcher.pending} record(s) were not delivered${this.persistence !== null ? '; they stay queued for the next page' : ''}`);
      }
    } catch {
      ok = false;
    } finally {
      for (const teardown of this.teardowns.splice(0)) {
        try {
          teardown();
        } catch {
          // Keep tearing down.
        }
      }
      this.instrumentation.teardown();
      this.dispatcher.stop();
      this.persist(true);
    }

    return ok;
  }

  /** The promise's answer, or false once `ms` has passed. */
  private bounded(work: Promise<boolean>, ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = natives.setTimeout(() => resolve(false), ms);
      work.then(
        (value) => {
          natives.clearTimeout(timer);
          resolve(value);
        },
        () => {
          natives.clearTimeout(timer);
          resolve(false);
        },
      );
    });
  }

  // Internals -----------------------------------------------------------------------------------

  private ready(method: string): boolean {
    if (this.closed) {
      this.logger.warn(`${method}() after close() does nothing`);

      return false;
    }
    if (this.inert !== null) {
      this.logger.debug(`${method}(): inert (${this.inert})`);

      return false;
    }
    if (this.dispatcher.isStopped) {
      // Already said once, loudly, when the server refused the key or redirected.
      this.logger.debug(`${method}(): sending has stopped`);

      return false;
    }
    if (!this.identity.allowed) {
      this.logger.debug(`${method}(): opted out`);

      return false;
    }

    return true;
  }

  private afterCapture(): void {
    this.persist();
    if (this.dispatcher.events.length >= this.o.flushAt) void this.flush();
    else this.scheduleFlush(this.o.flushIntervalMs);
  }

  private scheduleFlush(ms: number): void {
    if (this.closed || this.flushTimer !== null) return;
    this.flushTimer = natives.setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, ms);
  }

  private persist(immediate = false): void {
    // A getter, not the arrays: a throttled write runs later, and must write the queue as it is then.
    this.persistence?.save(() => ({ events: this.dispatcher.events.peek(), errors: this.dispatcher.errors.peek() }), immediate);
  }

  /**
   * `pagehide` (leaving) or `visibilitychange` to hidden (maybe coming back).
   *
   * The persisted copy is written FIRST: it is what survives if the send does not. A keepalive
   * request can still report its answer when the page stays alive, so its records are removed
   * only on a 2xx. A beacon reports nothing, so its records are removed only when the page is
   * really leaving; a tab that is merely hidden keeps them and sends them normally later.
   */
  private onUnload(leaving: boolean): void {
    this.guarded(() => {
      if (this.closed || this.inert !== null) return;
      this.identity.flushSession();
      if (this.o.autoPageviews.leave) this.pageLeave();
      if (!this.identity.allowed || this.dispatcher.isStopped) return;
      this.persist(true);
      this.dispatcher.buildAll().forEach(({ out, entries }, index) => this.sendUnload(out.endpoint, entries, index === 0, leaving));
    });
  }

  /** Keepalive or beacon what fits; halve what does not; give up under the floor. */
  private sendUnload(endpoint: Endpoint, entries: readonly Entry[], withReport: boolean, leaving: boolean): void {
    const queue = endpoint === '/v1/errors' ? this.dispatcher.errors : this.dispatcher.events;
    const out = this.dispatcher.buildRequest(endpoint, entries, withReport);
    const result = this.transport.sendOnUnload(
      out,
      () => {
        // Answered while the page was still here: exactly these records, wherever they are now.
        queue.remove(entries);
        this.dispatcher.commitReport(out);
        this.persist();
      },
      leaving,
    );
    if (result === 'sent') return;
    if (result === 'beacon') {
      if (leaving) {
        queue.remove(entries);
        this.dispatcher.commitReport(out);
      }

      return;
    }
    if (result === 'too_large' && entries.length > 1) {
      const half = Math.ceil(entries.length / 2);
      this.sendUnload(endpoint, entries.slice(0, half), withReport, leaving);
      this.sendUnload(endpoint, entries.slice(half), false, leaving);
    }
    // 'refused': the browser's quota is spent. The persisted copy goes out with the next page.
  }

  /** Payload keys past what the server allows alongside this event's context, dropped with a warning. */
  private capProperties(name: string, payload: Props, context: Props): Props {
    return capCombined(payload, context, MAX_PROPERTIES_PER_EVENT, (key) =>
      this.logger.warn(`property "${key}" on "${name}" was dropped: an event carries at most ${MAX_PROPERTIES_PER_EVENT} properties and context together`),
    );
  }

  /** A hook may have added anything. Its output meets the same limits the SDK's own did. */
  private renormalizeEvent(name: string, event: Record<string, unknown>): Record<string, unknown> {
    if (typeof event !== 'object' || event === null) return event;
    const out = { ...event };
    const context = isRecord(out['context']) ? normalize(out['context'], this.normalizeOptions) : {};
    if (isRecord(out['context'])) out['context'] = context;
    if (isRecord(out['payload'])) out['payload'] = this.capProperties(name, normalize(out['payload'], this.normalizeOptions), context);

    return out;
  }

  private renormalizeError(event: Record<string, unknown>): Record<string, unknown> {
    if (typeof event !== 'object' || event === null) return event;
    const out = { ...event };
    if (isRecord(out['context'])) out['context'] = normalize(out['context'], this.normalizeOptions);
    if (isRecord(out['tags'])) out['tags'] = normalizeTags(out['tags'], MAX_TAGS, MAX_TAG_KEY_BYTES, MAX_TAG_VALUE_BYTES);

    return out;
  }

  /** Take on the identity another tab wrote, together with the properties it registered. */
  private adoptSharedIdentity(): void {
    this.guarded(() => {
      if (this.closed || this.inert !== null) return;
      if (!this.identity.reload()) return;
      this.supers = (parseJson(this.stores.data.get(this.keys.sup)) as Props | undefined) ?? {};
      this.logger.debug('identity changed in another tab; adopted', { deviceId: this.identity.deviceId });
    });
  }

  private noteScroll(): void {
    const win = natives.window!;
    const doc = natives.document!;
    const height = Math.max(doc.documentElement?.scrollHeight ?? 0, doc.body?.scrollHeight ?? 0) - win.innerHeight;
    if (height <= 0) {
      this.pageMaxScroll = 100;

      return;
    }
    this.pageMaxScroll = Math.max(this.pageMaxScroll, Math.min(100, Math.round((win.scrollY / height) * 100)));
  }

  private pageLeave(): void {
    if (this.pageStarted === 0) return;
    const duration = Date.now() - this.pageStarted;
    this.pageStarted = 0;
    this.track('$pageleave', { $duration_ms: duration, $scroll_depth: this.pageMaxScroll });
  }

  private guarded<T>(fn: () => T, fallback?: T): T {
    try {
      return fn();
    } catch (error) {
      this.logger.error('internal failure', { error: String(error) });
      try {
        this.o.onError?.(error instanceof Error ? error : new Error(String(error)));
      } catch {
        // The customer's handler threw. Nothing more can be done about that here.
      }

      return fallback as T;
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
