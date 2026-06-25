import type { PluginMetadata, GeoPoint } from '../../types';
import { BaselineRiskPlugin, BaselineRiskPluginConfig, CellStat, CellSeverity } from '../baseline';
import { PHOENIX_GRID } from './phoenix-grid';

const RESOURCE_ID = '0ce3411a-2fc6-4302-a33f-167f68608a20';
const SQL_URL = 'https://www.phoenixopendata.com/api/3/action/datastore_search_sql';
const RESOURCE_SHOW_URL = `https://www.phoenixopendata.com/api/3/action/resource_show?id=${RESOURCE_ID}`;

/** Phoenix UCR category -> severity bucket. */
const VIOLENT = new Set([
  'MURDER AND NON-NEGLIGENT MANSLAUGHTER',
  'RAPE',
  'ROBBERY',
  'AGGRAVATED ASSAULT',
  'SIMPLE ASSAULT',
]);
const PROPERTY = new Set(['BURGLARY', 'LARCENY-THEFT', 'MOTOR VEHICLE THEFT', 'ARSON']);

interface CkanResourceShow {
  success: boolean;
  result?: { last_modified?: string; metadata_modified?: string };
}
interface CkanSqlResponse {
  success: boolean;
  result?: { records: Array<{ g: string; c: string; n: string }> };
}

export interface PhoenixCrimeRiskPluginConfig extends BaselineRiskPluginConfig {
  /** Vicinity radius (m) used when a query doesn't specify one. Default: 1 mile. */
  defaultRadiusMeters?: number;
}

/**
 * Baseline crime-risk plugin for Phoenix, AZ.
 *
 * Materializes the City of Phoenix open crime dataset (624k+ incidents,
 * Nov 2015→present) aggregated per police grid cell (~0.25 mi² each), scores
 * every cell's relative risk (percentile rank across all 2,426 cells), caches
 * the snapshot keyed by the dataset's `last_modified`, and emits a single
 * summary {@link import('../../types').Alert} per query location with the
 * relative tier in `riskLevel` and the full breakdown in `metadata`.
 *
 * The dataset is published in infrequent batches (currently lagging months), so
 * this is a baseline/contextual risk layer, not a real-time incident feed.
 *
 * @see https://www.phoenixopendata.com/dataset/crime-data
 */
export class PhoenixCrimeRiskPlugin extends BaselineRiskPlugin {
  readonly metadata: PluginMetadata = {
    id: 'phoenix-crime-risk',
    name: 'Phoenix Crime Risk (baseline)',
    version: '1.0.0',
    description: 'Relative crime-risk score per area from City of Phoenix open crime data',
    coverage: {
      type: 'regional',
      center: { latitude: 33.4484, longitude: -112.074 },
      radiusMeters: 60_000,
      description: 'Phoenix, AZ metropolitan area (police grid)',
    },
    temporal: {
      supportsPast: true,
      supportsFuture: false,
      dataLagMinutes: 60 * 24 * 30, // batch-published, lags weeks-to-months
      freshnessDescription: 'Historical baseline; dataset published in batches',
    },
    supportedTemporalTypes: ['historical'],
    supportedCategories: ['crime'],
    refreshIntervalMs: 24 * 60 * 60 * 1000,
    defaultRadiusMeters: 1_609, // 1 mile vicinity
  };

  protected getUniverseSize(): number {
    return Object.keys(PHOENIX_GRID).length;
  }

  protected severityOf(category: string): CellSeverity {
    const c = (category ?? '').toUpperCase().trim();
    if (VIOLENT.has(c)) return 'violent';
    if (PROPERTY.has(c)) return 'property';
    return 'other';
  }

  protected windowLabel(): string {
    return 'all-time (since Nov 2015)';
  }

  protected async getDatasetVersion(): Promise<string> {
    const res = await this.fetchJson<CkanResourceShow>(RESOURCE_SHOW_URL);
    return res.result?.last_modified ?? res.result?.metadata_modified ?? 'unknown';
  }

  protected async materializeCells(): Promise<CellStat[]> {
    const sql = `SELECT "GRID" g, "UCR CRIME CATEGORY" c, count(*) n FROM "${RESOURCE_ID}" WHERE "GRID" IS NOT NULL GROUP BY "GRID", "UCR CRIME CATEGORY"`;
    const url = `${SQL_URL}?sql=${encodeURIComponent(sql)}`;
    const res = await this.fetchJson<CkanSqlResponse>(url);
    if (!res.success || !res.result) return [];

    const byCell = new Map<string, Record<string, number>>();
    for (const row of res.result.records) {
      const cell = row.g;
      if (!cell) continue;
      const cats = byCell.get(cell) ?? {};
      cats[row.c] = (cats[row.c] ?? 0) + Number(row.n);
      byCell.set(cell, cats);
    }
    return Array.from(byCell.entries()).map(([cellId, byCategory]) => ({ cellId, byCategory }));
  }

  protected resolveQueryCells(point: GeoPoint, radiusMeters: number): { home?: string; vicinity: string[] } {
    let home: string | undefined;
    const vicinity: string[] = [];
    const r = radiusMeters || this.metadata.defaultRadiusMeters || 1_609;

    for (const [id, box] of Object.entries(PHOENIX_GRID)) {
      const [clat, clng, minLng, minLat, maxLng, maxLat] = box;
      if (!home && point.longitude >= minLng && point.longitude <= maxLng && point.latitude >= minLat && point.latitude <= maxLat) {
        home = id;
      }
      if (this.haversine(point.latitude, point.longitude, clat, clng) <= r) {
        vicinity.push(id);
      }
    }
    return { home, vicinity };
  }

  protected cellCentroid(cellId: string): GeoPoint | undefined {
    const box = PHOENIX_GRID[cellId];
    return box ? { latitude: box[0], longitude: box[1] } : undefined;
  }

  private haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6371e3;
    const φ1 = (lat1 * Math.PI) / 180;
    const φ2 = (lat2 * Math.PI) / 180;
    const Δφ = ((lat2 - lat1) * Math.PI) / 180;
    const Δλ = ((lon2 - lon1) * Math.PI) / 180;
    const a = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }
}
