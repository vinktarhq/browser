# @vinktarhq/browser

[![npm](https://img.shields.io/npm/v/@vinktarhq/browser.svg)](https://www.npmjs.com/package/@vinktarhq/browser)
[![CI](https://github.com/vinktarhq/browser/actions/workflows/ci.yml/badge.svg)](https://github.com/vinktarhq/browser/actions/workflows/ci.yml)
[![size](https://img.shields.io/bundlephobia/minzip/@vinktarhq/browser.svg)](https://bundlephobia.com/package/@vinktarhq/browser)
[![licence](https://img.shields.io/npm/l/@vinktarhq/browser.svg)](./LICENSE)

Product analytics and error tracking for the browser, in one small bundle.

Pageviews, time on page, events and identities on one side; uncaught errors, rejections and the
breadcrumbs that led to them on the other. Both go to [Vinktar](https://vinktar.com) over one
connection, so an error can be read next to what the person was doing.

A visitor keeps one id in a first-party cookie, so they are the same visitor from page to page and
day to day, and `identify()` joins what they did before signing in. Cookieless is one option away.

The setup guide, and how to check that data arrives: [vinktar.com/docs/install/browser](https://vinktar.com/docs/install/browser).

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

That is the whole setup. Pageviews and time on page are sent automatically, including
single-page-app route changes, and uncaught errors are reported with their stack, breadcrumbs and
the current user.

**About 25 kB compressed. No runtime dependencies in the main bundle. Never throws into your
code.** Everything the SDK cannot send is said out loud in the console once, never silently
dropped.

---

## Contents

- [Getting a key](#getting-a-key)
- [Analytics](#analytics)
- [Where the ids are kept](#where-the-ids-are-kept)
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
browser, because a key in a bundle is a key in every visitor's hands. Given one, `init()` refuses
to use it: it logs one error telling you to rotate the key, and the SDK stays inert. `init()`
never throws, for this or for anything else, so a bad key cannot take your page down with it.

Keys are created in the project settings.

## Analytics

```ts
track('button_clicked', { button: 'buy', plan: 'pro' });
page('Pricing');                        // a manual pageview; automatic ones need nothing
register({ experiment: 'new_nav' });    // on every event from now on
registerOnce({ first_seen_plan: 'free' });
unregister('experiment');
```

### Pageviews

Automatic pageviews fire on load and on every change of the URL's path. Frameworks call
`history.replaceState` freely during a transition, so a change in the query string or the hash
does not count unless you say so:

```ts
init({ writeKey, autoPageviews: { path: true, search: true, hash: false } });
```

- **Only pages someone sees.** A page that loads in a background tab, or is prerendered by the
  browser or a speculation rule, sends its first pageview when it first becomes visible, and not
  at all if it never does.
- **How the page was reached**, as `$navigation_type`: `navigate`, `reload`, `back_forward` or
  `prerender` for the first pageview, `pushState`, `replaceState`, `popstate` or `hashchange` for
  a route change, and `back_forward_cache` when the back button restores the page from the
  browser's cache. That last one is a pageview too, although the URL has not changed.
- **The referrer of a route change is the previous page in the app**, not the site the visitor
  landed from, so only the first pageview of a visit carries the outside referrer.
- **Every `$pageview` carries `$pageview_id`**, which is also its `event_id`. The engagement and
  web vitals of that page carry the same id.

A `replaceState` that rewrites the URL before the first pageview has gone out (a locale prefix, a
redirect in the router) does not count twice: the first pageview takes the URL as it is by then.

### Time on page and scroll depth

`$engagement` events, on by default (`engagement: false` turns them off). One is sent whenever
the page is hidden (another tab, another app, the tab closed) and before every route change. Each
carries:

| Property | |
|---|---|
| `$pageview_id` | The pageview it belongs to. |
| `$engaged_ms` | Milliseconds the page was visible since the last `$engagement` for this pageview. An increment: the time on a page is the sum. Never 0, at most 30 minutes. |
| `$scroll_depth` | The furthest the visitor has seen, in percent of the page's height: (scroll position + viewport height) / page height. 100 for a page that fits on screen. |

Its `$current_url` is the page it measured, even when the route has already changed. The scroll
handler only compares numbers: the page height is cached and updated by a `ResizeObserver`, so
measuring never forces a layout while the visitor scrolls.

### Automatic events

`autoEvents: true` adds three events, from one delegated listener, so links rendered later count
too. None of them delays or cancels a navigation, and a middle click counts.

| Event | When | Properties |
|---|---|---|
| `link_clicked` | A link to another host, a `mailto:` or a `tel:` link | `kind` (`outbound`, `mailto`, `tel`). Outbound: `url` (origin and path) and `host`. Mailto: `host`, the domain of the address. |
| `file_downloaded` | A link whose path ends in a file extension: pdf, csv, doc(x), xls(x), ppt(x), zip, rar, 7z, dmg, exe, msi, apk, mp3, mp4, mov, txt, json, xml, key, numbers, pages | `url` (origin and path), `extension` |
| `form_submitted` | Any form submitted that has no `data-vinktar-event` | `form_id`, `form_name`, `form_action` (the path), whichever the form has |

Never the text of a link, an email address, a phone number or a field's value. With
`sendDefaultPii: true`, URLs keep their query string and `mailto:`/`tel:` links send `url`.

### Events in markup

No code needed: `data-vinktar-event` on any element sends that event when it is clicked, or for
a form, when it is submitted. Each `data-vinktar-prop-<key>` attribute becomes a property, with
dashes in the key turned into underscores.

```html
<button data-vinktar-event="trial_started" data-vinktar-prop-plan="pro">Start a trial</button>
<form data-vinktar-event="newsletter_subscribed" data-vinktar-prop-source="footer">…</form>
```

This is always on. A click anywhere inside a tagged element counts for it, and a tagged form
counts once, on submit.

### Not-found pages

`page_not_found` is sent with the pageview of a page that has a `data-vinktar-404` attribute on
any element (`<body data-vinktar-404>`), or whose title matches the `notFound` option
(`notFound: /page not found/i`). Nothing is guessed from the content.

### Autocapture

`autocapture: true` sends a `$autocapture` event for clicks on links, buttons and controls and
for form submissions. Only the element's identity goes out (tag, id, classes, `href`, form name
and action), never the text on it and never a field's value.

### What every event carries

The current URL (origin and path only, by default), referrer, UTM parameters, screen and viewport
size, language and timezone. Unless cookieless, also the referrer and campaign of the **first**
visit as `$initial_*` properties.

## Where the ids are kept

| `persistence` | Device, user, session, consent | Queue, `register()`, `$initial_*` |
| --- | --- | --- |
| `'localStorage+cookie'` (default) | a first-party cookie | localStorage |
| `'cookie'` | a first-party cookie | memory, for the page |
| `'localStorage'` | localStorage | localStorage |
| `'memory'` | nothing: cookieless | memory, for the page |

The cookie is the SDK's own, on your domain, and lasts a year. It is only on the current host
unless `crossSubdomainCookie: true` puts it on the registrable domain. A visitor whose ids an
earlier version kept in localStorage keeps them: they are copied into the cookie the first time
they are read.

```ts
init({ writeKey, persistence: 'memory' });   // cookieless
```

Cookieless writes nothing to cookies, localStorage or sessionStorage (the one exception: an
explicit `optOut()` is remembered, see below), and sends no `device_id` and no `session_id`. The
server counts a visitor from a hash of the IP address, the user agent and the project under a salt
that changes every day, and a visit as activity with no gap of 30 minutes. A visitor can be counted
again the next day, and cannot be followed from one day to the next. `identify()` works for the
life of the page: the user id is held in memory and sent as `user_id` on every event from it, but
nothing before it is joined to the user. `getDeviceId()` and `getSessionId()` return `''`. Errors
are reported exactly as before, with the user id when there is one and no device id.

## Identity

```ts
identify('user_42', { email: 'ada@example.com', plan: 'pro' }, { signed_up: '2026-01-15' });
setTraits({ plan: 'team' });
unsetTraits(['trial_ends']);
reset();   // on logout
```

Traits are flat values: the second argument is set every time, the third only the first time.
Reserved traits (`email`, `name`, `username`, `avatar`, `created`) are stored under their
canonical `$`-prefixed names; you can spell them either way.

Every visitor also gets a **device id** minted here and kept with the other ids, and `identify()`
links the user to it, so what they did before signing in belongs to them too. Cookieless, there is
no device to link, and the user id is sent on the page's events instead.

**Call `reset()` on logout.** The server keeps the first link between a device and a user, so on a
shared browser the next person would otherwise be attributed to the previous one. `reset()`
mints a new device id; the SDK warns when it sees a device being linked to a second user.

`setUser({ id, ...traits })` is the same call in the shape other SDKs use; `setUser(null)` is
`reset()`. A logout in one tab applies to the others: a tab left open picks up the new device id
instead of going on sending the previous person's.

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

`withScope` returns what its callback returns and lets anything it throws go straight back to you,
unreported. The tags are restored when the callback returns, so work after an `await` inside it is
not covered.

What is filtered before anything is sent, so noise costs nothing: errors that come entirely from
browser extensions, the well-known list of unactionable browser messages
(`disableErrorDefaults: true` turns it off), your own `ignoreErrors`, `denyUrls` / `allowUrls`
tested against the frame where the crash happened, repeats within five seconds of an error's first
occurrence (counted, not sent), and a
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

Measured with Google's [`web-vitals`](https://github.com/GoogleChrome/web-vitals) library, its
attribution build, and sent as one `$web_vital` event per report. A metric is reported when the
page is hidden, again if its value grew after the visitor came back, after a back/forward-cache
restore, and per soft navigation in browsers that support them. Every report of the same metric
keeps its `$metric_id`, so the latest per id is the value. About 5.5 kB, and only if you import it.

| Property | |
|---|---|
| `$metric` | `LCP`, `INP`, `CLS`, `FCP` or `TTFB` |
| `$value`, `$rating` | Milliseconds (CLS unitless); `good`, `needs-improvement` or `poor` |
| `$metric_id`, `$pageview_id` | The metric instance and the pageview it was measured on |
| `$navigation_type` | `navigate`, `reload`, `back_forward`, `back_forward_cache`, `prerender`, `restore` or `soft_navigation` |
| `$target` | LCP: the element. INP: the element interacted with. CLS: the element of the largest shift. A CSS selector, at most 200 characters |
| LCP | `$time_to_first_byte`, `$resource_load_delay`, `$resource_load_duration`, `$element_render_delay`, in ms |
| INP | `$interaction_type` (`pointer` or `keyboard`), `$input_delay`, `$processing_duration`, `$presentation_delay`, in ms |

## Consent and privacy

```ts
init({ writeKey, optOutByDefault: true });   // nothing leaves until…
optIn();
optOut();
hasOptedOut();
```

Unless cookieless, consent is kept with the ids and is not touched by `reset()`.
Cookieless, `optOut()` is the one thing the SDK writes to localStorage, so the visitor stays opted
out on the next page; `optIn()` removes it again and lasts for the page. With `optOutByDefault`
and no persistence, call `optIn()` on every page load once your own consent record says yes.
`respectDnt: true` honours Do Not Track and Global Privacy Control by never starting.

With a cookie banner, `cookielessMode` decides what happens around the visitor's answer:

```ts
init({ writeKey, cookielessMode: 'on_reject' });
banner.onAccept(() => optIn());
banner.onReject(() => optOut());
```

| `cookielessMode` | Before an answer | After `optIn()` | After `optOut()` |
| --- | --- | --- | --- |
| unset | sends, as `persistence` says (nothing with `optOutByDefault`) | sends | sends nothing |
| `'on_reject'` | sends and stores nothing | stores ids as `persistence` says | removes them, counts cookieless |
| `'always'` | cookieless | cookieless | cookieless |

With `'on_reject'` the page view held back while the visitor decided is sent when they answer, and
the answer is remembered for their next page. `optOutByDefault: true`, or `respectDnt: true` with Do
Not Track on, counts as a no until `optIn()`: cookieless from the first page view, not silent.

To keep your own visits out of the numbers, run this once in the browser's console on your site:

```js
localStorage.vinktar_ignore = 'true'
```

Analytics from that browser are then not sent; errors still are. `localStorage.removeItem('vinktar_ignore')` undoes it.

By default URLs are cut to origin and path, network breadcrumbs carry no query strings, and
ad-network click ids (`gclid`, `fbclid`, …) are masked; `sendDefaultPii: true` keeps them.
Analytics from known automated traffic are dropped: crawlers by user agent, headless browsers,
`navigator.webdriver`, Cypress, PhantomJS and Nightmare. Errors never are.

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
| `requestTimeoutMs` | `10000` | Per request, including compression and reading the response. |
| `shutdownTimeout` | `2000` | How long `close()` may spend on its final delivery. |
| `gzip` | `true` | Compress bodies of 1 KiB and over. |
| `persistence` | `'localStorage+cookie'` | Or `'cookie'`, `'localStorage'`, `'memory'` (cookieless); see [Where the ids are kept](#where-the-ids-are-kept). |
| `persistQueue` | `true` | Keep the queue in localStorage across navigations and crashes. Not with `'cookie'` or `'memory'`. |
| `autoPageviews` | `true` | Or `{ path, search, hash }`. |
| `engagement` | `true` | `$engagement` events: time on page and scroll depth. |
| `autoEvents` | `false` | `link_clicked`, `file_downloaded` and `form_submitted`. |
| `notFound` | | A string or regular expression matched against the title; a match sends `page_not_found`. |
| `autocapture` | `false` | Or `{ clicks, forms }`. |
| `sessionTimeoutMs` / `sessionMaxMs` | 30 min / 24 h | Not with `'memory'`, where the server makes visits. |
| `breadcrumbs` | `true` | Or `{ console, network, navigation, click }`. |
| `maxBreadcrumbs` | `30` | At most 50. |
| `sampleRate` / `errorSampleRate` | `1` | Per device / per issue, deterministic. |
| `maxEventsPerMinute` / `maxErrorsPerMinute` | `600` / `25` | Client-side valves. |
| `dedupe` | `true` | Send an identical error once per five seconds; the repeats are counted. |
| `ignoreErrors` / `denyUrls` / `allowUrls` | `[]` | Strings (substring) or regular expressions. |
| `disableErrorDefaults` | `false` | Turn off the built-in browser-noise list. |
| `superProperties` | `{}` | On every event, under whatever `register()` persisted. |
| `sendDefaultPii` | `false` | Full URLs, query strings and click ids. |
| `redactedKeys` / `propertyDenylist` | `[]` | Extra key fragments to mask; top-level keys to drop. |
| `crossSubdomainCookie` | `false` | Put the cookie on the registrable domain, so subdomains share the visitor. |
| `disablePersistence` | `false` | The same as `persistence: 'memory'`. |
| `useBeacon` | `true` | Use `sendBeacon` on unload when a keepalive request cannot carry the batch. |
| `optOutByDefault` / `respectDnt` / `filterBots` | `false` / `false` / `true` | |
| `propagateIdentity` | `[]` | Not with `'memory'`. Origins that get `X-Vinktar-Device-Id` and `X-Vinktar-Session-Id` on your own requests, so a server SDK stitches its events to this visit. |
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
`data-environment`, `data-debug`, `data-persistence`, `data-auto-pageviews`, `data-engagement`,
`data-auto-events`, `data-not-found`, `data-autocapture`, `data-sample-rate`,
`data-send-default-pii`, `data-cross-subdomain-cookie`, `data-opt-out-by-default`,
`data-respect-dnt`, `data-filter-bots`.

```html
<script src="https://unpkg.com/@vinktarhq/browser/dist/vinktar.min.js" data-key="vnk_pk_…" data-auto-events defer></script>
```

A tag pasted twice, or a tag next to the npm package, starts one client: the second copy warns and
uses the first one's.

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

The three things it is usually one of: the key is a secret key or missing (either way the SDK
logs one error and sends nothing); an ad blocker is blocking the request (the SDK retries three times and then
counts the batch as a send error, which you can see in the project's client reports); or the
page is `localhost`, which reports under the `development` environment. Less often: the tab was
opened in the background and has not been looked at yet (its first pageview waits for that), or
this browser has `localStorage.vinktar_ignore` set.

## How it works

Events are batched and sent as JSON, compressed over 1 KiB, to `/v1/batch`; errors go to
`/v1/errors` immediately. An uncompressed request is CORS-simple (`text/plain`, the key in the
query string), so the first pageview goes out without a preflight. Any `2xx` means the batch was accepted and the SDK forgets it. A `503`
means it was **not** stored and the SDK keeps it, backing off from the server's `Retry-After`.
`429` pauses only the throttled category (a throttled event stream never delays an error); a
monthly cap pauses sending and checks again at most every six hours. `413` halves the batch.
`401`/`403`, or a redirect, stop the SDK for good with one loud line; a redirect is never
followed, because following it would send the write key somewhere else. Everything else backs
off exponentially with jitter, capped at thirty minutes; a request that never got an answer at
all (a blocker, or the host unreachable) gets three attempts, and attempts made while the browser
is offline do not count.

When the page is hidden, which is the last thing a closed tab or a mobile browser sent to the
background reliably reports, what is queued goes out with a beacon, or a keepalive request where
a beacon is refused; `pagehide` sends only what was captured after that, so nothing goes twice.
With the queue in localStorage (the default) it is also persisted per tab and written synchronously
first. A beacon never reports success, so its persisted copy stays, and the next page on the
origin adopts any slot that is over a minute old and sends it; the server deduplicates on the
event id.

```ts
const delivered = await flush();   // true when everything queued was accepted
await close();                     // stop, one bounded last attempt, the same answer every call
```

`flush()` resolves `true` only when every event and error queued at the call was accepted. A batch
waiting out a rate limit, retrying after a failure, or refused by the server resolves `false`; the
SDK keeps retrying on its own, and you can call it again. `close()` stops accepting events at once
and makes one last attempt, bounded by `shutdownTimeout`. Neither ever throws, and a `false` is
about telemetry, not about your application: never retry your own work because of it.

Every request carries at most three headers (`Content-Type`, `Content-Encoding` and
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
