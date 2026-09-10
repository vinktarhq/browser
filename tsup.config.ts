import { defineConfig } from 'tsup';

/**
 * Three artefacts from one source tree:
 *
 *   - ESM + CJS for npm, with declarations, so both `import` and `require` land on typed code.
 *   - One minified IIFE for a `<script>` tag or a CDN, which cannot tree-shake and so ships
 *     everything the tag needs and nothing else.
 *
 * Source maps go out for all three. `scripts/postbuild.mjs` marks them as SDK code (so a
 * customer's devtools skip these frames) and strips embedded sources, which nobody needs to read
 * from a map and which would otherwise double the tarball.
 */
export default defineConfig([
  {
    entry: { index: 'src/index.ts', 'web-vitals': 'src/web-vitals.ts' },
    format: ['esm', 'cjs'],
    dts: true,
    sourcemap: true,
    target: 'es2020',
    platform: 'browser',
    clean: true,
    treeshake: true,
    splitting: false,
  },
  {
    entry: { vinktar: 'src/global.ts' },
    format: ['iife'],
    globalName: 'vinktarBundle',
    outExtension: () => ({ js: '.min.js' }),
    minify: true,
    sourcemap: true,
    target: 'es2020',
    platform: 'browser',
  },
]);
