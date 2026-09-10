// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';

import * as facade from '../src/index.js';
import { Vinktar } from '../src/client.js';

/**
 * The public surface, spelled out. A method added, renamed or removed fails here until this list
 * and the README agree with it, so the documented API and the shipped one cannot drift apart.
 */
const FACADE = [
  'addBreadcrumb',
  'captureException',
  'captureMessage',
  'close',
  'flush',
  'getClient',
  'getDeviceId',
  'getSessionId',
  'getUserId',
  'hasOptedOut',
  'identify',
  'init',
  'optIn',
  'optOut',
  'page',
  'register',
  'registerOnce',
  'reset',
  'scope',
  'setContext',
  'setTag',
  'setTags',
  'setTraits',
  'setTraitsOnce',
  'setUser',
  'track',
  'unregister',
  'unsetTraits',
  'withScope',
];

const CLIENT = FACADE.filter((name) => !['init', 'getClient'].includes(name));

describe('the public API surface', () => {
  it('exports exactly the documented functions', () => {
    const exported = Object.keys(facade)
      .filter((key) => typeof (facade as Record<string, unknown>)[key] === 'function')
      .filter((key) => key !== 'Vinktar')
      .sort();

    expect(exported).toEqual(FACADE);
  });

  it('carries every documented method on the class too', () => {
    const methods = new Set(Object.getOwnPropertyNames(Vinktar.prototype));
    for (const name of CLIENT) expect(methods.has(name), `Vinktar#${name}`).toBe(true);
  });

  it('spells teardown close()', () => {
    expect('destroy' in facade).toBe(false);
    expect('shutdown' in facade).toBe(false);
  });

  it('takes identify options by name, so the fourth argument cannot mean two things', () => {
    expect(facade.identify.length).toBe(4);
  });
});
