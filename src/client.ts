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
import { MAX_FINGERPRINT_PART_BYTES, MAX_FINGERPRINT_PARTS, MAX_TAG_KEY_BYTES, MAX_TAG_VALUE_BYTES, MAX_TAGS, type Level } from './core/limits.js';
import type { Logger } from './core/logger.js';
import { normalize, normalizeTags, parseJson, type NormalizeOptions, type Props } from './core/normalize.js';
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
      gzip: this.o.gzip,
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
    const onHide = (): void => this.onUnload();
    this.instrumentation.listen(win, 'pagehide', onHide);
    this.instrumentation.listen(doc, 'visibilitychange', () => {
      if (doc.visibilityState === 'hidden') onHide();
    });
    this.instrumentation.listen(win, 'pageshow', () => {
      if (this.dispatcher.pending > 0) this.scheduleFlush(this.o.flushIntervalMs);
    });
    this.instrumentation.listen(win, 'online', () => {
      this.dispatcher.backoff.clear();
      this.scheduleFlush(0);
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
        payload,
        context: normalize(pageContext(this.o), this.normalizeOptions),
      };
      if (this.identity.userId !== null) event['user_id'] = this.identity.userId;

      const hooked = runHooks(this.o.beforeTrack, event);
      if (hooked.value === null) {
        this.dispatcher.reports.record('before_send', 'event');
        if (hooked.threw !== undefined) this.logger.warn('beforeTrack threw; the event was dropped', { error: String(hooked.threw) });

        return;
      }

      this.dispatcher.events.push('event', hooked.value);
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
      void this.flush();
      this.identity.reset();
      this.crumbs.clear();
      this.tags = { ...this.o.initialScope.tags };
      this.context = { ...this.o.initialScope.context };
      this.supers = {};
      this.stores.data.remove(this.keys.sup);
      this.stores.data.remove(this.keys.attr);
      for (const [key, value] of Object.entries(initialAttribution(this.stores.data, this.keys.attr, this.o.sendDefaultPii))) this.supers[key] = value;
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

      return this.emit(exceptions, false, 'manual', true, hint ?? {}, hint?.level ?? 'info');
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
      if (this.o.denyUrls.length > 0 && matches(this.o.denyUrls, file)) return '';
      if (this.o.allowUrls.length > 0 && !matches(this.o.allowUrls, file)) return '';
    }
    if (this.o.dedupe && this.dedupe.isDuplicate(exceptionKey(exceptions))) return '';
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

    this.dispatcher.errors.push('error', hooked.value);
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

  /** Run `work` with tags and context that are discarded afterwards. Synchronous by design. */
  withScope<T>(work: (scope: Scope) => T): T | undefined {
    const tags = { ...this.tags };
    const context = { ...this.context };
    try {
      return work(this.scope());
    } catch (error) {
      this.captureException(error, { handled: false });

      return undefined;
    } finally {
      this.tags = tags;
      this.context = context;
    }
  }

  // Consent -------------------------------------------------------------------------------------

  optOut(): void {
    this.guarded(() => {
      this.identity.setConsent(false);
      this.dispatcher.events.discardAll('send_error');
      this.dispatcher.errors.discardAll('send_error');
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

  async flush(): Promise<boolean> {
    if (this.closed || this.inert !== null) return true;
    if (!this.identity.allowed) return true;
    if (this.flushTimer !== null) {
      natives.clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    const ok = await this.dispatcher.flush();
    this.persist();
    if (this.dispatcher.pending > 0 && !this.closed) this.scheduleFlush(Math.max(this.dispatcher.nextRetryIn(), this.o.flushIntervalMs));

    return ok;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    try {
      await this.flush();
    } finally {
      this.closed = true;
      if (this.flushTimer !== null) natives.clearTimeout(this.flushTimer);
      this.flushTimer = null;
      for (const teardown of this.teardowns.splice(0)) {
        try {
          teardown();
        } catch {
          // Keep tearing down.
        }
      }
      this.instrumentation.teardown();
      this.dispatcher.stop();
    }
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
    this.persistence?.save(this.dispatcher.events.peek(), this.dispatcher.errors.peek(), immediate);
  }

  private onUnload(): void {
    this.guarded(() => {
      if (this.closed || this.inert !== null) return;
      this.identity.flushSession();
      if (this.o.autoPageviews.leave) this.pageLeave();
      if (!this.identity.allowed) return;
      // The persisted copy is written FIRST: it is what survives if the send does not.
      this.persist(true);
      for (const { out, entries } of this.dispatcher.buildAll()) this.sendUnload(out.endpoint, entries);
    });
  }

  /** Beacon what fits; halve what does not; give up under the floor. Never deletes the persisted slot. */
  private sendUnload(endpoint: Endpoint, entries: readonly Entry[]): void {
    const out = this.dispatcher.buildRequest(endpoint, entries);
    const result = this.transport.sendOnUnload(out);
    if (result === 'sent') {
      const queue = endpoint === '/v1/errors' ? this.dispatcher.errors : this.dispatcher.events;
      queue.take(entries.length);

      return;
    }
    if (result === 'too_large' && entries.length > 1) {
      const half = Math.ceil(entries.length / 2);
      this.sendUnload(endpoint, entries.slice(0, half));
      this.sendUnload(endpoint, entries.slice(half));
    }
    // 'refused': the browser's beacon quota is spent. The persisted copy goes out with the next page.
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
