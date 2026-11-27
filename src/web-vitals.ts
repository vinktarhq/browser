import { onCLS, onFCP, onINP, onLCP, onTTFB, type MetricWithAttribution } from 'web-vitals/attribution';

import type { Integration, IntegrationHost, Props } from './types.js';

/**
 * Core Web Vitals as `$web_vital` events: LCP, INP, CLS, FCP and TTFB, measured by Google's
 * `web-vitals` library with attribution, so a slow LCP or INP says which element and which part
 * of the time.
 *
 * One event per report. The library reports when the page is hidden, again after a return if a
 * value grew, after a back/forward-cache restore, and per soft navigation where the browser
 * supports them. Every report of the same metric instance carries the same `$metric_id`, so the
 * latest one per id is the value.
 *
 *     import { init } from '@vinktarhq/browser';
 *     import { webVitals } from '@vinktarhq/browser/web-vitals';
 *     init({ writeKey, integrations: [webVitals()] });
 */
const MAX_SELECTOR = 200;

export function webVitals(): Integration {
  return {
    name: 'web-vitals',
    setup(host: IntegrationHost) {
      if (typeof document === 'undefined') return;
      // The library cannot unsubscribe; a torn-down client just stops listening.
      let live = true;
      const report = (metric: MetricWithAttribution): void => {
        if (live) host.track('$web_vital', describe(metric, host.pageviewId(metric.navigationURL)));
      };
      const options = { reportSoftNavs: true };
      onLCP(report, options);
      onINP(report, options);
      onCLS(report, options);
      onFCP(report, options);
      onTTFB(report, options);

      return () => {
        live = false;
      };
    },
  };
}

function describe(metric: MetricWithAttribution, pageviewId: string | undefined): Props {
  const props: Props = {
    $metric: metric.name,
    $value: Math.round(metric.value * 1000) / 1000,
    $rating: metric.rating,
    $metric_id: metric.id,
    $navigation_type: metric.navigationType.replace(/-/g, '_'),
  };
  if (pageviewId !== undefined) props['$pageview_id'] = pageviewId;
  const set = (key: string, value: string | number | undefined): void => {
    if (typeof value === 'number') props[key] = Math.round(value);
    else if (typeof value === 'string' && value !== '') props[key] = value.slice(0, MAX_SELECTOR);
  };
  if (metric.name === 'LCP') {
    const a = metric.attribution;
    set('$target', a.target);
    set('$time_to_first_byte', a.timeToFirstByte);
    set('$resource_load_delay', a.resourceLoadDelay);
    set('$resource_load_duration', a.resourceLoadDuration);
    set('$element_render_delay', a.elementRenderDelay);
  } else if (metric.name === 'INP') {
    const a = metric.attribution;
    set('$target', a.interactionTarget);
    set('$interaction_type', a.interactionType);
    set('$input_delay', a.inputDelay);
    set('$processing_duration', a.processingDuration);
    set('$presentation_delay', a.presentationDelay);
  } else if (metric.name === 'CLS') {
    set('$target', metric.attribution.largestShiftTarget);
  }

  return props;
}
