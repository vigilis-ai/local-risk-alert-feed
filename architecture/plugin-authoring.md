# Authoring & Certifying a Plugin

**Version:** 1.0.0
**Last Updated:** July 2026
**Status:** Active

How to build a plugin for the federated model and prove it conforms — for
first-party plugins and third parties alike. The two public surfaces you build
against are the versioned **wire contract** (`@vigilisai/local-risk-alert-feed/contract`)
and the **conformance suite** (`@vigilisai/local-risk-alert-feed/testing` + the
`vigilis-plugin-verify` CLI).

A plugin is "valid" iff it passes the conformance suite.

---

## 1. What a plugin is

A plugin is an HTTP service exposing two routes off a base endpoint:

- `GET  {endpoint}/plugins/{id}/manifest` → the plugin's metadata (coverage,
  categories, temporal characteristics, contract version).
- `POST {endpoint}/plugins/{id}/alerts` → takes a query
  (`PluginFetchOptions`), returns `{ alerts: Alert[] }`.

Both are authenticated with a per-request **bearer token + HMAC-SHA256
signature** (see §4). The host owns caching, retries, timeouts, and
aggregation — your endpoint is a stateless call-out that turns a query into
alerts.

Multiple plugins may share one deployment; an endpoint is a route, not a
service. `createPluginServiceHandler([...plugins])` hosts many plugins behind
one Lambda, each on its own `/plugins/{id}/…` route.

---

## 2. Two ways to build

### A. TypeScript, with the SDK (easiest for first-party)

Extend `BasePlugin` (or implement `AlertPlugin`), then mount it behind the
service handler:

```ts
import { BasePlugin } from '@vigilisai/local-risk-alert-feed';
import { createPluginServiceHandler } from '@vigilisai/local-risk-alert-feed/adapters/plugin-service';
import { EnvCredentialResolver } from '@vigilisai/local-risk-alert-feed/federation';

class MyPlugin extends BasePlugin { /* metadata + fetchAlerts */ }

export const handler = createPluginServiceHandler({
  plugins: [new MyPlugin()],
  credentials: new EnvCredentialResolver(),
});
```

### B. Any language, against the raw contract

Implement the two routes in your stack of choice. Validate your manifest and
alert payloads against the published JSON shapes (mirrored by the Zod schemas in
`.../contract`). You do not need to use our SDK — only speak the wire contract.

---

## 3. The contract shapes

Import the schemas to validate during development:

```ts
import {
  PluginManifestSchema,     // GET /manifest response
  PluginFetchOptionsSchema, // POST /alerts request body
  PluginFetchResultSchema,  // POST /alerts response
  CONTRACT_VERSION,
} from '@vigilisai/local-risk-alert-feed/contract';
```

- The manifest advertises `contractVersion` and the plugin `metadata`. URLs are
  unversioned; the version travels in the manifest.
- The host resolves `timeRange` to an explicit `{ start, end }` before calling
  you, and it uses your manifest metadata (coverage/category/temporal) to decide
  whether to call you at all — so keep the manifest honest.

---

## 4. Auth your endpoint must enforce

Every request carries:

- `Authorization: Bearer <token>` — the token you issued to the host.
- `X-Vigilis-Signature: t=<ms>,v1=<hex>` — HMAC-SHA256 over
  `timestamp . METHOD . /plugins/{id}/{action} . body`, keyed by the shared
  signing secret.

Your endpoint must **reject** (401/403): a missing/invalid bearer, a bad
signature, and a stale timestamp (replay). If you use `createPluginServiceHandler`
this is handled for you; if you implement the routes yourself, verify all three
(the SDK's `verifyRequest` helper does exactly this and is reusable server-side).

---

## 5. Certify with the conformance suite

### CLI (any endpoint, any language)

```bash
npx vigilis-plugin-verify \
  --endpoint https://plugins.example.com \
  --plugin-id my-plugin \
  --token "$PLUGIN_TOKEN" \
  --signing-secret "$PLUGIN_SIGNING_SECRET" \
  [--lat 33.45 --lng -112.02 --radius 5000] [--no-auth] [--json]
```

Exits `0` on pass, `1` on failure — drop it into CI. It drives `/manifest` and
`/alerts` over the wire and probes auth enforcement.

### Programmatic (TS)

```ts
import { runConformanceSuite, formatReport } from '@vigilisai/local-risk-alert-feed/testing';

// endpoint mode
const report = await runConformanceSuite({
  endpoint: 'https://plugins.example.com',
  pluginId: 'my-plugin',
  credentials: { token, signingSecret },
});

// or SDK-object mode (no HTTP)
const report2 = await runConformanceSuite({ plugin: new MyPlugin() });

console.log(formatReport(report));
if (!report.passed) process.exit(1);
```

The suite returns a structured `ConformanceReport` (`{ passed, checks[] }`),
so it backs a CLI, CI gate, or a vitest/jest wrapper without depending on any
test runner.

### What it checks

- **Manifest** — reachable, schema-valid, `contractVersion` present, id matches,
  non-empty categories/temporal types, coverage coherent (regional ⇒
  center+radius), temporal coherent (advisory warnings for missing data-lag /
  lookahead).
- **coversLocation** — true inside the declared coverage, false far outside
  (regional).
- **fetchAlerts** — schema-valid `PluginFetchResult`; every alert passes the
  `Alert` schema; `category ⊆ supportedCategories`; alerts roughly within the
  requested radius (warning); `limit` respected (warning).
- **Auth (endpoint mode)** — the endpoint rejects missing bearer, bad signature,
  and stale timestamp.

`error`-severity checks fail certification; `warning`-severity checks are
advisory and do not fail the run.
