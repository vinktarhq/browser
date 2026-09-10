import type { Props } from '../core/normalize.js';
import { describeElement, eventTarget, stripUrl } from './crumbs.js';
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
        if (element.id) props['$element_id'] = element.id;
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
          $form_method: (form.getAttribute('method') ?? 'get').toLowerCase(),
        };
        if (form.name) props['$form_name'] = form.name;
        if (form.id) props['$form_id'] = form.id;
        const action = form.getAttribute('action');
        if (action) props['$form_action'] = stripUrl(new URL(action, natives.window?.location.href).href, options.sendDefaultPii);
        options.track('$autocapture', props);
      },
      { capture: true, passive: true },
    );
  }
}
