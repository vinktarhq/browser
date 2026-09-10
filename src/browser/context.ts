import { truncateToBytes } from '../core/bytes.js';
import type { Props } from '../core/normalize.js';
import { parseJson } from '../core/normalize.js';
import { LIB, VERSION } from '../version.js';
import { natives } from './natives.js';
import type { Store } from './storage.js';

/**
 * What every event carries about the page, and what the first visit carried.
 *
 * The keys the server promotes to columns (`$current_url`, `$referrer`, `utm_*`, `$lib`,
 * `$release`, `$environment`) are spelled exactly as the contract lists them; the rest ride as
 * free JSON on the event.
 *
 * URLs are stripped to origin and path unless `sendDefaultPii` is on: query strings carry
 * tokens, emails and search terms, and ad-network click ids are personal data by most readings of
 * the regulations that govern them. The campaign parameters that describe *where* a visitor came
 * from are kept regardless.
 */
export const CAMPAIGN_PARAMS: readonly string[] = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'];

/** Ad-network click ids: identifying, and masked out of URLs unless PII is allowed. */
export const CLICK_IDS: readonly string[] = [
  'gclid', 'gclsrc', 'dclid', 'gbraid', 'wbraid', 'fbclid', 'msclkid', 'twclid', 'li_fat_id', 'igshid', 'ttclid',
  'rdt_cid', 'epik', 'qclid', 'sccid', 'irclid', '_kx',
];

export const DIRECT = '$direct';

export interface ContextOptions {
  readonly sendDefaultPii: boolean;
  readonly release: string;
  readonly environment: string;
}

export function currentUrl(sendDefaultPii: boolean): string {
  const loc = natives.window?.location;
  if (loc === undefined) return '';
  if (!sendDefaultPii) return `${loc.origin}${loc.pathname}`;

  return maskClickIds(loc.href);
}

/** The full URL with click ids replaced, so a shared link is not a shared identity. */
export function maskClickIds(href: string): string {
  try {
    const url = new URL(href);
    let changed = false;
    for (const id of CLICK_IDS) {
      if (url.searchParams.has(id)) {
        url.searchParams.set(id, '<masked>');
        changed = true;
      }
    }

    return changed ? url.toString() : href;
  } catch {
    return href;
  }
}

export function referrer(): { referrer: string; domain: string } {
  const ref = natives.document?.referrer ?? '';
  if (ref === '') return { referrer: DIRECT, domain: DIRECT };
  try {
    return { referrer: ref, domain: new URL(ref).hostname };
  } catch {
    return { referrer: ref, domain: DIRECT };
  }
}

export function campaign(): Props {
  const search = natives.window?.location.search ?? '';
  if (search === '') return {};
  const out: Props = {};
  try {
    const params = new URLSearchParams(search);
    for (const key of CAMPAIGN_PARAMS) {
      const value = params.get(key);
      if (value !== null && value !== '') out[key] = truncateToBytes(value, 255);
    }
  } catch {
    // A malformed query string carries no campaign.
  }

  return out;
}

/** Everything the page can say about itself, per event. */
export function pageContext(options: ContextOptions): Props {
  const win = natives.window;
  const doc = natives.document;
  const ref = referrer();
  const out: Props = {
    $current_url: currentUrl(options.sendDefaultPii),
    $referrer: ref.referrer,
    $referring_domain: ref.domain,
    ...campaign(),
    $lib: LIB,
    $lib_version: VERSION,
    $environment: options.environment,
  };
  if (options.release !== '') out['$release'] = options.release;
  if (doc?.title) out['page_title'] = truncateToBytes(doc.title, 255);
  if (win !== undefined) {
    const screen = win.screen;
    if (screen?.width) {
      out['$screen_width'] = screen.width;
      out['$screen_height'] = screen.height;
    }
    if (win.innerWidth) {
      out['$viewport_width'] = win.innerWidth;
      out['$viewport_height'] = win.innerHeight;
    }
  }
  const nav = natives.navigator;
  if (nav?.language) out['$browser_language'] = nav.language;
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tz) out['$timezone'] = tz;
  } catch {
    // Some embedded runtimes have no Intl.
  }

  return out;
}

/**
 * The first visit's referrer and campaign, kept for the life of the device and merged in as
 * `$initial_*` super properties. Stored compactly: the same blob is read on every load.
 */
export function initialAttribution(store: Store, key: string, sendDefaultPii: boolean): Props {
  const stored = parseJson(store.get(key)) as Props | undefined;
  if (typeof stored === 'object' && stored !== null) return stored;

  const ref = referrer();
  const attribution: Props = {
    $initial_referrer: ref.referrer,
    $initial_referring_domain: ref.domain,
    $initial_url: currentUrl(sendDefaultPii),
  };
  for (const [name, value] of Object.entries(campaign())) attribution[`$initial_${name}`] = value;
  store.set(key, JSON.stringify(attribution));

  return attribution;
}

const BOT_UA =
  /bot|crawl|spider|slurp|headless|phantom|selenium|puppeteer|playwright|lighthouse|pingdom|gtmetrix|prerender|facebookexternalhit|ahrefs|semrush|bingpreview|yandex|duckduckbot|applebot|petalbot|bytespider|dataprovider|screaming frog|chrome-lighthouse|wappalyzer|hubspot|uptime|monitor/i;

/**
 * Automated traffic, from three signals: the user agent string, the client-hint brands (which a
 * headless browser fills in honestly), and `navigator.webdriver`. No devtools sniffing: it
 * false-positives on every developer with the console open.
 */
export function isLikelyBot(): boolean {
  const nav = natives.navigator as (Navigator & { userAgentData?: { brands?: Array<{ brand: string }> } }) | undefined;
  if (nav === undefined) return false;
  if (nav.webdriver === true) return true;
  if (BOT_UA.test(nav.userAgent ?? '')) return true;
  try {
    for (const { brand } of nav.userAgentData?.brands ?? []) {
      if (BOT_UA.test(brand)) return true;
    }
  } catch {
    // Client hints are optional and occasionally throw in older builds.
  }

  return false;
}
