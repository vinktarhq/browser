import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { VERSION } from '../src/version.js';

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as Record<string, unknown>;

describe('package.json', () => {
  it('agrees with the version constant', () => {
    expect(VERSION).toBe(manifest['version']);
  });

  it('has zero runtime dependencies', () => {
    expect(manifest['dependencies']).toBeUndefined();
    expect(manifest['peerDependencies']).toBeUndefined();
  });

  it('is licensed in the manifest as well as the file', () => {
    expect(manifest['license']).toBe('MIT');
    expect(readFileSync(new URL('../LICENSE', import.meta.url), 'utf8')).toContain('MIT License');
  });

  it('ships only the built output and the docs', () => {
    expect(manifest['files']).toEqual(['dist', 'README.md', 'CHANGELOG.md', 'LICENSE']);
    expect(manifest['sideEffects']).toBe(false);
  });
});
