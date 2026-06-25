import type {
  PluginFetchOptions,
  PluginFetchResult,
  RiskLevel,
  GeoPoint,
  Alert,
} from '../../types';
import { BasePlugin, BasePluginConfig } from '../base-plugin';

/**
 * Raw per-cell aggregate produced by a subclass's materialize step.
 */
export interface CellStat {
  /** Cell identifier (grid id, zip, beat, etc.) */
  cellId: string;
  /** Incident counts keyed by source category */
  byCategory: Record<string, number>;
}

/** A cell's severity bucket. */
export type CellSeverity = 'violent' | 'property' | 'other';

/**
 * A scored cell: raw counts plus the derived metric and its citywide
 * percentile rank (0-100).
 */
export interface ScoredCell {
  cellId: string;
  total: number;
  violent: number;
  property: number;
  other: number;
  byCategory: Record<string, number>;
  /** The ranking metric (weighted; violent counts more). */
  metric: number;
  /** Percentile rank of `metric` across the full cell universe (0-100). */
  percentile: number;
}

/**
 * Score a set of cells: classify each category, compute a weighted metric, and
 * rank every cell's metric into a percentile across the full cell universe
 * (including cells with no incidents, via `universeSize`). Pure — exported for
 * testing.
 */
export function scoreCells(
  cells: CellStat[],
  opts: {
    severityOf: (category: string) => CellSeverity;
    universeSize: number;
    /** Weighted ranking metric. Default: violent*3 + property + other*0.5 */
    metricOf?: (c: { violent: number; property: number; other: number; total: number }) => number;
  }
): ScoredCell[] {
  const metricOf = opts.metricOf ?? ((c) => c.violent * 3 + c.property + c.other * 0.5);
  const universe = Math.max(opts.universeSize, cells.length);

  const partial = cells.map((c) => {
    let violent = 0;
    let property = 0;
    let other = 0;
    for (const [cat, n] of Object.entries(c.byCategory)) {
      const bucket = opts.severityOf(cat);
      if (bucket === 'violent') violent += n;
      else if (bucket === 'property') property += n;
      else other += n;
    }
    const total = violent + property + other;
    const metric = metricOf({ violent, property, other, total });
    return { ...c, total, violent, property, other, metric };
  });

  // Percentile across the full universe: cells absent from `cells` have metric 0.
  const zeroCells = universe - partial.length;
  const metricsAsc = partial.map((p) => p.metric).sort((a, b) => a - b);

  const lessThan = (m: number): number => {
    // count of materialized cells with metric < m (binary search on sorted asc)
    let lo = 0;
    let hi = metricsAsc.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (metricsAsc[mid] < m) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };

  return partial.map((p) => {
    // zero-metric universe cells rank below any positive metric cell
    const below = (p.metric > 0 ? zeroCells : 0) + lessThan(p.metric);
    const percentile = universe > 0 ? Math.round((below / universe) * 100) : 0;
    return { ...p, percentile };
  });
}

/**
 * Map a percentile rank to a relative risk level. Exported for testing.
 */
export function percentileToRisk(percentile: number): RiskLevel {
  if (percentile >= 97) return 'extreme';
  if (percentile >= 90) return 'severe';
  if (percentile >= 75) return 'high';
  if (percentile >= 50) return 'moderate';
  return 'low';
}

/**
 * Cached, scored snapshot of the whole area.
 */
interface ScoredSnapshot {
  version: string;
  fetchedAtMs: number;
  byCell: Map<string, ScoredCell>;
  /** Citywide context for descriptions. */
  context: { medianMetric: number; p90Metric: number; cellsWithIncidents: number; universeSize: number };
}

export interface BaselineRiskPluginConfig extends BasePluginConfig {
  /**
   * How long (ms) to trust a cached snapshot before re-checking the dataset
   * version. Default: 1 hour. The data changes rarely, so this keeps the
   * version probe off the hot path.
   */
  versionCheckTtlMs?: number;
}

/**
 * Abstract base for "baseline risk" plugins: sources that publish rarely-
 * changing, cell-quantized historical data (e.g. crime by grid cell). Instead
 * of emitting many discrete incidents, the plugin materializes the whole area
 * once, scores every cell relative to the rest (percentile rank), caches the
 * snapshot keyed by the dataset version, and emits a single summary {@link Alert}
 * per query location — carrying the relative tier in `riskLevel` and the full
 * breakdown in `metadata`.
 *
 * This is a normal {@link BasePlugin}/AlertPlugin — it changes how alerts are
 * produced, not the interface.
 */
export abstract class BaselineRiskPlugin extends BasePlugin {
  protected baselineConfig: BaselineRiskPluginConfig;
  private snapshot: ScoredSnapshot | null = null;

  constructor(config?: BaselineRiskPluginConfig) {
    super(config);
    this.baselineConfig = { versionCheckTtlMs: 60 * 60 * 1000, ...config };
  }

  // --- subclass contract -------------------------------------------------

  /** Cheap probe returning the current dataset version (e.g. last_modified). */
  protected abstract getDatasetVersion(): Promise<string>;

  /** Expensive: materialize per-cell incident counts for the whole area. */
  protected abstract materializeCells(): Promise<CellStat[]>;

  /** Total number of cells in the universe (incl. zero-incident cells). */
  protected abstract getUniverseSize(): number;

  /** Classify a source category into a severity bucket. */
  protected abstract severityOf(category: string): CellSeverity;

  /** Resolve a query point to its home cell and surrounding vicinity cells. */
  protected abstract resolveQueryCells(
    point: GeoPoint,
    radiusMeters: number
  ): { home?: string; vicinity: string[] };

  /** Centroid of a cell, for placing the summary alert. */
  protected abstract cellCentroid(cellId: string): GeoPoint | undefined;

  /** Human label + units for the materialized window (e.g. "all-time since 2015"). */
  protected abstract windowLabel(): string;

  // --- shared pipeline ---------------------------------------------------

  async fetchAlerts(options: PluginFetchOptions): Promise<PluginFetchResult> {
    const { location, radiusMeters } = options;
    const warnings: string[] = [];

    try {
      const snap = await this.ensureSnapshot(warnings);
      if (!snap) {
        return { alerts: [], warnings: warnings.length ? warnings : undefined };
      }

      const { home, vicinity } = this.resolveQueryCells(location, radiusMeters);
      const cellIds = Array.from(new Set([...(home ? [home] : []), ...vicinity]));
      const scored = cellIds.map((id) => snap.byCell.get(id)).filter((c): c is ScoredCell => !!c);

      if (scored.length === 0) {
        // Within coverage but no cell data here — emit nothing.
        return { alerts: [], warnings: warnings.length ? warnings : undefined };
      }

      const alert = this.buildSummaryAlert(options, home, scored, snap);
      return { alerts: [alert], warnings: warnings.length ? warnings : undefined };
    } catch (error) {
      console.error(`${this.metadata.name} fetch error:`, error);
      throw error;
    }
  }

  /**
   * Ensure a fresh scored snapshot, re-materializing only when the dataset
   * version changed (checked at most once per versionCheckTtlMs).
   */
  private async ensureSnapshot(warnings: string[]): Promise<ScoredSnapshot | null> {
    const now = Date.now();
    const ttl = this.baselineConfig.versionCheckTtlMs ?? 60 * 60 * 1000;

    if (this.snapshot && now - this.snapshot.fetchedAtMs < ttl) {
      return this.snapshot;
    }

    let version: string;
    try {
      version = await this.getDatasetVersion();
    } catch {
      // Version probe failed — keep serving a stale snapshot if we have one.
      if (this.snapshot) {
        this.snapshot.fetchedAtMs = now; // back off re-probing for another ttl
        return this.snapshot;
      }
      version = 'unknown';
    }

    if (this.snapshot && this.snapshot.version === version) {
      this.snapshot.fetchedAtMs = now;
      return this.snapshot;
    }

    const cells = await this.materializeCells();
    if (!cells.length) {
      warnings.push(`${this.metadata.name}: no cell data materialized.`);
      return this.snapshot; // may be null
    }

    const scored = scoreCells(cells, {
      severityOf: (c) => this.severityOf(c),
      universeSize: this.getUniverseSize(),
    });
    const byCell = new Map(scored.map((s) => [s.cellId, s]));
    const metricsAsc = scored.map((s) => s.metric).sort((a, b) => a - b);
    const median = metricsAsc.length ? metricsAsc[Math.floor(metricsAsc.length / 2)] : 0;
    const p90 = metricsAsc.length ? metricsAsc[Math.floor(metricsAsc.length * 0.9)] : 0;

    this.snapshot = {
      version,
      fetchedAtMs: now,
      byCell,
      context: {
        medianMetric: median,
        p90Metric: p90,
        cellsWithIncidents: scored.length,
        universeSize: this.getUniverseSize(),
      },
    };
    return this.snapshot;
  }

  private buildSummaryAlert(
    options: PluginFetchOptions,
    home: string | undefined,
    scored: ScoredCell[],
    snap: ScoredSnapshot
  ): Alert {
    // Relative tier from the home cell (fallback: highest-percentile vicinity cell).
    const homeCell = home ? snap.byCell.get(home) : undefined;
    const refCell = homeCell ?? scored.reduce((a, b) => (b.percentile > a.percentile ? b : a));
    const percentile = refCell.percentile;
    const riskLevel = percentileToRisk(percentile);

    // Vicinity absolute totals.
    const totals = scored.reduce(
      (acc, c) => {
        acc.total += c.total;
        acc.violent += c.violent;
        acc.property += c.property;
        acc.other += c.other;
        for (const [cat, n] of Object.entries(c.byCategory)) acc.byCategory[cat] = (acc.byCategory[cat] ?? 0) + n;
        return acc;
      },
      { total: 0, violent: 0, property: 0, other: 0, byCategory: {} as Record<string, number> }
    );
    const topCategories = Object.entries(totals.byCategory)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([cat, n]) => ({ category: cat, count: n }));

    const point = (home && this.cellCentroid(home)) || options.location;
    const tierWord = riskLevel.charAt(0).toUpperCase() + riskLevel.slice(1);

    return this.createAlert({
      id: `${this.metadata.id}-${point.latitude.toFixed(4)},${point.longitude.toFixed(4)}`,
      title: `Crime risk: ${tierWord} area (${percentile}th percentile)`,
      description: this.buildDescription(percentile, totals, topCategories, scored.length, snap),
      riskLevel,
      priority: this.riskLevelToPriority(riskLevel),
      category: 'crime',
      temporalType: 'historical',
      location: { point },
      timestamps: { issued: new Date().toISOString() },
      metadata: {
        kind: 'baseline-summary',
        datasetVersion: snap.version,
        window: this.windowLabel(),
        homeCell: home,
        homePercentile: homeCell?.percentile,
        referencePercentile: percentile,
        vicinityCells: scored.length,
        totals: { total: totals.total, violent: totals.violent, property: totals.property, other: totals.other },
        byCategory: totals.byCategory,
        topCategories,
        citywide: snap.context,
      },
    });
  }

  private buildDescription(
    percentile: number,
    totals: { total: number; violent: number; property: number },
    top: Array<{ category: string; count: number }>,
    cellCount: number,
    snap: ScoredSnapshot
  ): string {
    const parts: string[] = [];
    parts.push(
      `This area ranks in the ${percentile}th percentile for crime among ${snap.context.universeSize} ${this.metadata.name} cells.`
    );
    parts.push(
      `Vicinity (${cellCount} cell${cellCount === 1 ? '' : 's'}, ${this.windowLabel()}): ${totals.total} incidents — ${totals.violent} violent, ${totals.property} property.`
    );
    if (top.length) {
      parts.push('Top categories: ' + top.map((t) => `${t.category} (${t.count})`).join(', '));
    }
    return parts.join('\n');
  }
}
