# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added
- **Plugin federation — runtime-extensible, out-of-process plugins.** Plugins can now live behind HTTP endpoints (ours or third parties') that the framework discovers and calls at runtime, with **no rebuild or republish**. Everything is a remote endpoint, including our own plugins; the host owns caching/retries/timeouts/aggregation/telemetry and the endpoint is a stateless call-out. Design in `architecture/plugin-federation.md`.
  - **Wire contract (`./contract`)** — versioned Zod schemas (`PluginManifestSchema`, `PluginFetchOptionsSchema`, `PluginFetchResultSchema`) + `CONTRACT_VERSION`, reusing the existing `AlertSchema`. URLs are unversioned; the contract version travels in the manifest. Control-plane `GET {endpoint}/manifest` (cached, drives the resolver) vs data-plane `POST {endpoint}/alerts` (only on applicable + cache-miss).
  - **Host side (`./federation`)** — `RemotePlugin` (an ordinary `AlertPlugin`, so the existing registry/resolver/aggregator pipeline is unchanged and local + remote coexist), `FederationClient` (signing, timeouts, response validation, undici keep-alive with injectable `fetchImpl`), and the storage seams `RegistrationStore` / `CredentialResolver` with dev defaults (`StaticRegistrationStore`, `EnvCredentialResolver`) plus `loadRemotePlugins()` → `PluginRegistration[]`. Adding a plugin is adding a catalog row.
  - **Server side (`./adapters/plugin-service`)** — `createPluginServiceHandler([...plugins])`: one Lambda serves many plugins, each on its own `/plugins/{id}/{manifest|alerts}` route, with per-plugin auth verification. An endpoint is a route, not a deployment, so re-segmenting plugins across deployments is a config change.
  - **Auth** — Stripe/GitHub-webhook model: per-request **bearer token + HMAC-SHA256 signature** (`t=…,v1=…`, `timestamp . method . canonicalPath . body`) with a replay window, on by default (no manifest `auth` field in v1). Signed path is derived from `(id, action)` so stage prefixes don't break verification. Round-trip + tamper/replay/wrong-secret tests included.
  - **Lambda host wiring** — `createLambdaHandler` accepts a `remotePlugins` option (`{ store, credentials, client?, manifestTtlMs? }`) and loads federated plugins at cold start alongside static ones. Registration now runs through a single awaited `ready` promise, so the first request can't race an unfinished registration (also removes a latent double-registration with the `AlertFeed` constructor).
  - **Manifest TTL refresh** — `RemotePlugin` takes `manifestTtlMs`: after the TTL expires, the manifest is lazily re-fetched on the next `fetchAlerts` so coverage/metadata stay current across a warm container. Best-effort — a failed refresh logs and keeps the last-known-good metadata, so a transient manifest hiccup never fails a query. Threaded through `loadRemotePlugins`; covered by a clock-driven test.
  - **Vercel host wiring** — `createVercelHandler` gains the same `remotePlugins` option and single awaited `ready` registration path as the Lambda adapter, so federated plugins load at startup alongside static ones on Next.js App Router routes.

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
