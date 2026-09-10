# Changelog

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
