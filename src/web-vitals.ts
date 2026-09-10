import type { Integration, IntegrationHost } from './types.js';

/**
 * Core Web Vitals as `$web_vital` events: LCP, CLS, INP, FCP and TTFB.
 *
 * Measured with `PerformanceObserver` and reported once, when the page is hidden, with the final
 * value: LCP and CLS keep changing while the page is visible, and reporting them early reports
 * the wrong number. No polyfills and no bfcache-restore re-measurement; the metrics are the
 * browser's own, and a browser without the observer types simply reports nothing.
 *
 *     import { init } from '@vinktarhq/browser';
 *     import { webVitals } from '@vinktarhq/browser/web-vitals';
 *     init({ writeKey, integrations: [webVitals()] });
 */
type Metric = 'LCP' | 'CLS' | 'INP' | 'FCP' | 'TTFB';

const THRESHOLDS: Record<Metric, [good: number, poor: number]> = {
  LCP: [2500, 4000],
  CLS: [0.1, 0.25],
  INP: [200, 500],
  FCP: [1800, 3000],
  TTFB: [800, 1800],
};

function rating(metric: Metric, value: number): 'good' | 'needs-improvement' | 'poor' {
  const [good, poor] = THRESHOLDS[metric];

  return value <= good ? 'good' : value <= poor ? 'needs-improvement' : 'poor';
}

export function webVitals(): Integration {
  return {
    name: 'web-vitals',
    setup(host: IntegrationHost) {
      if (typeof PerformanceObserver === 'undefined' || typeof document === 'undefined') return;
      const values = new Map<Metric, number>();
      const reported = new Set<Metric>();
      const observers: PerformanceObserver[] = [];
      const interactions = new Map<number, number>();
      let cls = 0;

      const observe = (type: string, callback: (entries: PerformanceEntryList) => void): void => {
        try {
          if (!PerformanceObserver.supportedEntryTypes?.includes(type)) return;
          const observer = new PerformanceObserver((list) => callback(list.getEntries()));
          observer.observe({ type, buffered: true });
          observers.push(observer);
        } catch {
          // An unsupported entry type on this browser.
        }
      };

      observe('largest-contentful-paint', (entries) => {
        const last = entries[entries.length - 1];
        if (last !== undefined) values.set('LCP', last.startTime);
      });
      observe('layout-shift', (entries) => {
        for (const entry of entries as Array<PerformanceEntry & { hadRecentInput?: boolean; value?: number }>) {
          if (!entry.hadRecentInput) cls += entry.value ?? 0;
        }
        values.set('CLS', Math.round(cls * 1000) / 1000);
      });
      observe('paint', (entries) => {
        for (const entry of entries) if (entry.name === 'first-contentful-paint') values.set('FCP', entry.startTime);
      });
      observe('event', (entries) => {
        for (const entry of entries as Array<PerformanceEntry & { interactionId?: number }>) {
          if (!entry.interactionId) continue;
          interactions.set(entry.interactionId, Math.max(interactions.get(entry.interactionId) ?? 0, entry.duration));
        }
        // INP is the 98th percentile of interactions, approximated as the worst for few and the
        // 50th-worst-per-50 for many, which is what the reference implementation does.
        const sorted = [...interactions.values()].sort((a, b) => b - a);
        const index = Math.min(sorted.length - 1, Math.floor(sorted.length / 50));
        const inp = sorted[index];
        if (inp !== undefined) values.set('INP', inp);
      });
      try {
        const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
        if (nav !== undefined && nav.responseStart > 0) values.set('TTFB', nav.responseStart);
      } catch {
        // No navigation timing here.
      }

      const report = (): void => {
        for (const [metric, value] of values) {
          if (reported.has(metric)) continue;
          reported.add(metric);
          host.track('$web_vital', { $metric: metric, $value: Math.round(value * 1000) / 1000, $rating: rating(metric, value) });
        }
      };
      const onHide = (): void => {
        if (document.visibilityState === 'hidden') report();
      };
      document.addEventListener('visibilitychange', onHide);
      window.addEventListener('pagehide', report);

      return () => {
        document.removeEventListener('visibilitychange', onHide);
        window.removeEventListener('pagehide', report);
        for (const observer of observers) observer.disconnect();
      };
    },
  };
}
