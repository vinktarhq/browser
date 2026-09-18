# Changelog

## 0.3.0

The SDK must never break the page it is installed in, whatever it is handed. This release closes
the places where it could, and changes what `init()` does with a key it cannot use: read "Changed".

### Changed

- `init()` never throws. Given a secret key (`vnk_sk_…`) it used to throw a `TypeError`; it now
  logs one error telling you to rotate the key, does not keep the key, and leaves the client inert.
  A missing key is logged at error level instead of as a warning. Either way `flush()` and
  `close()` resolve `true` and nothing is sent, exactly as with `enabled: false`.
- `withScope()` given anything but a function logs a warning and returns `undefined`. It used to
  throw a `TypeError`. What your callback throws still goes straight back to you.
- Entries of `ignoreErrors`, `denyUrls`, `allowUrls` and `propagateIdentity` that are neither a
  string nor a `RegExp` are dropped with a warning, and so are entries of `redactedKeys`,
  `propertyDenylist` and `enabledEnvironments` that are not strings. A `null` in `redactedKeys`
  used to become the fragment `"null"`.
- The bundle is about 1 kB larger.

### Fixed

- `propagateIdentity: [undefined]` (or any entry that is not a pattern) made every `fetch` and
  every `XMLHttpRequest.send` on the page throw.
- The `fetch` and `XMLHttpRequest` wrappers call the original with exactly the arguments they were
  given and fail the way the browser does: `fetch(undefined)` is a rejected promise again, not a
  synchronous `TypeError`, and `xhr.open('GET', undefined)` no longer throws. A wrapper further
  down that returns something other than a promise of a `Response` gets it handed back untouched.
- `init(null)`, and options whose getters throw, no longer throw. Each option is read once, and one
  that cannot be read is ignored with a warning.
- A global that cannot be patched (a frozen `console`, a read-only `window.fetch`, a frozen
  `Error`) is skipped with a warning. It used to make `init()` throw and leave the patches made
  before it installed with nothing to remove them.
- `page()` with properties that are not an object threw, including when replayed from calls made
  before `init()`.
- A form whose `action` is not a valid URL threw from the submit listener, and a form control
  named `getAttribute`, `id`, `name` or `action` broke autocapture and click breadcrumbs for that
  form. Every listener the SDK adds now runs inside a `try`.
- A property whose getter throws costs that property, recorded as `[Unreadable]`, instead of the
  whole event. Normalising is bounded by the number of values visited as well as by depth, so a
  very wide object cannot stall `track()`.
- `flush()` and `close()` always resolve; a failure inside them is `false`, never a rejection.
- The module imports in a runtime without `TextEncoder`.

## 0.2.0

Delivery results could report success for data the server never kept, and several failure paths
lost data quietly. This release fixes both and changes four behaviours your code may rely on:
read "Changed" before upgrading.

### Changed

- `withScope()` returns the callback's value and lets an exception from it propagate. It used to
  catch the exception, report it as unhandled, and return `undefined`.
- `close()` returns `Promise<boolean>`, whether the final delivery was accepted. It stops accepting
  events as soon as it is called, every call gets the same answer, and the new `shutdownTimeout`
  option (default 2000 ms) bounds it.
- `flush()` resolves `true` only when everything queued at the call was accepted. A batch that is
  held, retrying, refused or partly rejected now resolves `false`. Neither result is an
  application error; do not retry your own work because of it.
- An error repeating within five seconds is sent once per window, and the window no longer
  restarts on every repeat. An error that fires continuously now shows up as it happens instead of
  once; those occurrences were real and hidden before. The suppressed repeats are counted in
  client reports as `deduplicated`.

### Fixed

- Any 2xx counts as accepted. A 200 or 204 from a proxy was retried and eventually dropped.
- Redirects are not followed. A 3xx from the ingest host stops sending with one error line
  instead of sending the write key and the body to another location.
- A storage outage (503) backs off exponentially instead of giving up after about two minutes,
  and failed attempts while the browser is offline no longer count towards the retry limit.
- A monthly cap holds until the server's reset time, checking again at most every six hours,
  instead of always six hours.
- A rate-limit header without a seconds part no longer cancels the wait the server asked for, and
  a long hold on events no longer delays sending errors.
- A `beforeTrack` or `beforeSend` hook that returns something unserialisable (a BigInt, a cycle, a
  promise) drops only that record. It used to lose the whole batch, and could throw from the
  persistence timer. Hook output is held to the same limits as the SDK's own.
- Changing an object after passing it to `track()` no longer changes what is sent.
- Payload and context properties together stay within the server's 255-property limit.
- The request timeout covers compression and reading the response body.
- After a 401 or 403 nothing more is queued and the flush timer stops.
- Records sent while a tab is hidden are removed only once that request is answered, so a failed
  send is retried instead of lost, and splitting an unload send no longer removes the wrong records.
- A login or logout in another tab is adopted, so a tab left open does not keep sending the
  previous person's ids.
- `reset()` no longer takes first-touch attribution from the page it was called on.
- `captureMessage()` honours `handled: false`.
- Opting out no longer reports the discarded queue as failed sends.
- Client reports are kept when the request carrying them is refused, are sent on only one request
  when the page unloads, and go out on an explicit `flush()` even when nothing else is queued.
- The queue is bounded by size as well as count, and a slow request no longer pushes out records
  captured while it runs.

## 0.1.0

First release.

### Analytics

- `track`, `page`, `identify` with flat `$set` / `$set_once` / `$unset` traits, `setUser`,
  `reset`, and persisted super properties with `register` / `registerOnce` / `unregister`.
- Automatic pageviews on load and on History API changes, counting only a change in the parts of
  the URL the application says matter (path by default), so a framework's repeated
  `replaceState` calls are one pageview. Optional `$pageleave` with duration and scroll depth.
- Optional autocapture of clicks and form submissions carrying element identity only.
- Every event carries URL, referrer, campaign parameters, screen and viewport, language and
  timezone, plus first-visit attribution as `$initial_*` properties.
- Deterministic per-device sampling, a per-minute valve, and known-bot filtering for analytics only.

### Identity

- A UUIDv7 device id, kept in localStorage or, with `crossSubdomainCookie`, in a cookie on the
  registrable domain found by probing the browser rather than by shipping a suffix list.
- Sessions as one shared tuple across tabs: 30 minutes idle, 24 hours maximum, activity written
  through every five seconds, the freshest tab's view consulted before a session is declared idle,
  and every comparison robust to a clock that jumps backwards.
- A warning on linking a device to a second user, and a new device id on every `reset()`.
- Optional identity propagation headers on the page's own requests to listed origins.

### Errors

- Uncaught exceptions and unhandled rejections through `addEventListener`, never by assigning
  `window.onerror`; `Error.stackTraceLimit` raised to 50.
- A coercion chain for everything that can be thrown: errors, `ErrorEvent`, `DOMException`,
  rejection events (including the `detail.reason` shape), objects carrying an error, plain objects
  and primitives, with `framesToPop` honoured and a cause chain sent thrown-first.
- Stack parsing for V8, Gecko, WebKit and Hermes with frames crash-last and columns zero-based;
  lines capped before any regular expression runs; recursion collapsed to one canonical copy of
  its cycle so a stack overflow is one issue.
- Extension frames, the well-known browser-noise list, `ignoreErrors`, `denyUrls` / `allowUrls`
  on the crash frame, a five-second dedupe and per-minute valves, all applied before a request is
  spent.
- Breadcrumbs from console output, `fetch` and XHR (method, URL, status, duration; never a body or
  a header), navigations and clicks, with the SDK's own traffic and console lines excluded.
- Debug ids read from the registry that `@vinktarhq/cli` fills at build time.
- Secret-shaped values scrubbed from messages before they leave the page.

### Transport

- Batched, compressed sends with the response state machine the server publishes: durable on
  202, retained on 503, held per category on 429, halved on 413, stopped on 401/403, and backed
  off with jitter otherwise, with a short budget for requests that never got an answer.
- Unload delivery by keepalive request under the browser's shared budget, otherwise by a
  CORS-simple beacon, halving down to a floor; the persisted queue is kept until the next page
  adopts it, and `event_id` makes the retry safe.
- A client report of everything the SDK dropped, and why, in every request.

### Consent and privacy

- Three-state consent that survives `reset()`, `optOutByDefault`, Do Not Track and Global Privacy
  Control, and URLs cut to origin and path with ad-network click ids masked unless PII is allowed.

### Packaging

- ESM and CommonJS with types, `sideEffects: false`, a minified IIFE for a script tag that
  auto-initialises from `data-*` attributes and drains a pre-load stub queue, and a web-vitals
  integration behind its own subpath. Zero runtime dependencies.
