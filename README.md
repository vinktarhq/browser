# @vinktarhq/browser

[![npm](https://img.shields.io/npm/v/@vinktarhq/browser.svg)](https://www.npmjs.com/package/@vinktarhq/browser)
[![CI](https://github.com/vinktarhq/browser/actions/workflows/ci.yml/badge.svg)](https://github.com/vinktarhq/browser/actions/workflows/ci.yml)
[![size](https://img.shields.io/bundlephobia/minzip/@vinktarhq/browser.svg)](https://bundlephobia.com/package/@vinktarhq/browser)
[![licence](https://img.shields.io/npm/l/@vinktarhq/browser.svg)](./LICENSE)

Product analytics and error tracking for the browser, in one small bundle.

Pageviews, events and identities on one side; uncaught errors, rejections and the breadcrumbs
that led to them on the other. Both go to [Vinktar](https://vinktar.com) over one connection,
with one identity, so an error can be read next to what the person was doing.

```ts
import { init, track, identify, captureException } from '@vinktarhq/browser';

init({ writeKey: 'vnk_pk_…' });

track('checkout_started', { plan: 'pro' });
identify('user_42', { email: 'ada@example.com' });
captureException(new Error('something the app caught'));
```

Or, with no build step at all:

```html
<script src="https://unpkg.com/@vinktarhq/browser/dist/vinktar.min.js" data-key="vnk_pk_…" defer></script>
```

That is the whole setup. Pageviews are sent automatically, including single-page-app route
changes, and uncaught errors are reported with their stack, breadcrumbs and the current user.

**About 20 kB compressed. Zero runtime dependencies. Never throws into your code.** Everything
the SDK cannot send is said out loud in the console once, never silently dropped.

---

## Contents

- [Getting a key](#getting-a-key)
- [Analytics](#analytics)
- [Identity](#identity)
- [Errors](#errors)
- [Consent and privacy](#consent-and-privacy)
- [Options](#options)
- [The script tag](#the-script-tag)
- [My events are not showing up?](#my-events-are-not-showing-up)
- [How it works](#how-it-works)
- [Compatibility](#compatibility)
- [Licence](#licence)

---

## Getting a key

The browser uses the project's **write key**, which starts `vnk_pk_`. It is safe to ship in a
bundle: it can only append events to your project. A secret key (`vnk_sk_`) must never reach a
browser, and `init()` throws if given one, because a key in a bundle is a key in every visitor's
hands.

Keys are created in the project settings.

## Analytics

```ts
track('button_clicked', { button: 'buy', plan: 'pro' });
page('Pricing');                        // a manual pageview; automatic ones need nothing
register({ experiment: 'new_nav' });    // on every event from now on, persisted
registerOnce({ first_seen_plan: 'free' });
unregister('experiment');
```

Automatic pageviews fire on load and on every change of the URL's path. Frameworks call
`history.replaceState` freely during a transition, so a change in the query string or the hash
does not count unless you say so:

```ts
init({ writeKey, autoPageviews: { path: true, search: true, hash: false } });
```

`autoPageviews: { leave: true }` adds a `$pageleave` event with the time on the page and the
scroll depth reached. It is off by default because it is an event per page on your bill.

`autocapture: true` sends a `$autocapture` event for clicks on links, buttons and controls and
for form submissions. Only the element's identity goes out (tag, id, classes, `href`, form name
and action), never the text on it and never a field's value.

Every event carries the current URL (origin and path only, by default), referrer, UTM parameters,
screen and viewport size, language and timezone, plus the referrer and campaign of the **first**
visit as `$initial_*` properties.

## Identity

```ts
identify('user_42', { email: 'ada@example.com', plan: 'pro' }, { signed_up: '2026-01-15' });
setTraits({ plan: 'team' });
unsetTraits(['trial_ends']);
reset();   // on logout
```

Every visitor gets a **device id** minted here and kept in storage; `identify()` links a user to
it. Traits are flat values: the second argument is set every time, the third only the first time.
Reserved traits (`email`, `name`, `username`, `avatar`, `created`) are stored under their
canonical `$`-prefixed names; you can spell them either way.

**Call `reset()` on logout.** The server keeps the first link between a device and a user, so on a
shared browser the next person would otherwise be attributed to the previous one. `reset()`
mints a new device id; the SDK warns when it sees a device being linked to a second user.

`setUser({ id, ...traits })` is the same call in the shape other SDKs use; `setUser(null)` is
`reset()`.

Sessions rotate after 30 minutes without activity or 24 hours in total, are shared across tabs,
and survive a clock that jumps. `crossSubdomainCookie: true` shares the device and session
across subdomains through a cookie on the registrable domain, which the SDK finds by asking the
browser rather than shipping a suffix list.

## Errors

Uncaught exceptions and unhandled rejections are reported as soon as they happen, with the
cause chain, parsed frames, the last 30 breadcrumbs (console output, network requests,
navigations and clicks), the current user and tags.

```ts
captureException(error, { tags: { area: 'checkout' }, context: { order: 42 } });
captureMessage('Payment took longer than 10s', { level: 'warning' });
addBreadcrumb({ category: 'cart', message: 'item added', data: { sku: 'A1' } });
setTag('release_channel', 'beta');
withScope((scope) => {
  scope.setTag('retry', '2');
  captureException(error);   // tagged; the tag does not outlive the callback
});
```

What is filtered before anything is sent, so noise costs nothing: errors that come entirely from
browser extensions, the well-known list of unactionable browser messages
(`disableErrorDefaults: true` turns it off), your own `ignoreErrors`, `denyUrls` / `allowUrls`
tested against the frame where the crash happened, exact repeats within five seconds, and a
per-minute valve (25 by default) so a render loop cannot spend a month's quota in an afternoon.
Recursive stacks are collapsed to one copy of their cycle, so a stack overflow is one issue rather
than one per place the runtime happened to cut it.

Messages and source lines are scrubbed for secret-shaped values (card numbers, API keys, JWTs,
bearer tokens) before they leave the page. Property keys that look sensitive (`password`,
`token`, `secret`, `authorization`, …) are redacted everywhere.

Source maps: stack traces resolve to your original code when the maps are uploaded with
[`@vinktarhq/cli`](https://www.npmjs.com/package/@vinktarhq/cli). Its bundler plugins stamp each
chunk with a debug id that this SDK reads at capture time, so a frame matches its map even when
the URL or the release string is wrong.

### Web vitals

```ts
import { webVitals } from '@vinktarhq/browser/web-vitals';
init({ writeKey, integrations: [webVitals()] });
```

Sends LCP, CLS, INP, FCP and TTFB as `$web_vital` events with the final values, once, when the
page is hidden. About 700 bytes.

## Consent and privacy

```ts
init({ writeKey, optOutByDefault: true });   // nothing leaves until…
optIn();
optOut();
hasOptedOut();
```

Consent is kept in storage and is not touched by `reset()`. `respectDnt: true` honours Do Not
Track and Global Privacy Control by never starting. `disablePersistence: true` keeps everything
in memory (a new device id on every load). By default URLs are cut to origin and path, network
breadcrumbs carry no query strings, and ad-network click ids (`gclid`, `fbclid`, …) are masked;
`sendDefaultPii: true` keeps them. Analytics from known automated traffic (headless browsers,
crawlers, `navigator.webdriver`) are dropped; errors never are.

## Options

Every number is clamped to a sane range with a warning rather than taken as given.

| Option | Default | |
|---|---|---|
| `writeKey` | | The project write key, `vnk_pk_…`. Required; without it the SDK is inert and says so. |
| `host` | `https://in.vinktar.com` | Ingest host. |
| `enabled` | `true` | Master switch. |
| `debug` | `false` | Verbose logging. |
| `analytics` / `errors` | `true` | Either half can be turned off. `identify` is never silenced. |
| `release` / `environment` | `''` / detected | `environment` is `development` on localhost and `production` elsewhere. |
| `enabledEnvironments` | `[]` | Send only from these environments. |
| `flushAt` / `flushIntervalMs` | `20` / `10000` | Batch size and interval. Errors and identifies do not wait. |
| `maxQueueSize` | `500` | Oldest events are dropped past this, and counted. |
| `requestTimeoutMs` | `10000` | |
| `gzip` | `true` | Compress bodies of 1 KiB and over. |
| `persistQueue` | `true` | Keep the queue in localStorage across navigations and crashes. |
| `autoPageviews` | `true` | Or `{ path, search, hash, leave }`. |
| `autocapture` | `false` | Or `{ clicks, forms }`. |
| `sessionTimeoutMs` / `sessionMaxMs` | 30 min / 24 h | |
| `breadcrumbs` | `true` | Or `{ console, network, navigation, click }`. |
| `maxBreadcrumbs` | `30` | At most 50. |
| `sampleRate` / `errorSampleRate` | `1` | Per device / per issue, deterministic. |
| `maxEventsPerMinute` / `maxErrorsPerMinute` | `600` / `25` | Client-side valves. |
| `dedupe` | `true` | Drop an identical error within five seconds. |
| `ignoreErrors` / `denyUrls` / `allowUrls` | `[]` | Strings (substring) or regular expressions. |
| `disableErrorDefaults` | `false` | Turn off the built-in browser-noise list. |
| `superProperties` | `{}` | On every event, under whatever `register()` persisted. |
| `sendDefaultPii` | `false` | Full URLs, query strings and click ids. |
| `redactedKeys` / `propertyDenylist` | `[]` | Extra key fragments to mask; top-level keys to drop. |
| `disablePersistence` / `crossSubdomainCookie` | `false` | See above. |
| `useBeacon` | `true` | Use `sendBeacon` on unload when a keepalive request cannot carry the batch. |
| `optOutByDefault` / `respectDnt` / `filterBots` | `false` / `false` / `true` | |
| `propagateIdentity` | `[]` | Origins that get `X-Vinktar-Device-Id` and `X-Vinktar-Session-Id` on your own requests, so a server SDK stitches its events to this visit. |
| `initialScope` | `{}` | `{ tags, context }` for every error. |
| `maxValueBytes` / `normalizeDepth` | `255` / `3` | The server's caps; cannot be raised. |
| `includeRawStack` / `attachStacktrace` | `false` | Send the raw stack too; attach one to `captureMessage`. |
| `integrations` | `[]` | See web vitals. |
| `beforeTrack` / `beforeSend` / `beforeBreadcrumb` | | A function or a list: return the value, or `null` to drop it. |
| `onError` | | Called when the SDK itself fails at something. |
| `logger` | console | `(level, message, data) => void`. |

## The script tag

The CDN build installs `window.vinktar` with the same functions as the module and reads its
options from `data-*` attributes on the tag: `data-key`, `data-host`, `data-release`,
`data-environment`, `data-debug`, `data-autocapture`, `data-auto-pageviews`, `data-sample-rate`,
`data-send-default-pii`, `data-cross-subdomain-cookie`, `data-opt-out-by-default`,
`data-respect-dnt`, `data-filter-bots`.

To call the SDK before the script has loaded, define the stub the calls queue into:

```html
<script>
  window.vinktar = window.vinktar || { q: [] };
  ['track', 'identify', 'page', 'captureException', 'setTag'].forEach(function (m) {
    window.vinktar[m] = function () { window.vinktar.q.push([m].concat([].slice.call(arguments))); };
  });
</script>
<script src="https://unpkg.com/@vinktarhq/browser/dist/vinktar.min.js" data-key="vnk_pk_…" async></script>
```

## My events are not showing up?

Open the console. The SDK never fails silently: a missing key, an option out of range, a dropped
property, a trait the server refused, a rejected batch and a rate limit each produce one line
that says what happened and why. `debug: true` adds the rest.

The three things it is usually one of: the key is a secret key (the SDK throws) or missing (it
says so once); an ad blocker is blocking the request (the SDK retries three times and then
counts the batch as a send error, which you can see in the project's client reports); or the
page is `localhost`, which reports under the `development` environment.

## How it works

Events are batched and sent as JSON, compressed over 1 KiB, to `/v1/batch`; errors go to
`/v1/errors` immediately. A `202` means the batch is durably stored and the SDK forgets it. A
`503` means it was **not** stored and the SDK keeps it. `429` pauses only the throttled category
(a throttled event stream never delays an error). `413` halves the batch. `401`/`403` stop the SDK
for good with one loud line. Everything else backs off exponentially with jitter, capped at
thirty minutes; a request that never got an answer at all (offline, or a blocker) gets three
attempts.

The queue is persisted to localStorage per tab and written synchronously when the page is hidden
or unloaded, then sent with a keepalive request or a beacon. The persisted copy is not deleted on
that path, because a beacon never reports success; the next page on the origin adopts any slot
that is over a minute old and sends it, and the server deduplicates on the event id.

Every request carries exactly three headers (`Content-Type`, `Content-Encoding` and
`X-Vinktar-Key`); the SDK identifies itself inside the body. The SDK captures the platform's
`fetch`, `console` and history functions before anything else patches them, tags its own patches
so two copies on one page cooperate rather than wrap each other, and skips its own requests and
its own console lines when recording breadcrumbs.

The wire contract the tests run against (limits, blocked ids, the response state machine, trait
parsing, stack parsing across engines, deterministic sampling) is vendored in `spec/` and
published at [vinktar.com/api.md](https://vinktar.com/api.md).

## Compatibility

| | |
|---|---|
| Browsers | Anything with `fetch`, `Promise` and ES2020; that is every browser released since 2020. Compression uses `CompressionStream` when present and sends uncompressed otherwise. |
| Frameworks | Any. Route changes are detected through the History API; `usePageviews`-style hooks are not needed. |
| Server rendering | The module imports safely without a `window` and stays inert until it is given one. |
| Bundles | ESM and CommonJS with types, `sideEffects: false`; a minified IIFE for a script tag. Source maps ship without embedded sources and are marked as library code, so devtools skip them. |
| Node for the toolchain | 18.17 and newer. |

## Licence

MIT. © Vinktar.
