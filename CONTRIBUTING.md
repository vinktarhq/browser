# Contributing

Thanks for looking. Bug reports with the browser, its version, and the console lines the SDK
printed (it prints one for everything it refuses to do) are worth a great deal.

## Getting set up

```bash
npm install
npm run typecheck
npm test
```

`npm test` is the fast suite: the core under Node, and the client under a simulated DOM with an
in-process stand-in for ingest that records what the SDK sends. It should take a few seconds.

```bash
npx playwright install
npm run test:e2e
```

That one drives the built bundle through real Chromium, Firefox and WebKit. It is separate
because it needs the browsers installed and takes a minute where the unit suite takes seconds.

## What the tests are for

`spec/` is the wire contract the server enforces, and `test/spec.test.ts` runs every fixture in
it: limits, blocked ids, the response state machine, trait parsing, stack parsing per engine, and
deterministic sampling. A number that drifts from the published one fails the build rather than
a customer's request.

`test/api-surface.test.ts` lists the public functions by name. Adding, renaming or removing one
fails until the list and the README agree with it.

There is also a CI job that packs the tarball, installs it somewhere else and imports it both
ways. `npm test` imports from `src/`, so it can pass while the published package is unusable.

## House style

- **Zero runtime dependencies.** A test asserts it. Every dependency is bytes on someone's page.
- **Nothing fails silently.** Every drop, refusal and no-op is a warning that names the
  consequence, printed once and rate limited.
- **Never throw into the application.** Every public method and every handler is wrapped.
- Comments explain *why*, not *what*, and are worth writing where a rule looks arbitrary. Most of
  them here record a failure that a simplification would reintroduce.

## Releasing

Maintainers only. Publishing runs from CI and there is no npm token anywhere: the registry trusts
this repository and this workflow file directly, over the OIDC handshake that also signs the
provenance attestation.

1. Bump `version` in `package.json` and `src/version.ts`, and move the changelog heading.
2. Create a GitHub release tagged `v<version>`.

The workflow refuses to run if the tag disagrees with `package.json`, builds, tests, checks the
size budget, publishes, and then installs the published version from the registry to prove it.
