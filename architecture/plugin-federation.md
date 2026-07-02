# Plugin Federation — Runtime-Extensible, Out-of-Process Plugins

**Version:** 0.1.0 (proposal)
**Last Updated:** July 2026
**Status:** Design — not yet implemented

## Purpose

Let third parties (and ourselves) publish alert plugins as **web-service
endpoints** that our framework discovers and calls at **runtime**, with **no
rebuild or republish** of `@vigilisai/local-risk-alert-feed`.

The governing principle: **everything is a remote endpoint, including our own
plugins.** There is exactly one execution model to build, secure, and monitor.
Our first-party plugins become the reference implementation of the same public
contract a third party implements. A plugin is a stateless call-out; **caching,
storage, retries, timeouts, aggregation, and telemetry stay in the host** — the
endpoint is just a function that turns a query into `Alert[]`.

### Non-goals / firm decisions

- **No in-process execution of third-party code.** Ever. No dynamic `import()`,
  no in-process sandbox. Cross-customer isolation and blast-radius containment
  come from the process/network boundary, not from a language sandbox.
- **No "vendor the source, build, link, publish" path.** That is the thing we
  are replacing.
- Third parties may implement the contract in **any language**; the SDK is a
  convenience, not a requirement.

---

## 1. What the library becomes

The library splits into two artifacts that share **one wire contract**.

### 1a. Host / orchestrator (runs in the customer-facing Lambda)

`AlertFeed`, `PluginRegistry`, `PluginResolver`, `AlertAggregator`, the cache
layer, telemetry — **unchanged in shape** — plus two new pieces:

- **`RemotePlugin`** — an `AlertPlugin` implementation that is an HTTP client to
  a plugin endpoint.
- **Auth client** — pluggable request-authentication strategies.

Because `RemotePlugin` *is* an `AlertPlugin`, the entire
`resolve → fetch → aggregate` pipeline is unchanged. A remote plugin is
indistinguishable from a local one to everything downstream, and local + remote
plugins can run **side by side** during migration.

### 1b. Plugin SDK / server (used by us and third parties)

- `BasePlugin`'s `fetchJson` / `fetchCsv` / `fetchXml` / cache / retry helpers —
  these move to the **server** side, behind the endpoint.
- **`createPluginServiceHandler(plugin)`** — mirror of today's
  `createLambdaHandler`, but it exposes a plugin's `AlertPlugin` implementation
  as the `/manifest` + `/alerts` HTTP contract, with auth-verify middleware.

```
                          ┌─────────────────────────────────────────┐
   customer request  ───► │  Host Lambda (@vigilisai/...-alert-feed)  │
                          │                                           │
                          │  AlertFeed → Resolver → RemotePlugin(s)   │
                          │        │          │            │          │
                          │   AlertAggregator │       Auth client     │
                          │   Cache / telemetry (host-owned)          │
                          └───────────────────┼───────────┼──────────┘
                                              │ GET  {endpoint}/manifest (cached, control plane)
                                              │ POST {endpoint}/alerts   (data plane, on miss)
                    ┌─────────────────────────┼───────────────────────┐
                    ▼                         ▼                        ▼
          ┌──────────────────┐    ┌──────────────────┐    ┌────────────────────┐
          │ First-party      │    │ First-party      │    │ 3rd-party endpoint  │
          │ NYC-crime Lambda │    │ NWS-weather λ    │    │ (their infra, any   │
          │ (SDK handler)    │    │ (SDK handler)    │    │  language)          │
          └──────────────────┘    └──────────────────┘    └────────────────────┘
```

### 1c. Deployment packaging — many plugins, one module, separate endpoints

**An endpoint is a route, not a deployment.** A plugin's "endpoint" is a
`{base}/plugins/{id}` prefix; the deployment that serves it is an independent
decision. In practice most/all first-party plugins ship in **one serverless
module** (one Lambda, one deploy) that hosts many plugins, each on its own route:

```
https://plugins.vigilis.io/plugins/nws-weather/manifest
https://plugins.vigilis.io/plugins/nws-weather/alerts
https://plugins.vigilis.io/plugins/nyc-crime/manifest
https://plugins.vigilis.io/plugins/nyc-crime/alerts
https://plugins.vigilis.io/plugins/mta-alerts/manifest      ← all one Lambda
...
```

`createPluginServiceHandler([...plugins])` (§6, Phase 2) is the single handler
that owns this routing + per-plugin auth verification. The host doesn't know or
care whether two plugin `endpoint`s resolve to the same Lambda or different
ones — it only sees `{ id, endpoint }` rows.

**Re-segmenting is a config change, not a code change.** Because the host
addresses plugins by `endpoint` URL, moving a plugin between deployments is just
updating its `endpoint` row. That lets us split by change cadence or blast
radius whenever we want, and revisit it freely as the plugin set grows:

- **One shared module** — simplest, one deploy, fine to start.
- **By change cadence** — stable/rarely-touched plugins in one module, fast-
  moving ones in another, so a hot plugin's redeploy can't destabilize the
  quiet ones.
- **Isolation-sensitive** — a heavy or flaky plugin gets its own module (and its
  own memory/timeout/concurrency) without disturbing the rest.

Assume this topology **will** change over time. The design keeps that a
reconfiguration: same code, same routes, different `endpoint` values.

---

## 2. The wire contract (this is the product)

Two routes off the registered endpoint. The important design decision is the
**control-plane / data-plane split**, which is what keeps federation cheap.
**URLs are unversioned** — we target `{endpoint}/manifest` and
`{endpoint}/alerts` directly. Versioning is carried out-of-band (see below), so
we're free to either maintain compatibility or relocate the version later
without churning URLs.

### `GET {endpoint}/manifest` — control plane

Returns the plugin's `PluginMetadata` (coverage, `supportedCategories`,
`temporal`, contract version, refresh hints). The host fetches this **once at
registration**, validates it, and **caches it with a TTL**. The `PluginResolver`
does all geo / category / temporal filtering against the **cached** manifest.

Consequence: we never fan out to N endpoints per query just to discover who's
relevant. We already know from cached manifests, and only call the ones that
matter.

### `POST {endpoint}/alerts` — data plane

Body is `PluginFetchOptions`; response is `PluginFetchResult`
(`{ alerts, warnings? }`). Called **only** when the resolver marks the plugin
applicable **and** the host cache misses. The response is validated against the
published `Alert` JSON Schema before it enters the pipeline — a misbehaving
plugin can only return data that fails validation and gets dropped; it cannot
touch our process.

Versioning stays **out of the URL.** For now the manifest advertises the
`Alert` schema / contract version the plugin emits (e.g. a `contractVersion`
field), optionally echoed in an `x-contract-version` header; the host negotiates
or rejects on mismatch. If we ever need a hard break we can maintain compat
behind the same URL or relocate the version — without rewriting endpoint paths.

---

## 3. Performance model

The remote call does **not** add the upstream data fetch — the plugin performs
that fetch whether it runs locally or remotely. Federation only adds **the hop
to the plugin endpoint**, in front of the same work.

| Factor | Practical cost | Mitigation |
|---|---|---|
| Warm, same-region hop (connection reused) | ~10–40 ms per plugin, **overlapped** across the concurrent fan-out (wall-clock ≈ slowest plugin) | Already fan out concurrently (`maxConcurrentFetches`) |
| TLS handshake | ~50–100 ms on first connect | **Module-scope keep-alive HTTPS agent / undici pool** reused across warm invocations → amortizes to ~0. *Single most important perf detail.* |
| Plugin Lambda cold start | ~200 ms–1 s+ (Node); each plugin cold-starts independently → tail latency | Provisioned concurrency / keep-warm on hot first-party plugins; per-plugin timeout + `continueOnPluginError` so a cold/slow plugin degrades gracefully |
| Payload ser/de | Negligible (Alert arrays are KB–low-MB) | — |
| 3rd-party infra + internet RTT | Tens–low-hundreds of ms, outside our control | Timeout + circuit breaker; colocate first-party plugins in-region |

**Caching is the dominant lever, and the host owns it.** A plugin advertising
`refreshIntervalMs: 5min` is called ~once per 5 min per cache key, not per
request. Steady-state per-request latency is dominated by cache hits; endpoint
latency only bites on miss/refresh. This is free to us and invisible to the
plugin.

**Net:** for warm, cached, same-region traffic the tax is negligible and
overlapped, and is dwarfed by the upstream gov-API fetches (often 100s of ms).
Engineering attention belongs on **cold-start tail latency** and **connection
reuse**, not the steady-state hop.

---

## 4. Authentication

**One scheme, on by default, no config knob yet.** We adopt the **Stripe /
GitHub-webhook model**: TLS + a per-plugin **bearer token** *and* **HMAC
request signing on every request**. There is deliberately **no `auth` manifest
field in v1** — the behavior is fixed and defaulted; a strategy selector can be
added later without breaking existing registrations. No OAuth2, no mTLS in v1.
No hand-rolled crypto (standard HMAC-SHA256).

### Host → Plugin (us calling them)

Every request carries both:

- **Bearer token** (`Authorization: Bearer …`) the plugin issues to us —
  authenticates *the caller*. Stored in our secrets manager, scoped per
  tenant/plugin, rotatable.
- **HMAC-SHA256 signature** over `timestamp + method + path + body`, in a header
  (e.g. `X-Vigilis-Signature: t=<ts>,v1=<hex>`), keyed by a **shared signing
  secret** — authenticates *the request*: integrity + replay protection (verify
  the timestamp is fresh, reject stale/nonce-replayed).

Signing is **nominal overhead**: HMAC-SHA256 over a KB-scale body is
single-digit **microseconds** of CPU and adds no network round trips or state —
cost to us is negligible, so we do it on every call rather than gate it behind
a flag.

### v1 credential model (simple, defaulted)

Per registration we hold two secrets — the **bearer token** (issued by the
plugin) and the **shared signing secret** — resolved from our secrets manager
by a convention-based `secretRef` derived from the plugin `id`. No `auth` object
in the manifest yet. Per-plugin isolation + rotation is the security win.

### Plugin → Host (future callbacks)

Flip the same primitives: the plugin bearer-authenticates and HMAC-signs; we
verify signature + timestamp freshness. The manifest advertises `supportsPush`
so the handshake is forward-compatible today even though we build it later.

---

## 5. Runtime extensibility mechanism

A plugin registration is a **data row**, not code:

```jsonc
// RemotePluginRegistration — stored in DynamoDB / S3 / SSM, per tenant
{
  "id": "acme-flood-feed",
  "endpoint": "https://plugins.acme.io/vigilis",
  "enabled": true
  // no `auth` field in v1 — bearer + HMAC is fixed/defaulted; secrets are
  // resolved by convention from `id` (see §4). An `auth` selector can be
  // added later without breaking existing rows.
}
```

At cold start (and on a refresh TTL) the host loads the tenant's rows, fetches +
caches each `/manifest`, and instantiates a `RemotePlugin` per row → produces the
`PluginRegistration[]` the existing `PluginRegistry` already accepts. **Adding a
plugin is adding a row. No deploy, no rebuild.**

`createDefaultPlugins()` becomes one provider (our first-party endpoints);
`loadTenantPlugins(tenantId)` is a second provider. Both just produce
`PluginRegistration[]`.

### 5a. Config & secret storage — the platform

All of this configuration lives in **our platform**, not in the library. The
library defines two small interfaces and ships trivial defaults; the platform
provides the real implementations:

- **`RegistrationStore`** — the plugin catalog: the `{ id, endpoint, enabled }`
  rows, per tenant. Backed by DynamoDB / a control-plane API / SSM. The library
  ships an in-memory `StaticRegistrationStore`; the platform supplies the
  durable one.
- **`CredentialResolver`** — resolves a plugin `id` to its two secrets (bearer
  **token** + HMAC **signing secret**). Backed by Secrets Manager / SSM
  SecureString, per-plugin, rotatable. The library ships an
  `EnvCredentialResolver` (convention: `PLUGIN_<ID>_TOKEN`,
  `PLUGIN_<ID>_SIGNING_SECRET`) for local/dev; production reads from the vault.

Endpoints and secrets are **never** baked into the deployment bundle — they're
data the host reads at cold start (and on a refresh TTL). Secrets are resolved
lazily and kept per-tenant/per-plugin so one tenant's config can never read
another's. This is the seam where the platform owns the source of truth and the
library stays a stateless consumer of it.

---

## 6. Phased plan

### Phase 0 — Freeze the contract as a published artifact
Derive JSON Schema **v1** from the existing Zod/types for `PluginMetadata`,
`PluginFetchOptions`, `PluginFetchResult`. Version it. New subpath export
`./contract`. This is what third parties build against, independent of our TS.

### Phase 1 — Host: `RemotePlugin` + manifest loader + auth client
- `RemotePlugin extends BasePlugin` — metadata from cached manifest;
  `fetchAlerts` = authenticated `POST {endpoint}/alerts` + schema-validate
  response.
- Manifest cache/loader (`GET {endpoint}/manifest`, TTL refresh); resolver uses
  cached metadata.
- Fixed, defaulted auth: bearer token + per-request HMAC signing (no manifest
  `auth` field yet).
- **Module-scope keep-alive HTTPS agent** for connection reuse.
- `RemotePluginRegistration` store + `loadTenantPlugins()` loader.

*This phase is the complete runtime-extensibility story.*

### Phase 2 — Plugin SDK: `createPluginServiceHandler(plugin)`
- Server handler exposing `{endpoint}/manifest` + `{endpoint}/alerts` with
  auth-verify middleware. `BasePlugin` fetch helpers stay server-side.
- Repackage each first-party plugin as its own Lambda behind this handler.
  `createDefaultPlugins()` for the host becomes "register these first-party
  endpoints" — **we operate exactly like a third party.**
- Publish the SDK (package or subpath) so external authors `npm i`, implement
  `fetchAlerts`, deploy. Raw-HTTP implementation in any language stays valid.

### Phase 3 — Ops hardening
Circuit breaker / health state in the registry; egress allowlist for 3rd-party
URLs (SSRF defense); response-size caps; per-tenant credential rotation;
provisioned concurrency on hot plugins. Existing per-plugin
`durationMs` / `success` (`PluginResultInfo`) becomes per-endpoint SLA telemetry
for free.

### Phase 4 — Callbacks / realtime push (future)
Host ingest endpoint; HMAC-verified push (timestamp + nonce replay protection);
manifest `supportsPush` handshake. Same auth primitives, reversed direction.

Phases 0–2 deliver runtime extensibility; 3–4 harden and extend. Migration is
incremental because `RemotePlugin` coexists with local plugins.

---

## 7. Impact on the current codebase

| Area | Change |
|---|---|
| `src/types/plugin.ts` | Add `contractVersion`, optional `supportsPush` to `PluginMetadata`; no breaking change to `AlertPlugin`. |
| `src/core/plugin-registry.ts`, `plugin-resolver.ts`, `alert-aggregator.ts`, `alert-feed.ts` | **Unchanged** — they operate on `AlertPlugin` regardless of local/remote. |
| `src/plugins/base-plugin.ts` | Becomes the **server-side** base for endpoint authors; add `RemotePlugin` (host-side client) as a sibling. |
| `src/plugins/defaults.ts` | Evolves from `new XPlugin()` into first-party **endpoint registrations** (Phase 2). |
| `src/adapters/` | Add `createPluginServiceHandler` (multi-plugin server, §1c routing); host `createLambdaHandler` gains the tenant plugin loader. |
| New: `src/contract/` | Wire-contract Zod schemas + `CONTRACT_VERSION` (v1). |
| New: `src/federation/` | `RemotePlugin`, manifest fetch/validate, bearer+HMAC signer/verifier, keep-alive HTTP client, `RegistrationStore` + `CredentialResolver` interfaces with default impls + `loadRemotePlugins()`. |

The generalization beyond alerts (3rd-party data queries, etc.) reuses the same
kernel — manifest store, `RemotePlugin`-style client, auth strategies, schema
validation — with a different contract per capability.
