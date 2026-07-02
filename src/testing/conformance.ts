/**
 * Plugin conformance suite — the certification harness a plugin author (ours or
 * a third party) runs to prove a plugin is functional and speaks the contract.
 *
 * Runner-agnostic: it returns a structured {@link ConformanceReport} (no test
 * framework required), so it can back a CLI, CI, or a vitest/jest wrapper.
 *
 * Two modes, same checks:
 *  - **SDK-object** — pass a `plugin` instance (for authors using this SDK's
 *    `BasePlugin` / `AlertPlugin` in TypeScript).
 *  - **Endpoint** — pass an `endpoint` + `credentials`; the suite wraps it in a
 *    {@link RemotePlugin} and drives `/manifest` + `/alerts` over HTTP, and also
 *    verifies the endpoint enforces auth. Works for any language.
 */
import type { AlertPlugin, PluginFetchOptions, GeoPoint, TimeRange } from '../types';
import { PluginMetadataSchema, PluginFetchResultSchema, canonicalPath } from '../contract';
import {
  RemotePlugin,
  FederationClient,
  computeSignature,
  joinUrl,
  type PluginCredentials,
} from '../federation';
import { calculateDistance } from '../geo';

export type CheckSeverity = 'error' | 'warning';

export interface CheckResult {
  name: string;
  passed: boolean;
  severity: CheckSeverity;
  detail?: string;
}

export interface ConformanceReport {
  /** True when no `error`-severity check failed (warnings do not fail). */
  passed: boolean;
  checks: CheckResult[];
}

export interface ConformanceOptions {
  /** SDK-object mode: the plugin instance to test. */
  plugin?: AlertPlugin;

  /** Endpoint mode: base endpoint URL (routes are `{endpoint}/plugins/{id}/…`). */
  endpoint?: string;
  /** Endpoint mode: the plugin id. */
  pluginId?: string;
  /** Endpoint mode: bearer token + signing secret. */
  credentials?: PluginCredentials;
  /** Endpoint mode: shared client; built from `fetchImpl` if omitted. */
  client?: FederationClient;
  /** Endpoint mode: injectable fetch for the client + raw auth probes (default global fetch). */
  fetchImpl?: typeof fetch;
  /** Endpoint mode: run auth-enforcement probes (default true). */
  checkAuth?: boolean;

  /** Query used for the fetch checks; sensible defaults are derived from the manifest. */
  sampleQuery?: Partial<Pick<PluginFetchOptions, 'location' | 'radiusMeters' | 'timeRange' | 'limit'>>;
  /** Fallback location for global plugins with no coverage center (default: downtown Phoenix). */
  defaultLocation?: GeoPoint;
  /** Injectable clock (testing). */
  now?: () => number;
}

const DEFAULT_LOCATION: GeoPoint = { latitude: 33.4484, longitude: -112.074 };

/**
 * Run the conformance suite and return a structured report. Never throws for a
 * failing plugin — failures are captured as checks; it only rejects on a usage
 * error (e.g. neither `plugin` nor `endpoint` provided).
 */
export async function runConformanceSuite(
  options: ConformanceOptions
): Promise<ConformanceReport> {
  const checks: CheckResult[] = [];
  const now = options.now ?? (() => Date.now());
  const add = (name: string, passed: boolean, severity: CheckSeverity, detail?: string) =>
    checks.push({ name, passed, severity, detail });

  const isEndpoint = !!options.endpoint;
  if (!options.plugin && !isEndpoint) {
    throw new Error('runConformanceSuite: provide either `plugin` or `endpoint`');
  }

  // ---- Resolve the plugin under test (loads + validates the manifest) --------
  let plugin: AlertPlugin;
  if (isEndpoint) {
    if (!options.pluginId || !options.credentials) {
      throw new Error('runConformanceSuite: endpoint mode requires `pluginId` and `credentials`');
    }
    const client =
      options.client ?? new FederationClient({ fetchImpl: options.fetchImpl });
    const remote = new RemotePlugin({
      id: options.pluginId,
      endpoint: options.endpoint!,
      credentials: options.credentials,
      client,
    });
    try {
      await remote.initialize();
      add('manifest.reachable', true, 'error');
    } catch (err) {
      add('manifest.reachable', false, 'error', errMsg(err));
      return finalize(checks); // can't proceed without a manifest
    }
    plugin = remote;
  } else {
    plugin = options.plugin!;
    try {
      if (plugin.initialize) await plugin.initialize();
      add('manifest.reachable', true, 'error');
    } catch (err) {
      add('manifest.reachable', false, 'error', errMsg(err));
      return finalize(checks);
    }
  }

  const meta = plugin.metadata;

  // ---- Manifest / metadata validity -----------------------------------------
  const metaParse = PluginMetadataSchema.safeParse(meta);
  add('manifest.schemaValid', metaParse.success, 'error', metaParse.success ? undefined : issues(metaParse));

  if (isEndpoint && options.pluginId) {
    add('manifest.idMatches', meta.id === options.pluginId, 'error', `manifest id "${meta.id}"`);
  }
  add('manifest.hasCategories', meta.supportedCategories.length > 0, 'error');
  add('manifest.hasTemporalTypes', meta.supportedTemporalTypes.length > 0, 'error');

  // Coverage coherence
  if (meta.coverage.type === 'regional') {
    const ok = meta.coverage.center != null && meta.coverage.radiusMeters != null;
    add('coverage.regionalHasCenterRadius', ok, 'error');
  } else {
    add('coverage.regionalHasCenterRadius', true, 'error');
  }
  // Temporal coherence (advisory)
  if (meta.temporal.supportsPast) {
    add('temporal.pastHasDataLag', meta.temporal.dataLagMinutes != null, 'warning');
  }
  if (meta.temporal.supportsFuture) {
    add('temporal.futureHasLookahead', meta.temporal.futureLookaheadMinutes != null, 'warning');
  }
  add(
    'temporal.supportsSomething',
    meta.temporal.supportsPast || meta.temporal.supportsFuture,
    'error'
  );

  // ---- coversLocation --------------------------------------------------------
  const insidePoint =
    options.sampleQuery?.location ?? meta.coverage.center ?? options.defaultLocation ?? DEFAULT_LOCATION;
  try {
    add('coversLocation.inside', plugin.coversLocation(insidePoint) === true, 'error');
  } catch (err) {
    add('coversLocation.inside', false, 'error', errMsg(err));
  }
  if (meta.coverage.type === 'regional' && meta.coverage.center) {
    const far = farAwayPoint(meta.coverage.center);
    try {
      add('coversLocation.outside', plugin.coversLocation(far) === false, 'error');
    } catch (err) {
      add('coversLocation.outside', false, 'error', errMsg(err));
    }
  }

  // ---- fetchAlerts -----------------------------------------------------------
  const radiusMeters =
    options.sampleQuery?.radiusMeters ?? meta.defaultRadiusMeters ?? 5000;
  const timeRange = options.sampleQuery?.timeRange ?? sampleTimeRange(meta, now());
  const limit = options.sampleQuery?.limit ?? 50;
  const query: PluginFetchOptions = { location: insidePoint, radiusMeters, timeRange, limit };

  try {
    const result = await plugin.fetchAlerts(query);
    const parse = PluginFetchResultSchema.safeParse(result);
    add('fetchAlerts.resultSchemaValid', parse.success, 'error', parse.success ? undefined : issues(parse));

    if (parse.success) {
      const alerts = parse.data.alerts;
      const badCat = alerts.find((a) => !meta.supportedCategories.includes(a.category));
      add(
        'fetchAlerts.categoriesSubset',
        !badCat,
        'error',
        badCat ? `alert category "${badCat.category}" not in supportedCategories` : undefined
      );

      const outside = alerts.filter(
        (a) => calculateDistance(query.location, a.location.point) > radiusMeters * 1.5
      );
      add(
        'fetchAlerts.withinRadius',
        outside.length === 0,
        'warning',
        outside.length ? `${outside.length} alert(s) far outside the query radius` : undefined
      );

      add('fetchAlerts.limitRespected', alerts.length <= limit, 'warning', `returned ${alerts.length}`);
    }
  } catch (err) {
    add('fetchAlerts.resultSchemaValid', false, 'error', errMsg(err));
  }

  // ---- Auth enforcement (endpoint mode only) --------------------------------
  if (isEndpoint && options.checkAuth !== false) {
    await runAuthChecks(options, add, now);
  }

  return finalize(checks);
}

/** Probe that the endpoint actually rejects missing / bad / stale auth. */
async function runAuthChecks(
  options: ConformanceOptions,
  add: (n: string, p: boolean, s: CheckSeverity, d?: string) => void,
  now: () => number
): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const path = canonicalPath(options.pluginId!, 'manifest');
  const url = joinUrl(options.endpoint!, path);
  const rejected = (status: number) => status === 401 || status === 403;

  // No credentials.
  const s1 = await rawStatus(fetchImpl, url, {});
  add('auth.rejectsMissingBearer', rejected(s1), 'error', `status ${s1}`);

  // Valid bearer, bogus signature.
  const s2 = await rawStatus(fetchImpl, url, {
    Authorization: `Bearer ${options.credentials!.token}`,
    'X-Vigilis-Signature': `t=${now()},v1=deadbeef`,
  });
  add('auth.rejectsBadSignature', rejected(s2), 'error', `status ${s2}`);

  // Valid signature, stale timestamp (replay).
  const staleTs = now() - 60 * 60 * 1000;
  const staleSig = computeSignature({
    signingSecret: options.credentials!.signingSecret,
    timestampMs: staleTs,
    method: 'GET',
    canonicalPath: path,
    body: '',
  });
  const s3 = await rawStatus(fetchImpl, url, {
    Authorization: `Bearer ${options.credentials!.token}`,
    'X-Vigilis-Signature': `t=${staleTs},v1=${staleSig}`,
  });
  add('auth.rejectsStaleTimestamp', rejected(s3), 'error', `status ${s3}`);
}

async function rawStatus(
  fetchImpl: typeof fetch,
  url: string,
  headers: Record<string, string>
): Promise<number> {
  try {
    const res = await fetchImpl(url, { method: 'GET', headers });
    return res.status;
  } catch {
    return 0;
  }
}

function sampleTimeRange(
  meta: AlertPlugin['metadata'],
  nowMs: number
): TimeRange {
  const day = 24 * 60 * 60 * 1000;
  if (meta.temporal.supportsPast) {
    return { start: new Date(nowMs - day).toISOString(), end: new Date(nowMs).toISOString() };
  }
  return { start: new Date(nowMs).toISOString(), end: new Date(nowMs + day).toISOString() };
}

function farAwayPoint(center: GeoPoint): GeoPoint {
  const latitude = center.latitude > 0 ? center.latitude - 20 : center.latitude + 20;
  return { latitude: clampLat(latitude), longitude: center.longitude };
}

function clampLat(lat: number): number {
  return Math.max(-89, Math.min(89, lat));
}

function issues(parse: { error?: { issues: unknown[] } }): string {
  return JSON.stringify(parse.error?.issues ?? []).slice(0, 500);
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function finalize(checks: CheckResult[]): ConformanceReport {
  const passed = checks.filter((c) => c.severity === 'error').every((c) => c.passed);
  return { passed, checks };
}

/** Format a report as human-readable lines (used by the CLI and for logging). */
export function formatReport(report: ConformanceReport): string {
  const lines = report.checks.map((c) => {
    const mark = c.passed ? '✓' : c.severity === 'warning' ? '!' : '✗';
    const tag = c.passed ? 'ok' : c.severity;
    return `  ${mark} [${tag}] ${c.name}${c.detail ? ` — ${c.detail}` : ''}`;
  });
  const errors = report.checks.filter((c) => c.severity === 'error' && !c.passed).length;
  const warnings = report.checks.filter((c) => c.severity === 'warning' && !c.passed).length;
  lines.push('');
  lines.push(
    report.passed
      ? `PASS — ${report.checks.length} checks, ${warnings} warning(s)`
      : `FAIL — ${errors} error(s), ${warnings} warning(s)`
  );
  return lines.join('\n');
}
