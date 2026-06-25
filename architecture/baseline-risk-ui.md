# Baseline Risk Scoring — SDK & UI Guidance

How to surface **site-level risk** and **area baseline** (relative, not just
absolute) from the feed, render a **risk map**, and overlay/contrast it with the
existing real-time risk map and a historical data table.

This is delivered **inside the existing plugin model** — baseline risk is a
normal `AlertPlugin` (`BaselineRiskPlugin`) that emits ordinary `Alert`s. There
is no separate risk-scoring framework or pipeline.

---

## 1. Two flavors of `Alert`, one interface

| | Incident alerts | Baseline-risk summary |
|---|---|---|
| Source | real-time/historical feeds (crime, traffic, MTA…) | `BaselineRiskPlugin` (e.g. `PhoenixCrimeRiskPlugin`) |
| Cardinality | many (one per incident) | **one per query location** |
| `temporalType` | `real-time` / `scheduled` / `historical` | `historical` |
| `riskLevel` | severity of that incident | **relative percentile tier** of the area |
| Discriminator | `metadata.kind` absent | `metadata.kind === 'baseline-summary'` |

A consumer tells them apart by `metadata.kind`. Everything else is a normal
`Alert` (`riskLevel`, `priority`, `category`, `location.point`, `metadata`).

```ts
import type { BaselineSummaryMetadata } from '@vigilisai/local-risk-alert-feed';

for (const alert of response.alerts) {
  if (alert.metadata?.kind === 'baseline-summary') {
    const m = alert.metadata as unknown as BaselineSummaryMetadata;
    renderRiskBadge(alert.riskLevel, m);     // area baseline summary
  } else {
    renderIncidentPin(alert);                // discrete incident
  }
}
```

---

## 2. Site-level risk score vs area baseline

The score is **relative**: a cell's percentile rank against the whole city's
grid (incl. zero-incident cells). `riskLevel` is the tier; the exact percentile
and the absolute counts live in `metadata`.

`percentileToRisk`: `≥97 extreme · ≥90 severe · ≥75 high · ≥50 moderate · <50 low`.

```ts
const m = alert.metadata as unknown as BaselineSummaryMetadata;

// Headline (relative): "Higher crime than 96% of Phoenix"
`Risk: ${alert.riskLevel} — ${m.referencePercentile}th percentile`;

// Site cell vs surrounding vicinity
m.homeCell;            // the grid cell the site sits in
m.homePercentile;      // that cell's rank (the most site-specific number)
m.vicinityCells;       // cells aggregated for the totals below (~1 mi)

// Absolute context (window in m.window, e.g. "all-time since 2015")
m.totals;              // { total, violent, property, other }
m.topCategories;       // [{ category, count }, …]
m.citywide;            // { medianMetric, p90Metric, universeSize, … }
```

**UI recommendation — show both:**
- **Relative** is the headline ("96th percentile / High area"), because absolute
  counts mislead across cities and time windows.
- **Absolute** is the supporting detail ("726 violent incidents within 1 mi,
  *window*"). Always print `m.window` next to absolute counts — it is **not**
  necessarily last-12-months (Phoenix is currently all-time since 2015).

A compact site card:

```
┌ 1 N 1 — Phoenix ───────────────────────────┐
│  ● HIGH AREA            96th pct (cell BA28) │
│  Higher crime than 96% of Phoenix           │
│  Nearby (1 mi, all-time): 2,081  ▸ 625 viol │
│  Top: Larceny 1050 · Agg Assault 253 · …    │
└─────────────────────────────────────────────┘
```

---

## 3. Risk map (area choropleth / heatmap)

Per-location summaries aren't enough to paint a map — use `getRiskSurface()`,
which returns **every scored cell** from the same cached snapshot.

```ts
import { PhoenixCrimeRiskPlugin } from '@vigilisai/local-risk-alert-feed/plugins/phoenix-crime';

const plugin = new PhoenixCrimeRiskPlugin();
const { version, window, cells } = await plugin.getRiskSurface();
// cells: { cellId, centroid:{lat,lng}, percentile, riskLevel, total, violent, property }[]
```

Two render paths:

- **Choropleth (preferred):** join `cell.cellId` to the source's published cell
  geometry by id. For Phoenix that's the police-grid GeoJSON `GRID_NUMBER`
  (`phoenixopendata.com` → Police Crime Grid). Fill each polygon by
  `riskLevel`/`percentile`.
- **Heatmap / no extra fetch:** use `cell.centroid` directly (e.g.
  `leaflet.heat`, weight = `percentile` or `violent`). Good when you don't want
  to ship the polygon geometry.

```ts
// Leaflet choropleth sketch
const tier = { low:'#2c7bb6', moderate:'#abd9e9', high:'#fdae61', severe:'#d7191c', extreme:'#7f0000' };
const byId = new Map(cells.map(c => [c.cellId, c]));
L.geoJSON(gridGeoJson, {
  style: f => {
    const c = byId.get(f.properties.GRID_NUMBER);
    return { fillColor: c ? tier[c.riskLevel] : '#eee', fillOpacity: 0.5, weight: 0 };
  },
  onEachFeature: (f, layer) => {
    const c = byId.get(f.properties.GRID_NUMBER);
    if (c) layer.bindPopup(`${c.cellId}: ${c.riskLevel} (${c.percentile}th) — ${c.violent} violent`);
  },
});
```

**Colour by relative tier, not raw counts** — that's the whole point of the
percentile model and keeps the legend comparable across cities.

---

## 4. Overlay / contrast with the existing real-time risk map

The baseline surface is a **background layer**; real-time incidents are the
**foreground**. Keep them as distinct Leaflet layers so they can be toggled:

```
Layer order (bottom → top):
  1. Baseline risk choropleth   (getRiskSurface, historical, slow-changing)
  2. Real-time incident pins     (incident Alerts, metadata.kind absent)
  3. Site markers + their baseline-summary badge (per-site Alert)
```

- **Filter the two streams by `metadata.kind`** (§1) — baseline-summary feeds
  the choropleth + site badges; everything else feeds pins.
- **Contrast view:** a toggle/opacity slider between "baseline" and "live", or a
  split-pane (baseline left, live right). Because both share the same map
  projection and the baseline is just a polygon/heat layer, this is a rendering
  toggle — no data plumbing changes.
- **"Why is this site High?"** click a site badge → highlight its `homeCell`
  polygon on the baseline layer and list `topCategories`.

---

## 5. Table rendering of historical data

The summary `metadata` already carries everything a table needs — no extra call.

Per-site row:

| Site | Area tier | Pctile | Nearby (window) | Violent | Property | Top category |
|---|---|--:|--:|--:|--:|---|
| 1 N 1 | High | 96 | 2,081 | 625 | 1,338 | Larceny-Theft (1050) |

Category breakdown (drill-down) from `m.byCategory` / `m.topCategories`:

```ts
Object.entries(m.byCategory)
  .sort((a, b) => b[1] - a[1])
  .map(([category, count]) => ({ category, count }));
```

Guidance:
- Sort the **site list** by `referencePercentile` (relative) for "which sites
  are in the worst areas," not by absolute count.
- Always show the **window** column header (`m.window`) and the
  **dataset version/date** (`m.datasetVersion`) so stale baselines are obvious.
- For an area table (not site-keyed), iterate `getRiskSurface().cells`.

---

## 6. Backend caching / refresh

The plugin already does this; the backend just needs to call it periodically.

- `getRiskSurface()` / `fetchAlerts()` materialize the whole grid **once** per
  dataset version, then serve from an in-memory snapshot. First call ≈ 0.8–1.3s;
  warm calls are sub-millisecond.
- The snapshot is keyed by the dataset's version (`datasetVersion`), re-checked
  at most once per `versionCheckTtlMs` (default 1h). For a long-lived backend,
  hold one plugin instance and let it self-refresh; or call `getRiskSurface()`
  on a cron and cache the result (~0.5 MB for Phoenix).
- To persist across restarts, store the `getRiskSurface()` output keyed by
  `version`; re-pull only when `version` changes (rare).

---

## 7. SDK reference

From `@vigilisai/local-risk-alert-feed` (and `/plugins/baseline`):

- `BaselineRiskPlugin` — abstract base; subclass to add a source.
- `PhoenixCrimeRiskPlugin` — first concrete source (in `createDefaultPlugins()`).
- `BaselineRiskPlugin#getRiskSurface()` → `{ version, window, cells: RiskSurfaceCell[] }`.
- `BaselineSummaryMetadata` — narrow `alert.metadata` when `kind === 'baseline-summary'`.
- `RiskSurfaceCell` — `{ cellId, centroid?, percentile, riskLevel, total, violent, property }`.
- `percentileToRisk(p)` / `scoreCells(...)` — pure scoring helpers.

### Adding another baseline source
Subclass `BaselineRiskPlugin` and implement: `getDatasetVersion`,
`materializeCells`, `getUniverseSize`, `severityOf`, `resolveQueryCells`,
`cellCentroid`, `windowLabel`. Scoring, caching, the summary `Alert`, and
`getRiskSurface` come from the base. (Atlanta/NYC crime are natural next ones —
NYC would key cells by precinct or by rounding lat/lng to a grid.)
