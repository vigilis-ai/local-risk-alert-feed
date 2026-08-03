# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

## [2.0.0] - 2026-08-03

### Changed
- **BREAKING: `PluginMetadata.health.expectsData` is required.** Whether an empty
  result means a source is broken is a fact only the plugin author knows, and it
  had been living everywhere else — a hardcoded `Set` in a seeding script in
  another repository, then a query parameter on a registry record. Every one of
  those was a copy that went stale the moment a plugin changed.

  It is required rather than defaulted because **both wrong answers are costly**
  and neither can be inferred. Default it to `true` and every legitimately quiet
  feed — flood warnings, weather alerts, an air-quality reading below its
  threshold — alarms on an ordinary day until the alerting is ignored. Default it
  to `false` and the day a source dies it answers "nothing happening" forever,
  which is the exact failure a health check exists to catch. Requiring it makes
  the decision unskippable at authoring time; `tsc` names every plugin that has
  not made it.

  `health.probePoint` is optional and answers the other half: a global source has
  no coverage centre, but "anywhere" is not a usable probe either — an
  air-quality feed queried mid-ocean returns nothing however healthy it is. The
  plugin names a point where its data is real.

  Precedence is query parameter → manifest → derived default, so a feed can
  still be re-probed elsewhere during an incident without cutting a release.

  **The wire schema keeps `health` optional on purpose.** The two sides of a
  federation boundary deploy independently, so a host on this contract will meet
  endpoints that predate the field; rejecting their manifests would take working
  feeds offline over metadata the host can safely default. `RemotePlugin` fills
  `{ expectsData: false }` when it is absent.


## [1.8.1] - 2026-08-03

### Fixed
- **A source that can see both past and future got a backward-only health
  probe.** The forward window was derived from `!supportsPast`, so it only
  opened for future-only feeds. Forecast sources — weather, air quality — set
  *both* flags, and an alert issued for tomorrow is invisible looking backwards.
  With `expectData=true` that reported a working source as failing.

  The two directions are now independent: look back if `supportsPast`, look
  forward if `supportsFuture`. Widening a probe can only add records, so an
  over-long forward window is safe in a way an over-short one is not.


## [1.8.0] - 2026-08-02

### Added
- **`GET /plugins/{id}/health` — a plugin answers for its own health.** A third
  wire action alongside `manifest` and `alerts`, authenticated with the same
  bearer + HMAC scheme, so a host can ask "is this feed working?" without
  knowing anything about the feed.

  The verdict has **three** states, because two cannot tell a source with
  nothing to report from a broken one — and for a risk feed those demand
  opposite responses. `healthy` (records returned), `quiet` (empty, and nothing
  was expected — a flood service on a dry day), `unhealthy` (the fetch failed,
  or returned nothing when `expectData=true`).

  Every probe parameter is optional and defaults from the plugin's **own
  manifest**, which is the point: the plugin already declares where it covers,
  how far behind its source runs, and whether it can see the past. A caller
  supplying those would keep a second copy of facts the plugin owns, and that
  copy goes stale the moment coverage or lag changes.

  Two defaults exist specifically to avoid probes that return a *false* empty
  rather than an error — the failure mode that reads as "working, nothing
  nearby":

  - The window spans **twice the declared `dataLagMinutes`**. A source running
    120 days behind, probed over 24 hours, is indistinguishable from a dead one.
  - A source with `supportsPast: false` is probed **forward**. Event feeds only
    know about the future, so a backward window is unsatisfiable and always
    returns zero.

  An upstream failure answers **HTTP 200 with `status: 'unhealthy'`**, not 5xx:
  "this plugin's upstream is down" and "the plugin service is down" are
  different failures, and a caller has to be able to separate them.

  Additive — no contract-version bump. Plugins are untouched; the adapter
  converts the relative window to the absolute `timeRange` they already take.


## [1.7.4] - 2026-07-26

### Fixed
- **The fetch budget never crossed the federation boundary.** `maxResults`, `minRiskLevel` and `rank` — added in 1.6.0 so a plugin pulls only what the host can use — were absent from both `PluginFetchOptionsSchema` and the body `RemotePlugin` posts. Every federated endpoint therefore saw no budget and fell back to its own ceiling: a host asking for 50 alerts still pulled thousands over the wire and discarded nearly all of them.

  Harmless while plugins also ran in-process, and invisible from the outside — the alerts were correct, just enormously over-fetched. Once hosts moved to remote-only the budget was dead everywhere. `atlanta-crime` read ~4,800 records for a query that could use 100; `glendale-police` ~500.

  All three fields are optional, so an older endpoint ignores them and a newer endpoint called by an older host still uses its ceiling. No contract-version bump: the change is additive.

## [1.7.3] - 2026-07-26

### Fixed
- **`atlanta-crime` ignored the host's fetch budget and asked for every column.** It read up to its own 5,000-record cap regardless of what the caller said it could use, with `outFields=*` on a wide layer — so most of the response was records the host discarded and columns the plugin never reads. It now calls `resolveFetchBudget` like the other ArcGIS plugins, pages no larger than that budget, and names the 19 fields it actually uses.

  Measured against the live APD layer at a 10 km envelope, with the budget the host really passes (100): a 7-day window drops **0.53 MB → 0.06 MB (89%)** and a 30-day window **1.71 MB → 0.06 MB (97%)**. A 1-day window was already small (0.06 MB) and improves to 0.04 MB — the bloat only showed on wider windows, where it had grown past the 4 MB transport warning threshold.

## [1.7.2] - 2026-07-26

### Fixed
- **`phoenix-fire` and `glendale-fire` also under-declared their delay.** Both declared 24h and run ~34h behind, which left them exactly on the boundary: a 24-hour window looked answerable, returned nothing, and said nothing about why. Both now declare 48h.

  Found by auditing all 28 feeds, which needed a better method than 1.7.0 used. "Age of the newest record" measures publication delay only on a continuously-active feed; on a sparse or scheduled one it just measures when something last happened, and would have wrongly flagged `atlanta-traffic` (1 record), `nyc-traffic` and `nj-workzones`. The discriminator is the age *distribution*: a delayed feed shows a hard cutoff — `phoenix-fire` carries 31 records/day and **zero** newer than 34h, the same signature as the known-delayed `bend-police` — while a live feed runs right up to the present, as `seattle-emt` does with 22 records in the last six hours.

## [1.7.1] - 2026-07-26

### Fixed
- **`SourceFreshness` wasn't exported from the package root**, so consumers couldn't name the type 1.7.0 had just added. It was re-exported from `types/index.ts` but missing from the root export list.

## [1.7.0] - 2026-07-26

### Added
- **Per-source freshness, so an empty answer can't pass for a quiet night.** `meta.sources` now reports, for every source consulted, how many alerts it contributed, its declared publication delay (`dataLagMinutes`), the newest instant it could possibly know about (`asOf`), and — the point of the whole thing — `lagExceedsWindow`: true when the requested window starts *after* that instant, so the entire window sits in the source's blind spot and an empty result means "not published yet", not "nothing happened".

  Today those two cases are indistinguishable. Bend PD publishes ~35 hours behind; asked for the last 24 hours it returns zero, exactly like a source reporting a genuinely quiet night. A caller can only relay that as "nothing near you" — reporting a blind spot as an all-clear.

  When the flag is set, `suggestedTimeRange` carries the same span shifted back past the delay: a window that *would* reach the data. It is offered, never applied. Silently widening would answer "what's happening near me" with a week-old complaint, which trades a false silence for a false present — the caller should ask ("Bend PD runs about 2 days behind — want me to check the last few days?"), and a yes is just an ordinary query with an explicit range.

  Purely additive: which alerts are returned is unchanged, and no source is dropped or skipped on the strength of its declared lag.

### Fixed
- **Four sources under-declared their publication delay, defeating the freshness flag.** Measured against the live feeds on 2026-07-25 by taking the age of each one's newest record: `seattle-police` declared 1 hour but runs ~3 days behind, `austin-crime` declared 24h and runs ~7 days, `nyc-crime` declared 45 days and runs ~116, and `glendale-police` declared 24h but runs ~37 — enough that a 24-hour window looked satisfiable and came back empty without a word. All four now declare a rounded-up value. Rounding up is deliberate: over-declaring merely offers a wider window that wasn't needed, while under-declaring reports a blind spot as an all-clear.
- **`meta.sources` counts were wrong unless `includePluginResults` was set.** Per-plugin results were only collected when the caller asked for the diagnostic array, so every source's `alertCount` read 0 otherwise. They are now always collected internally; `includePluginResults` still controls whether `pluginResults` is exposed on the response.

## [1.6.2] - 2026-07-15

### Added
- **An overall query deadline, so a slow source can't hold the caller hostage.** `AlertFeedConfig.overallTimeoutMs` (or per-query `AlertQuery.overallTimeoutMs`) bounds a whole `query()` across all plugins. When it fires, the query returns whatever plugins have already finished; the rest are reported in `meta.incompletePlugins` with `meta.partial = true` instead of blocking the response. `pluginTimeoutMs` still caps each plugin individually — this caps the aggregate. Unset preserves the previous "wait for everyone" behaviour.

### Changed
- **Plugin fan-out is now a bounded worker pool instead of sequential chunks.** Up to `maxConcurrentFetches` plugins run at once and a new one starts the moment a slot frees, so a fast plugin is never stuck waiting behind a slow one in an earlier chunk. Previously the fetch ran chunk-by-chunk with a barrier between each, so total latency was the sum of the slowest-per-chunk; now it's driven by the pool (and bounded by `overallTimeoutMs` when set).

## [1.6.1] - 2026-07-11

### Fixed
- **A focused query could return alerts outside the requested categories.** The resolver only decides which *plugins* to ask; a plugin that spans several categories still returns everything it found (Glendale PD dispatches fire `904` and medical `901x` calls alongside crime). So "any fires nearby?" came back with a severe thunderstorm watch in it. The category scope is now enforced on the **alerts**, not just on plugin selection.

## [1.6.0] - 2026-07-11

### Added
- **Query intent — the same alerts, ranked for the question actually being asked.** `AlertQuery.intent`:
  - **`triage`** (default): *"what matters most near me, right now."* Results are selected with a **fair share per category**, so one busy source can't monopolise the answer.
  - **`focused`**: the caller named `categories` and/or the new `sources` (restrict to specific plugin ids, e.g. only fire/EMS responders). Severity is not the question — return the fullest, most **recent** set in scope, with no cross-category balancing. Auto-selected when `categories`/`sources` is set; set `intent` explicitly to override.
- **A fetch budget pushed down to plugins.** `PluginFetchOptions` gains `maxResults` (the most records the host can actually *use* from this plugin), `minRiskLevel` (the risk floor, so a source with a severity field can filter upstream instead of fetching-then-dropping), and `rank` (`severity` | `recency` — which slice to keep when it must cut). `BasePlugin.resolveFetchBudget()` gives plugins one uniform way to honour it; ignoring it still works, it just wastes bandwidth. `glendale-police`, `phoenix-fire`, `glendale-fire` and `bend-police` now honour it, and glendale-police additionally pushes the risk floor into its query as a priority ceiling.

### Fixed
- **One busy source could take every slot.** Near Tanger Outlets a week of severe police calls filled all 50 results and the guard saw **zero** of the 353 fire/EMS incidents also present — an active fire next door would never have surfaced. Triage now round-robins across categories (each internally ordered worst-first), so every kind of risk present is represented while still leading with the worst of each. Leftover slots go to the best of the rest, so a genuinely crime-dominated area still reads as crime-dominated.
- **Ranking respects severity over freshness.** A first cut used a multiplicative recency decay; it made a *moderate roadwork notice from this morning* outrank the *July 4 shooting*, which is exactly wrong for a security product. Severity band is now the primary key, an in-progress incident is bumped one band (a live fire beats a settled one of equal severity, but never leapfrogs something genuinely worse), and time only breaks ties **within** a band.

## [1.5.0] - 2026-07-11

### Fixed
- **`austin-crime` and `seattle-police` emitted schema-invalid `issued` timestamps.** Both used the upstream Socrata field verbatim (`report.rep_date`, `call.cad_event_original_time_queued`) — a floating local wall-clock with no timezone suffix (e.g. `2026-07-04T00:00:00.000`), which fails the contract's timezone-qualified datetime format. Harmless in-process (nothing re-validated), but over the federated transport `RemotePlugin` validates the response, so **every alert from these two plugins would be rejected and the plugin would return nothing.** Found by the new `risk-plugins` perf/scale/functional harness. Both now stamp the floating time with the source's real UTC offset via `zonedIso` (Austin = America/Chicago, Seattle = America/Los_Angeles), so the instant is valid and unambiguous — e.g. `2026-07-04T00:00:00-05:00`.

### Added
- **`zonedIso` / `offsetForZone`** exported from the package root — label a floating local timestamp (common in Socrata feeds) with the correct DST-aware UTC offset. Lets out-of-tree and federated plugins share one implementation instead of copying it.

## [1.4.0] - 2026-07-11

### Changed
- **`phoenix-fire`, `glendale-fire`, `bend-police` now fetch the most relevant records, not the firehose** — the same over-fetch that 1.3.0 fixed in `glendale-police`, found by measuring every plugin's record count and latency proactively rather than waiting for each to hit a bottleneck.
  - **`phoenix-fire`**: a Phoenix-metro 7-day window is ~1,800 fire/EMS records (mostly EMS). Capped at the 500 most-recent. Unlike crime, fire/EMS relevance decays with time — a medical call days ago is not a current risk — so a recency cap is appropriate. ~1,787 rows / 2.9s → ~475 / 1.2s.
  - **`glendale-fire`**: same recency cap (shares the Phoenix layer).
  - **`bend-police`**: Bend PD has no priority field, so self-initiated/nuisance call types (traffic stops, follow-ups, parking, welfare checks, …) are now excluded server-side by call type — the dominant volume. That alone brings a 7-day window from ~1,200 to ~500 real calls, and cut latency from ~12.8s to ~4.5s. Capped at 500.
- No API changes; `pageSize`/`maxRecords` override the caps if the full set is needed.

## [1.3.0] - 2026-07-11

### Changed
- **`glendale-police` now fetches the most *relevant* calls, not the whole firehose.** A 7-day window near one site returned ~2,466 records — but ~60% of Glendale PD volume is officer self-initiated activity (Priority 7: traffic stops, field contacts), which is never a risk alert, and the host discards everything down to its top ~50 by risk anyway. Transferring and validating thousands of rows made each call ~15s, which is untenable over the federated (HTTP) transport. The query now drops Priority 7 server-side, orders by `CurrentPriorityKey` (severity proxy) then recency, and caps at 500 (one page) — every P1/P2 plus the most recent lower-priority calls, truncation-flagged. Measured: a Tanger Outlets 7-day query dropped from ~2,466 rows / ~15s to ~500 / ~4s, still surfacing the July 4 shooting as the top result. No API change; existing callers just get a smaller, more relevant, much faster result. Override with `pageSize`/`maxRecords` if the full set is genuinely needed.

## [1.2.1] - 2026-07-10

### Fixed
- **An ArcGIS outage was reported to callers as "no alerts near this site".** ArcGIS answers a rejected query with HTTP 200 and a body of `{"error": {...}}` carrying no `features` key, so `fetchJson` saw `response.ok` and never threw, and `fetchArcGisFeatures` coerced the missing array to an empty page — resolving `{ features: [], truncated: false }`. Every ArcGIS-backed plugin therefore rendered an upstream failure as a genuinely quiet feed, indistinguishable from a site with nothing happening near it. A failed page now throws `ArcGisQueryError` (exported from the package root) rather than returning zero features, and a page missing its `features` array is treated as a failure rather than as the end of the result set.

## [1.2.0] - 2026-07-10

### Added
- **`phoenix-regional-active-incidents` — the only public feed that covers Glendale Fire Department.** The 30-day history layers are scoped to Phoenix (`CITY IN ('PHX','PDV','LAV')`) and Maricopa County (`'MAR'`), and Glendale's own dataset (`FIRE_UNIT_RELIABILITY_DASHBOARD_PT_Query`, 289k geolocated incident records) stopped receiving rows on 2025-07-14 with zero entries for 2026 — so `glendale-fire` can only ever return Phoenix mutual-aid responses. Phoenix Regional Dispatch's `Active_Incidents__Public` layer carries `GLN` alongside `PHX`/`TMP`/`SUR` and the rest of the Valley automatic-aid system. It holds only incidents units are actively committed to, so the plugin serves `real-time` alerts, does not filter by time (an incident that began before the window may still have units on scene), and classifies an unknown nature as `moderate` rather than `low`. Its `Date` field is genuine UTC, unlike `REPORTED` on the sibling history layers.
- The ArcGIS helpers (`fetchArcGisFeatures`, `envelopeForRadius`, `toArcGisTimestamp`) are now exported from the package root, so out-of-tree and federated plugins can build on the same paging and envelope logic.

### Fixed
- **`atlanta-crime` anchored alerts to when a crime was reported, not when it happened.** `issued` came from `ReportDate` while the query window filters on `OccurredFromDate`, and APD publishes ~4% of incidents with a report date preceding the occurrence date (165 of 4,291 over 30 days). Those alerts carried an `issued` outside the requested window — and `issued` is what the aggregator dedupes and sorts on, and what a consumer reads as "when this happened". `issued`/`eventStart` now anchor on the occurrence, matching every other police plugin; the report date is preserved as `metadata.reportedAt`, records reported before they occurred are flagged with `metadata.reportedBeforeOccurrence`, and `eventEnd` is clamped so an inverted occurrence window can't end before it starts.

## [1.1.1] - 2026-07-10

### Fixed
- **`nifc-wildfire` took an arbitrary 500 rows from the national incident layer.** The query had no spatial filter and no `orderByFields`, so it pulled an unordered 500 of every active US incident and filtered by radius client-side — meaning *which* fires survived the cap was undefined, and during fire season a blaze next to a site could be dropped. The layer currently holds 495 incidents, five short of the cap. It now bounds the query to the requested radius, orders stably by `OBJECTID`, pages through the result set, and warns when a cap stops the walk.

## [1.1.0] - 2026-07-09

### Fixed
- **ArcGIS plugins no longer truncate away the most severe events in a window.** `glendale-police`, `glendale-fire`, `phoenix-fire`, `bend-police`, and `atlanta-crime` each issued a single query capped at `resultRecordCount`, ordered newest-first over a bounding box far larger than the requested radius, and applied the radius filter afterwards — client-side. On a busy feed the cap was reached long before the radius filter ran, so the oldest records in the window were discarded silently. Glendale runs ~360 calls/day: a `past-7d` query near Tanger Outlets matched 2,148 records against a 500 cap, which reached back only 1.5 days. The July 4 mass shooting 187m from the site ranked #1110 and never reached the caller. Each plugin now pages through the full result set with `resultOffset`, sizes its spatial envelope to the requested radius, and reports a `warnings` entry when a cap does stop the walk.
- **`glendale-police` scored gunfire as low risk.** `CALL_TYPE_MAP` keyed on bare descriptions (`'SHOOTING'`), but GPD publishes code-prefixed values (`'901G-SHOOTING'`), so every exact lookup missed and classification fell through to substring guessing. `417S-SHOTS FIRED`, `417G-SUBJECT WITH A GUN` and `901C-CUTTING OR STABBING` scored `low` while `459A-BURGLARY ALARM` scored `high`. Classification is now keyed on the GPD call code, and a Priority-1 floor guarantees an unmapped life-threatening call is never reported as low risk.
- **Police and fire timestamps were 7 hours early.** `IncidentDate` (Glendale PD) and `REPORTED` (Phoenix Fire) store local wall-clock time as epoch-as-if-UTC, so a 9pm shooting was emitted as `20:58Z` — 1:58pm local. This also corrupted `temporalType`, labelling live events `historical`. Both layers publish a true-UTC companion field (`DateTime_Plus7`, `REPORTED_UTC`), now used for filtering, ordering, and output. `DATE` literals in the where-clause additionally truncated the upper bound to midnight, excluding everything from the current day; bounds now use second-precision `TIMESTAMP` literals.
- **`bend-police` returned nothing for any window older than the last 500 calls.** The layer holds ~441k rows; the plugin fetched the newest 500 with `where: 'OBJECTID > 0'` and filtered the time range client-side. `CreateDateTime` does accept `TIMESTAMP` literals, so the window is now enforced server-side, and the plugin gained the spatial filter it never had.
- **Truncation and error warnings survived caching.** `warnings` was either declared and never written (`glendale-police`, `glendale-fire`, `phoenix-fire`, `bend-police`) or pushed into an array captured by the cached fetcher (`atlanta-crime`), so a cache hit dropped it. Warnings are now cached alongside the alerts.
- **`glendale-police` dropped the emergency response.** `PrimaryUnitId`, `FirstUnitDispatchedTime`, `FirstUnitArrivedTime`, and `IncidentStatusDescription` were fetched and discarded; they now reach `metadata` and the alert description ("First unit on scene: 6 min after call").

### Added
- **`utils/arcgis`** — `fetchArcGisFeatures` (offset paging that reports `truncated`), `envelopeForRadius` (an envelope sized to the query radius rather than a fixed box), and `toArcGisTimestamp` (second-precision `TIMESTAMP` literal bodies).
- `glendale-police` now emits `fire` and `medical` categories, which GPD dispatches (`904`, `901x`), and declares them in `supportedCategories`.

### Changed
- `limit` on the ArcGIS plugin configs is deprecated in favour of `pageSize` (records per request) and `maxRecords` (ceiling across all pages, default 5000). `limit` is still honoured as the page size, and no longer caps the overall result.

## [1.0.3] - 2026-07-03

### Fixed
- **`source.type: 'traffic'` no longer rejected.** `AlertSourceTypeSchema` was missing `'traffic'`, so it had drifted from the `AlertSourceType` type (which includes it) — traffic/transit plugins failed `PluginFetchResultSchema` validation. The enum now matches the type.
- **Alert location fields accept `null`.** `AlertLocationSchema` optional strings (`address`, `city`, `state`, `zipCode`) rejected `null`, which some feeds emit for unknown values; they now accept `null` and normalize it to `undefined` (validated shape unchanged), matching the timestamp fix in 1.0.2.

## [1.0.2] - 2026-07-03

### Fixed
- **Alert timestamps now accept timezone offsets and open-ended (`null`) times.** `AlertTimestampsSchema` (and `TimeRangeSchema`) validated datetimes as UTC-`Z`-only, so real upstream feeds that emit offset timestamps (e.g. NWS `2026-07-03T14:00:00-04:00`) and `null` for alerts with no end failed `PluginFetchResultSchema` validation — the host and `vigilis-plugin-verify` rejected otherwise-valid live alerts from weather, traffic, transit, air-quality, wildfire, and airport plugins. Datetimes now allow an offset, and the optional timestamp fields accept `null` (normalized to `undefined`, so the validated shape still matches `AlertTimestamps`). UTC `Z` remains valid and malformed values are still rejected.

## [1.0.1] - 2026-07-02

### Added
- **Plugin conformance suite + `vigilis-plugin-verify` CLI** — a runner-agnostic certification harness so any author (ours or third party) can prove a plugin is functional and speaks the contract. `runConformanceSuite()` (new `./testing` export) runs in two modes off the same checks: **SDK-object** (pass a plugin instance) and **endpoint** (pass an endpoint + credentials; it drives `/manifest` + `/alerts` over HTTP via `RemotePlugin` and probes auth enforcement — works for any language). Checks manifest schema/coherence, `coversLocation`, schema-valid alerts, `category ⊆ supportedCategories`, radius/limit sanity, and (endpoint mode) that the service rejects missing/bad/stale auth. Returns a structured `ConformanceReport` (no test-runner dependency). New `vigilis-plugin-verify` bin runs it against a live endpoint and exits non-zero on failure for CI. Authoring + certification guide in `architecture/plugin-authoring.md`.

## [1.0.0] - 2026-07-02

First stable release of the **federated plugin model** — plugins run out-of-process behind HTTP endpoints, discovered and called at runtime with no rebuild, and the framework surface (core, contract, federation, adapters, `BasePlugin`) is now the public SDK.

### Added
- **Plugin federation — runtime-extensible, out-of-process plugins.** Plugins can now live behind HTTP endpoints (ours or third parties') that the framework discovers and calls at runtime, with **no rebuild or republish**. Everything is a remote endpoint, including our own plugins; the host owns caching/retries/timeouts/aggregation/telemetry and the endpoint is a stateless call-out. Design in `architecture/plugin-federation.md`.
  - **Wire contract (`./contract`)** — versioned Zod schemas (`PluginManifestSchema`, `PluginFetchOptionsSchema`, `PluginFetchResultSchema`) + `CONTRACT_VERSION`, reusing the existing `AlertSchema`. URLs are unversioned; the contract version travels in the manifest. Control-plane `GET {endpoint}/manifest` (cached, drives the resolver) vs data-plane `POST {endpoint}/alerts` (only on applicable + cache-miss).
  - **Host side (`./federation`)** — `RemotePlugin` (an ordinary `AlertPlugin`, so the existing registry/resolver/aggregator pipeline is unchanged and local + remote coexist), `FederationClient` (signing, timeouts, response validation, undici keep-alive with injectable `fetchImpl`), and the storage seams `RegistrationStore` / `CredentialResolver` with dev defaults (`StaticRegistrationStore`, `EnvCredentialResolver`) plus `loadRemotePlugins()` → `PluginRegistration[]`. Adding a plugin is adding a catalog row.
  - **Server side (`./adapters/plugin-service`)** — `createPluginServiceHandler([...plugins])`: one Lambda serves many plugins, each on its own `/plugins/{id}/{manifest|alerts}` route, with per-plugin auth verification. An endpoint is a route, not a deployment, so re-segmenting plugins across deployments is a config change.
  - **Auth** — Stripe/GitHub-webhook model: per-request **bearer token + HMAC-SHA256 signature** (`t=…,v1=…`, `timestamp . method . canonicalPath . body`) with a replay window, on by default (no manifest `auth` field in v1). Signed path is derived from `(id, action)` so stage prefixes don't break verification. Round-trip + tamper/replay/wrong-secret tests included.
  - **Lambda host wiring** — `createLambdaHandler` accepts a `remotePlugins` option (`{ store, credentials, client?, manifestTtlMs? }`) and loads federated plugins at cold start alongside static ones. Registration now runs through a single awaited `ready` promise, so the first request can't race an unfinished registration (also removes a latent double-registration with the `AlertFeed` constructor).
  - **Manifest TTL refresh** — `RemotePlugin` takes `manifestTtlMs`: after the TTL expires, the manifest is lazily re-fetched on the next `fetchAlerts` so coverage/metadata stay current across a warm container. Best-effort — a failed refresh logs and keeps the last-known-good metadata, so a transient manifest hiccup never fails a query. Threaded through `loadRemotePlugins`; covered by a clock-driven test.
  - **Vercel host wiring** — `createVercelHandler` gains the same `remotePlugins` option and single awaited `ready` registration path as the Lambda adapter, so federated plugins load at startup alongside static ones on Next.js App Router routes.
  - **Egress guard (SSRF defense)** — `EgressPolicy` validates every host→plugin URL before the fetch: HTTPS-only by default, private/loopback/link-local and the cloud-metadata address (`169.254.169.254`, `fd00:ec2::254`) blocked, optional host allowlist (exact or `.suffix`), and optional DNS-resolution range-checking. Wired into `FederationClient` (safe default policy) and `loadRemotePlugins`; `EgressBlockedError` thrown on violation. IPv4/IPv6 range classification + client-refuses-before-fetch tests.
  - **Circuit breaker** — per-plugin `CircuitBreaker` guards the data-plane call: after `failureThreshold` consecutive failures it opens and fails fast (`CircuitOpenError`, no call made) for `cooldownMs`, then half-opens for a single trial. Each `RemotePlugin` owns its own breaker, so one down endpoint is isolated and surfaces via the existing `continueOnPluginError` path without failing the query. Threaded through `RemotePlugin`/`loadRemotePlugins`; open→fail-fast→half-open recovery test.
  - **Response-size caps** — the client bounds each plugin response: a **hard cap** (default 16 MB) rejects early on an oversized `Content-Length` and streams with a running byte count so a lying/absent header can't blow past it (`ResponseTooLargeError`), and a **soft warn** threshold (default 4 MB) logs actual sizes without failing. Defaults are calibrated to current plugins — the worst realistic response (a 1000-alert crime feed ≈ 1.5 MB) sits ~10× under the hard cap, so nothing current breaks, while the soft-warn surfaces true production sizes to recalibrate later.
  - **Credential rotation** — `CredentialResolver.resolve` may return `[current, previous]`, and `verifyRequest` accepts a request signed with **either** (bearer token and signature must match the *same* credential), enabling zero-downtime secret rotation. The client always signs with the primary (`primaryCredential`); `EnvCredentialResolver` reads `PLUGIN_<ID>_TOKEN_PREVIOUS` / `PLUGIN_<ID>_SIGNING_SECRET_PREVIOUS` for the window. Rotation-window + mixed-credential-rejection tests.

### Changed
- **Query-exact cache keys.** `generateCacheKey` now takes a `CacheKeyParams` object and includes **every result-affecting field** — location (default ~1.1m precision, configurable via `locationPrecision`), **radius**, the **full time window** (no day-level truncation), category/temporal filters (order-independent), and limit. Previously radius was absent and time was truncated to the day, so a different-radius or different-window query could wrongly hit a cached result. Now cached data is only ever reused for an identical query (e.g. an east-Phoenix / 5km lookup can never be served from a west-Phoenix or 10km entry).
- **Per-source cache TTL.** `BasePlugin` resolves cache TTL as explicit arg → plugin `cacheTtlMs` → the plugin's own `metadata.refreshIntervalMs` → global 5-minute default (`getCacheTtlMs`). Each source now caches for as long as its data stays fresh — a throttled events feed can declare a long refresh interval while a real-time feed stays short — instead of a single global TTL. No aggressive/global caching; this is the lever for bounding upstream call volume without returning stale data.

## [0.9.0] - 2026-06-25

### Changed
- **Package is now private to the `@vigilisai` org** (`publishConfig.access: restricted`), matching the sibling SDKs. The previously-public `0.5.0`–`0.8.0` versions were unpublished; consumers should depend on `0.9.0`+.

### Added
- **`BaselineRiskPlugin` — relative-risk scoring within the existing plugin interface.** An abstract `BasePlugin` for rarely-changing, cell-quantized historical sources (e.g. crime by grid cell). It materializes the whole area once, scores every cell's **percentile rank** across the full cell universe, caches the snapshot keyed by the dataset version (re-checked at most once per `versionCheckTtlMs`, default 1h), and emits a **single summary `Alert` per query location** — relative tier in `riskLevel`, full breakdown in `metadata` (`kind: 'baseline-summary'`, totals, top categories, home-cell percentile, citywide context). No interface change: still an `AlertPlugin`. Pure `scoreCells` / `percentileToRisk` helpers are unit-tested. `./plugins/baseline` export.
- **`PhoenixCrimeRiskPlugin`** — first `BaselineRiskPlugin`: City of Phoenix open crime data (624k+ incidents) aggregated over the 2,405-cell police grid (bundled `phoenix-grid.ts`), scored relative to the city. Registered in `createDefaultPlugins()`; `./plugins/phoenix-crime` export. Live-verified: a downtown site scores Extreme (99th pct), suburban malls Moderate-High; whole-grid cold build ~0.8s, then cached (sub-ms per site).
- **Map + UI support for baseline risk:** `BaselineRiskPlugin#getRiskSurface()` returns every scored cell (`cellId`, `centroid`, `percentile`, `riskLevel`, counts) for choropleth/heatmap rendering, from the same cached snapshot. New exported `BaselineSummaryMetadata` (narrow `alert.metadata` when `kind === 'baseline-summary'`) and `RiskSurfaceCell` types. Design + UI guidance in `architecture/baseline-risk-ui.md` (site score vs area baseline, Leaflet choropleth/heatmap, overlay/contrast with the live risk map, historical table rendering, backend caching).

## [0.8.0] - 2026-06-25

### Changed
- **NWS plugin now classifies all-hazards events** — `NWSWeatherPlugin` already ingested the full CAP feed (`/alerts/active?point=`); it now routes non-weather events to the right category instead of tagging everything `weather`: fire-weather/red-flag→`fire`, civil emergency/law enforcement/evacuation→`civil-unrest`, hazmat/radiological/911-outage/child-abduction→`other`. `supportedCategories` expanded accordingly; source type pinned to `weather`. New `classifyNwsEvent` helper is unit-tested.

### Added
- **`createDefaultPlugins()` — canonical default plugin list** (exported from the package root and `./plugins`). Returns every production plugin ready to register (24 by default; 26 with the AirNow + Atlanta-traffic keys set), resolving keys from options or env. Keyless plugins are always included; key-required ones (AirNow, Atlanta traffic) only when their key is present; **TRANSCOM is always included but disabled** until `TRANSCOM_FEED_URL` is set, then auto-activates. `scripts/run-all-plugins.ts` now uses it as the single source of truth. Unit-tested.
- **TRANSCOM plugin scaffold** (`TRANSCOMPlugin`) — cross-Hudson NY/NJ/CT aggregator (incl. Port Authority, PATH, NJ agencies). **Registerable but disabled:** it constructs without a feed URL, exposes `configured`/`enabled === false`, and returns zero alerts plus a "disabled" warning on every query (never throws) — so it can be wired into the feed now and switched on the moment `TRANSCOM_FEED_URL` is set. The full fetch/filter/transform pipeline is in place; the schema-specific bits (feed URL + XML field names) are isolated and marked pending a real sample. **TRANSCOM account creation is paused May 1 – July 31, 2026 for FIFA World Cup 2026** — re-register on/after 2026-08-01 at https://data.xcmdata.org/ (contact techsonly@xcm.org), then set `TRANSCOM_FEED_URL`/`TRANSCOM_API_KEY` and verify field names. Unit-tested: severity mapping + disabled-state behavior.
- **MTA subway service alerts plugin** (`MTAAlertsPlugin`) — subway delays, suspensions, reroutes, and planned work from the MTA GTFS-realtime "all alerts" JSON feed (keyless). GTFS-RT alerts carry only route/stop IDs, so the plugin joins `stop_id`→coordinates using a bundled station table (`subway-stations.ts`, 496 stations from NYC Open Data `39hk-dx4f`) and places each alert at the nearest affected station within the query radius. Severity mapped from the Mercury `alert_type` (Reduced Service/Suspended→high/severe, Planned work→low). Line-wide alerts with no station-level location are skipped and reported in warnings. `./plugins/mta` export.
- **NJ / Jersey City work-zones plugin** (`NJWorkZonesPlugin`) — active road work zones and lane closures for Jersey City / northern NJ from the NJDOT WZDx feed (`https://smartworkzones.njit.edu/nj/wzdx`, GeoJSON, **keyless**). Centered on Jersey City (40.7178, -74.0431), 30km radius (Hoboken, Newark/EWR, Elizabeth, Hudson crossings). Risk derived from the work-zone description (the feed reports `vehicle_impact` uniformly, so closure detail is parsed from text). Covers **work zones only** — NJ has no public real-time incident API; full NJ incident + Port Authority/PATH coverage comes from TRANSCOM (scaffolded, pending). `./plugins/nj` export. Unit-tested risk mapping; live-verified (460 statewide zones, ~13 in the JC/Newark band).
  - *Supersedes the earlier `NJTrafficPlugin` (removed): it assumed a 511NJ developer API that does not exist — NJ exposes no keyed 511 endpoint, so `NEW_JERSEY_511_API_KEY` is gone.*
- **FAA Airport Status plugin** (`FAAAirportStatusPlugin`) — ground stops, ground delay programs, arrival/departure delays, and closures at major US airports from the FAA national feed (`https://nasstatus.faa.gov/`, XML, keyless). Global coverage over a built-in table of ~32 major airports (incl. ATL, JFK, LGA, EWR); emits an alert only when a major airport within `proximityMeters` (default 40km) of the query appears in the feed. Closures→extreme, ground stops→severe, ground/arrival delays scaled by minutes. Adds a `fetchXml` helper to `BasePlugin` (via `fast-xml-parser`) and a `./plugins/airport` export. Unit-tested duration parser.
- **Atlanta Plugins** — Initial coverage for Atlanta, GA (Delta Air Lines main campus / Hartsfield-Jackson airport):
  - `AtlantaCrimePlugin` — NIBRS crime incidents from the Atlanta Police Department Open Data hosted ArcGIS feature layer (`OpenDataWebsite_Crime_view`, updated hourly, includes precise lat/lng). Centered on downtown (33.7490, -84.3880) with a 40km radius that covers the airport ~13km south. Risk mapped from NIBRS offense + `Crime_Against`; firearm-involved incidents are escalated one level. No API key required.
  - `AtlantaTrafficPlugin` — Traffic incidents, closures, and construction from Georgia DOT's 511 system (`https://511ga.org/api/v2/get/event`), 60km radius covering the I-285 perimeter and major interstates. Requires the free `GEORGIA_511_API_KEY` (throttled to 10 calls / 60s); falls back to that env var if `config.apiKey` is not passed.
- **NYC Plugins** — Coverage for New York City:
  - `NYCCrimePlugin` — Felony/misdemeanor/violation complaints from the NYPD via NYC Open Data (Socrata `5uac-w243`, GeoJSON, precise lat/lng). Centered on Manhattan (40.73, -73.99) with a 30km radius covering all five boroughs, the Financial District and Hudson Yards (Manhattan), and JFK (Queens, ~21km SE). Server-side spatial filter via `within_circle`. Risk is the higher of the law-category baseline (FELONY→high, MISDEMEANOR→moderate, VIOLATION→low) and an offense-keyword mapping. Updated quarterly (not a real-time dispatch feed). No API key required.
  - `NYCTrafficPlugin` — Real-time traffic incidents, closures, and construction from NYSDOT's 511NY system (`https://511ny.org/api/getevents`). Same iBI511 vendor schema as GA511 but keyless, with `DD/MM/YYYY` date parsing and `IsFullClosure` inferred from EventType/LanesStatus. Statewide feed filtered to a 30km NYC radius (covers FiDi, Hudson Yards, and the JFK feeder highways — Van Wyck Expressway, Belt Parkway). Complements the quarterly crime data with near-real-time road conditions. No API key required.
- **Package Exports** — Added `AtlantaCrimePlugin` / `AtlantaTrafficPlugin` / `NYCCrimePlugin` / `NYCTrafficPlugin` to `src/plugins/index.ts` and new `./plugins/atlanta` and `./plugins/nyc` modules.
- Test scripts: `scripts/test-atlanta.ts` (pass airport coords `33.6407 -84.4277 8000` to focus on the Delta campus) and `scripts/test-nyc.ts` (tours FiDi, Hudson Yards, JFK with crime + traffic).
- `GEORGIA_511_API_KEY` documented in `.env.example`.

### Notes
- Fire/EMS and events plugins for Atlanta are not yet included: Atlanta Fire Rescue does not publish a public real-time incident feed comparable to Austin/Seattle, and events would route through Ticketmaster (as Phoenix/Glendale do). Both are candidates for a follow-up.
- **Jersey City, NJ has no usable live crime API.** Its open-data portal (`data.jerseycitynj.gov`) only exposes historical snapshots (JCPD calls-for-service tops out at 2017-08-01); the newer "real-time crime portal" is a dashboard not exposed via API. NYPD data does not cover NJ. A Jersey City feed would require scraping the dashboard or another source.
- NYPD complaint data is the freshest citywide open crime source but lags ~one quarter; `NYCTrafficPlugin` (511NY) adds the near-real-time layer. Other NYC complements evaluated and skipped for now: **Notify NYC** emergency notifications (NYC OpenData `8vv7-7wx3`) are ~9 months stale and carry no coordinates; **FDNY incident dispatch** (`8m42-w767`) lags ~one quarter like crime.

## [0.7.0] - 2026-06-13

### Added
- **Generic relative time windows** — `resolveTimeRange` now accepts arbitrary `past-{n}{h|d|w}` / `next-{n}{h|d|w}` windows (e.g. `past-48h`, `next-3d`, `past-2w`), not just the named presets. Exposed as a standalone `parseRelativeRange(value, now?)` helper. Spans are clamped to a 366-day maximum (`MAX_RELATIVE_RANGE_MS`).

### Fixed
- **Unknown time-range no longer crashes downstream queries** — `resolveTimeRangePreset` previously had no `default` branch, so an unrecognized preset returned `undefined` and any downstream read of `.start`/`.end` threw `Cannot read properties of undefined`. It now always returns a valid window. `resolveTimeRange` is hardened end-to-end: unknown strings and malformed explicit ranges fall back to the default window instead of producing `undefined`.

## [0.6.0] - 2026-04-16

### Added
- **Glendale Plugins** - Three new plugins for Glendale, AZ / Tanger Outlets Phoenix coverage:
  - `GlendaleEventsPlugin` - Events from Ticketmaster for the Glendale Sports & Entertainment District (State Farm Stadium, Desert Diamond Arena, Westgate, Camelback Ranch, Topgolf Glendale). Centered on Tanger Outlets Phoenix at 6800 N 95th Ave. State Farm Stadium events rated `high` risk due to 63,400+ capacity crowd/traffic impact.
  - `GlendalePolicePlugin` - Police calls for service from Glendale PD public spatial layer (332K+ records, updated daily). Uses ArcGIS org `9fVTQQSiODPjLUTa`, Layer 47 with spatial envelope filtering.
  - `GlendaleFirePlugin` - Fire and EMS incidents near Glendale from Phoenix Regional Dispatch with spatial bounding-box filtering. Note: Phoenix Fire data only contains city codes PHX/PDV/LAV — Glendale FD calls are not in this dataset, but Phoenix mutual aid responses in the area are captured.
- **Package Exports** - Added `./plugins/glendale` export path
- Glendale test script (`scripts/test-glendale.ts`) for Tanger Outlets Phoenix integration testing with all 4 time windows (past 7d, today, tomorrow, next 7d)
- Known venue coordinates for Glendale entertainment district (Tanger Outlets, State Farm Stadium, Desert Diamond Arena, Westgate, Camelback Ranch, Topgolf)

## [0.5.0] - 2026-01-28

### Added
- **Seattle Plugins** - Three new plugins for Seattle, Washington coverage:
  - `SeattlePolicePlugin` - Police calls for service from SPD Call Data (updated ~hourly, dispatch coordinates blurred to hundred-block level with beat centroid fallback)
  - `SeattleFirePlugin` - Real-time fire dispatch from Seattle Fire 911 Calls (5-minute updates, filtered to fire/hazmat/rescue types)
  - `SeattleEMTPlugin` - Real-time medical/EMS dispatch from Seattle Fire 911 Calls (5-minute updates, filtered to aid/medic/medical types)
- SPD-specific call type abbreviation mappings (ASLT, BURG, ROBB, etc.)
- **Package Exports** - Added `./plugins/seattle` export path
- Seattle test script (`scripts/test-seattle.ts`) for Pike Place Market integration testing
- Raw API sample data in `tests/samples/seattle/`

### Fixed
- Socrata API date queries now strip timezone `Z` suffix to match floating timestamp format

## [0.4.0] - 2026-01-28

### Added
- **Austin Plugins** - Four new plugins for Austin, Texas coverage:
  - `AustinTrafficPlugin` - Real-time traffic incidents (5-minute updates)
  - `AustinFirePlugin` - Real-time fire incidents (5-minute updates)
  - `AustinCrimePlugin` - APD crime reports (~24 hour delay, uses district centroids for privacy-protected data)
  - `AustinEventsPlugin` - Convention center events and special event permits with road closures
- **Plugin Temporal Characteristics** - New `temporal` property on plugin metadata
  - `supportsPast` / `supportsFuture` - Indicates what time ranges the plugin supports
  - `dataLagMinutes` - How delayed the data is from real-time
  - `futureLookaheadMinutes` - How far ahead scheduled data is available
  - `freshnessDescription` - Human-readable description of data freshness
- **Temporal Filtering** - Framework now automatically skips plugins that won't return useful data
  - Plugins are skipped when query time range doesn't match their capabilities
  - Skipped plugins show in `pluginResults` with `skipped: true` and `skipReason`
  - Avoids unnecessary API calls for incompatible time ranges
- **Package Exports** - Added `./plugins/austin` export path

### Changed
- All existing plugins updated with temporal characteristics metadata
- `PluginResultInfo` now includes `skipped` and `skipReason` fields
- Test scripts updated to display temporal info and skipped plugins

## [0.3.0] - 2026-01-23

### Added
- **Bend Police Plugin** (`BendPolicePlugin`) - New plugin for Bend, Oregon police calls for service
  - Uses Bend Police Department ArcGIS service
  - Provides real-time and historical police call data
  - Configurable filtering for low-priority calls
  - Coverage: Bend, Oregon metropolitan area
- **Phoenix Convention Center Plugin** (`PhoenixConventionCenterPlugin`) - New plugin for Phoenix Convention Center events
  - Integrates with Ungerboeck API for convention center events
  - Includes events from Phoenix Convention Center, Orpheum Theatre, and Symphony Hall
  - Provides scheduled event alerts for downtown Phoenix area
  - Configurable venue filtering

### Changed
- **Package Exports** - Added individual plugin export paths for better tree-shaking
  - `./plugins/police` - Exports police-related plugins
  - `./plugins/fire-emt` - Exports fire and EMS plugins
  - `./plugins/events` - Exports event-related plugins
  - `./plugins/weather` - Exports weather plugins
  - `./plugins/traffic` - Exports traffic plugins
  - `./plugins/air-quality` - Exports air quality plugins

## [0.2.3] - 2026-01-23

### Added
- Comprehensive README.md with usage documentation, plugin configuration, cache providers, and examples

## [0.2.2] - 2026-01-23

### Changed
- **Cache providers are now fully interface-based** - Removed peer dependencies on `@vercel/kv` and `@aws-sdk/*`
  - `VercelKVCacheProvider` and `DynamoDBCacheProvider` now accept any object matching the interface
  - Host applications pass their own SDK instances, avoiding version conflicts
  - `InMemoryCacheProvider` remains the zero-dependency default

## [0.2.1] - 2026-01-23

### Added
- **NIFC Wildfires Plugin** - New plugin for national wildfire data from National Interagency Fire Center (NIFC)
  - Covers all active wildfires across the United States
  - Includes fire size, containment percentage, and cause information
  - Configurable to include/exclude prescribed burns

### Changed
- **Phoenix Fire Plugin** - Completely rewritten to use Phoenix Fire Department's ArcGIS service
  - Now uses live data (~1-2 days old) instead of the discontinued Socrata API
  - Includes both Fire and EMS incidents
  - Configurable EMS and service call filtering
- **Phoenix Events Plugin** - Simplified to use only Ticketmaster API
  - Removed discontinued Phoenix permits data source
  - Requires Ticketmaster API key for operation
- **Arizona Traffic Plugin** - Updated to use new ADOT ArcGIS endpoint
  - Consolidated multiple endpoints into single traffic events feed

### Removed
- **Phoenix Police Plugin** - Removed due to Phoenix Open Data discontinuing the Socrata API
- **Pulsepoint Plugin** - Removed due to API now requiring authentication

### Fixed
- Alert deduplication no longer produces duplicate entries
- Date filtering now works correctly with Phoenix Fire ArcGIS service

## [0.1.0] - 2026-01-22

### Added
- Initial release
- Core alert aggregation framework with plugin system
- Built-in plugins:
  - NWS Weather (National Weather Service alerts)
  - Phoenix Fire Department
  - Phoenix Police Department
  - Phoenix Events (Ticketmaster + city permits)
  - Pulsepoint (real-time fire/EMS)
  - Arizona Traffic
  - AirNow (air quality, requires API key)
  - Phoenix Convention Center
- Lambda and Vercel serverless adapters
- In-memory, Vercel KV, and DynamoDB cache providers
- Geo utilities for distance calculations and coverage filtering
- TypeScript support with full type definitions
