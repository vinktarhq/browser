import type { Props } from '../core/normalize.js';
import { attribute, describeElement, eventTarget, resolveUrl, stripUrl } from './crumbs.js';
import type { Instrumentation } from './instrument.js';
import { natives } from './natives.js';

/**
 * `$autocapture` events for clicks and form submissions.
 *
 * Element identity only: tag, id, classes, `href`, form name and action. Never the text inside an
 * element and never a field's value, both of which are how autocapture products end up storing
 * passwords and card numbers by accident. Listeners run in the capture phase and are passive, so
 * a page that stops propagation or calls `preventDefault` still counts, and scrolling is never
 * blocked on analytics.
 */
export interface AutocaptureOptions {
  readonly clicks: boolean;
  readonly forms: boolean;
  readonly sendDefaultPii: boolean;
  readonly track: (name: string, properties: Props) => void;
}

const INTERACTIVE = 'a,button,input[type="button"],input[type="submit"],input[type="reset"],[role="button"],[role="link"],summary,select,label';

export function installAutocapture(instrumentation: Instrumentation, options: AutocaptureOptions): void {
  const doc = natives.document;
  if (doc === undefined) return;

  if (options.clicks) {
    instrumentation.listen(
      doc,
      'click',
      (event) => {
        const target = eventTarget(event);
        if (target === null) return;
        const element = target.closest(INTERACTIVE) ?? target;
        const props: Props = {
          $event_type: 'click',
          $element: element.tagName.toLowerCase(),
          $selector: describeElement(element),
        };
        const id = attribute(element, 'id');
        if (id) props['$element_id'] = id;
        const href = element instanceof HTMLAnchorElement ? element.href : null;
        if (href) props['$href'] = stripUrl(href, options.sendDefaultPii);
        options.track('$autocapture', props);
      },
      { capture: true, passive: true },
    );
  }

  if (options.forms) {
    instrumentation.listen(
      doc,
      'submit',
      (event) => {
        const form = event.target;
        if (!(form instanceof HTMLFormElement)) return;
        const props: Props = {
          $event_type: 'submit',
          $element: 'form',
          $selector: describeElement(form),
          $form_method: (attribute(form, 'method') ?? 'get').toLowerCase(),
        };
        // Attributes, not properties: a control named `name`, `id` or `action` shadows the property.
        const name = attribute(form, 'name');
        if (name) props['$form_name'] = name;
        const id = attribute(form, 'id');
        if (id) props['$form_id'] = id;
        const action = attribute(form, 'action');
        // An action that is not a URL is recorded as written.
        if (action) props['$form_action'] = stripUrl(resolveUrl(action), options.sendDefaultPii);
        options.track('$autocapture', props);
      },
      { capture: true, passive: true },
    );
  }
}

/**
 * Events from markup and links, through one delegated capture-phase listener per event type, so
 * links a framework renders later count, and a handler that stops propagation does not hide one.
 * Nothing here delays or cancels a navigation.
 *
 * Always on: `data-vinktar-event="name"` fires `name` on click, or on submit for a form, with each
 * `data-vinktar-prop-<key>="value"` as a property. With `auto`: `link_clicked` for outbound,
 * `mailto:` and `tel:` links, `file_downloaded` for a link to a file, `form_submitted` for any
 * other form. Never link text, an address or a field value unless PII is allowed.
 */
export interface DomEventOptions {
  readonly auto: boolean;
  readonly sendDefaultPii: boolean;
  readonly track: (name: string, properties: Props) => void;
}

const DOWNLOAD = /\.(pdf|csv|docx?|xlsx?|pptx?|zip|rar|7z|dmg|exe|msi|apk|mp3|mp4|mov|txt|json|xml|key|numbers|pages)$/i;
const TAG = 'data-vinktar-event';
const PROP = 'data-vinktar-prop-';

export function installDomEvents(instrumentation: Instrumentation, options: DomEventOptions): void {
  const doc = natives.document;
  if (doc === undefined) return;

  const onClick = (event: Event): void => {
    // `auxclick` is any button but the primary; only the middle one opens a link.
    if (event.type === 'auxclick' && (event as MouseEvent).button !== 1) return;
    const target = eventTarget(event);
    if (target === null) return;
    const tagged = target.closest(`[${TAG}]`);
    // A tagged form counts on submit, not for every click inside it.
    if (tagged !== null && !(tagged instanceof HTMLFormElement)) return declared(tagged, options);
    if (!options.auto) return;
    // `instanceof` also skips an `<a>` inside SVG, whose `href` is not a string.
    const link = target.closest('a[href]');
    if (link instanceof HTMLAnchorElement) linkEvent(link, options);
  };
  instrumentation.listen(doc, 'click', onClick, { capture: true, passive: true });
  instrumentation.listen(doc, 'auxclick', onClick, { capture: true, passive: true });

  instrumentation.listen(
    doc,
    'submit',
    (event) => {
      const form = event.target;
      if (!(form instanceof HTMLFormElement)) return;
      if (attribute(form, TAG) !== null) return declared(form, options);
      if (!options.auto) return;
      const props: Props = {};
      // Attributes, not properties: a control named `id` or `action` shadows the property.
      const id = attribute(form, 'id');
      if (id) props['form_id'] = id;
      const name = attribute(form, 'name');
      if (name) props['form_name'] = name;
      const action = attribute(form, 'action');
      if (action) props['form_action'] = pathOf(resolveUrl(action));
      options.track('form_submitted', props);
    },
    { capture: true, passive: true },
  );
}

function declared(element: Element, options: DomEventOptions): void {
  const name = (attribute(element, TAG) ?? '').trim();
  if (name === '') return;
  const props: Props = {};
  for (const { name: attr, value } of Array.from(element.attributes)) {
    if (attr.startsWith(PROP) && attr.length > PROP.length) props[attr.slice(PROP.length).replace(/-/g, '_')] = value;
  }
  options.track(name, props);
}

function linkEvent(link: HTMLAnchorElement, options: DomEventOptions): void {
  let url: URL;
  try {
    url = new URL(link.href);
  } catch {
    return;
  }
  const pii = options.sendDefaultPii ? { url: url.href } : {};
  if (url.protocol === 'mailto:') {
    options.track('link_clicked', { kind: 'mailto', host: (url.pathname.split('@')[1] ?? '').split(',')[0]!.toLowerCase(), ...pii });
  } else if (url.protocol === 'tel:') {
    options.track('link_clicked', { kind: 'tel', ...pii });
  } else if (url.protocol === 'http:' || url.protocol === 'https:') {
    // The pathname, so neither a query nor `#page=2` hides the extension.
    const file = DOWNLOAD.exec(url.pathname);
    if (file !== null) options.track('file_downloaded', { url: stripUrl(url.href, options.sendDefaultPii), extension: file[1]!.toLowerCase() });
    else if (url.host !== natives.window?.location.host) options.track('link_clicked', { kind: 'outbound', url: stripUrl(url.href, options.sendDefaultPii), host: url.hostname });
  }
}

function pathOf(href: string): string {
  try {
    return new URL(href).pathname;
  } catch {
    return href.split(/[?#]/)[0] ?? href;
  }
}
