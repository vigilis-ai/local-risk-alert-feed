# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

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
