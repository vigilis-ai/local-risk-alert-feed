import type {
  AlertFeedConfig,
  AlertQuery,
  AlertQueryResponse,
  PluginRegistration,
  PluginFetchOptions,
  PluginResultInfo,
  Alert,
} from '../types';
import { DEFAULT_QUERY_RADIUS_METERS, DEFAULT_QUERY_LIMIT } from '../types';
import { PluginRegistry } from './plugin-registry';
import { PluginResolver } from './plugin-resolver';
import { AlertAggregator } from './alert-aggregator';
import { normalizeTimeRange } from './time-range';
import { PluginFetchError, PluginTimeoutError } from '../errors';
import { withTimeout } from '../utils';

/**
 * Main AlertFeed class that coordinates plugin fetching and alert aggregation.
 */
export class AlertFeed {
  private registry: PluginRegistry;
  private resolver: PluginResolver;
  private aggregator: AlertAggregator;
  private config: Required<
    Pick<
      AlertFeedConfig,
      'defaultCacheTtlMs' | 'pluginTimeoutMs' | 'continueOnPluginError' | 'maxConcurrentFetches'
    >
  > & { overallTimeoutMs?: number };

  constructor(config?: AlertFeedConfig) {
    this.registry = new PluginRegistry();
    this.resolver = new PluginResolver();
    this.aggregator = new AlertAggregator();
    this.config = {
      defaultCacheTtlMs: config?.defaultCacheTtlMs ?? 5 * 60 * 1000,
      pluginTimeoutMs: config?.pluginTimeoutMs ?? 30 * 1000,
      continueOnPluginError: config?.continueOnPluginError ?? true,
      maxConcurrentFetches: config?.maxConcurrentFetches ?? 5,
      overallTimeoutMs: config?.overallTimeoutMs,
    };

    // Register initial plugins if provided
    if (config?.plugins) {
      // Don't await here - call registerPlugins separately
      this.registerPluginsSync(config.plugins);
    }
  }

  /**
   * Register plugins synchronously (for constructor use).
   * Initialization happens lazily on first query.
   */
  private registerPluginsSync(registrations: PluginRegistration[]): void {
    for (const reg of registrations) {
      // Queue registration without awaiting
      this.registry.register(reg).catch(() => {
        // Errors will be caught on first query
      });
    }
  }

  /**
   * Register plugins with the feed.
   *
   * @param registrations - Array of plugin registrations
   */
  async registerPlugins(registrations: PluginRegistration[]): Promise<void> {
    await this.registry.registerAll(registrations);
  }

  /**
   * Register a single plugin.
   *
   * @param registration - Plugin registration
   */
  async registerPlugin(registration: PluginRegistration): Promise<void> {
    await this.registry.register(registration);
  }

  /**
   * Unregister a plugin by ID.
   *
   * @param pluginId - The plugin ID to unregister
   */
  async unregisterPlugin(pluginId: string): Promise<void> {
    await this.registry.unregister(pluginId);
  }

  /**
   * Query for alerts based on location and filters.
   *
   * @param query - Query parameters
   * @returns Query response with alerts and metadata
   */
  async query(query: AlertQuery): Promise<AlertQueryResponse> {
    // Normalize query parameters
    // Preserve undefined so we can detect caller-provided vs plugin-default radius
    const callerRadius = query.radiusMeters;
    const limit = query.limit ?? DEFAULT_QUERY_LIMIT;
    const timeRange = normalizeTimeRange(query.timeRange);

    // A caller who named categories or sources has already narrowed the
    // question, so rank for that ("show me fire calls") rather than triaging.
    const intent =
      query.intent ??
      (query.categories?.length || query.sources?.length ? 'focused' : 'triage');

    // Get all enabled plugins
    let allPlugins = this.registry.getAll(true);

    // Restrict to specific sources when asked (e.g. only fire/EMS responders).
    if (query.sources?.length) {
      const wanted = new Set(query.sources);
      allPlugins = allPlugins.filter((p) => wanted.has(p.metadata.id));
    }

    // Resolve which plugins to query based on location and filters
    const applicablePlugins = this.resolver.resolve(allPlugins, {
      location: query.location,
      categories: query.categories,
      temporalTypes: query.temporalTypes,
    });

    // Filter by temporal compatibility
    const { compatible: temporallyCompatible, skipped: temporallySkipped } =
      this.resolver.filterByTemporalCompatibility(applicablePlugins, timeRange);

    // Build skipped plugin results
    const skippedResults: PluginResultInfo[] = temporallySkipped.map(({ plugin, reason }) => ({
      pluginId: plugin.metadata.id,
      pluginName: plugin.metadata.name,
      success: true, // Not an error, just skipped
      alertCount: 0,
      durationMs: 0,
      skipped: true,
      skipReason: reason,
    }));

    // Fetch from temporally compatible plugins (each uses its own default radius if callerRadius is undefined)
    // The fetch budget we hand each plugin. A plugin can never contribute more
    // than `limit` alerts to the answer, so pulling thousands is pure waste —
    // the headroom just covers alerts the aggregator drops on the post-filters
    // (risk floor, radius, time). Ordering guidance tells the plugin WHICH slice
    // to keep when it has to cut: the worst (triage) or the latest (focused).
    const maxResults = Math.max(limit * 2, 50);
    const rank = intent === 'focused' ? 'recency' : 'severity';

    const overallTimeoutMs = query.overallTimeoutMs ?? this.config.overallTimeoutMs;

    const { alertSets, pluginResults, incompletePlugins } = await this.fetchFromPlugins(
      temporallyCompatible,
      {
        location: query.location,
        timeRange,
        limit,
        categories: query.categories,
        temporalTypes: query.temporalTypes,
        maxResults,
        minRiskLevel: query.minRiskLevel,
        rank,
      },
      callerRadius,
      query.includePluginResults ?? false,
      overallTimeoutMs
    );

    // Aggregate alerts
    // When callerRadius is undefined, skip the secondary radius filter —
    // each plugin already filtered by its own default radius.
    const aggregatedAlerts = this.aggregator.aggregate(alertSets, {
      minRiskLevel: query.minRiskLevel,
      timeRange,
      location: query.location,
      radiusMeters: callerRadius,
      limit,
      intent,
      categories: query.categories,
    });

    const truncated = aggregatedAlerts.length < this.getTotalAlertCount(alertSets);

    // Build response
    const response: AlertQueryResponse = {
      alerts: aggregatedAlerts,
      meta: {
        totalCount: aggregatedAlerts.length,
        queriedAt: new Date().toISOString(),
        timeRange,
        location: query.location,
        radiusMeters: callerRadius,
        truncated,
        ...(incompletePlugins.length > 0
          ? { partial: true, incompletePlugins }
          : {}),
      },
    };

    if (query.includePluginResults) {
      // Combine fetched and skipped plugin results
      response.pluginResults = [...pluginResults, ...skippedResults];
    }

    return response;
  }

  /**
   * Fetch alerts from multiple plugins with a bounded concurrency pool and an
   * optional overall deadline.
   *
   * A worker pool keeps up to `maxConcurrentFetches` plugins in flight at once —
   * unlike the old sequential-chunk scheme, a fast plugin never waits behind a
   * slow one in an earlier chunk. When `overallTimeoutMs` is set, the whole fan-
   * out is raced against that deadline: whatever has completed is returned, and
   * plugins still running are reported in `incompletePlugins` instead of holding
   * up the caller. `pluginTimeoutMs` still caps each plugin individually.
   *
   * When callerRadius is undefined, each plugin uses its own defaultRadiusMeters
   * (falling back to the framework DEFAULT_QUERY_RADIUS_METERS).
   */
  private async fetchFromPlugins(
    plugins: ReturnType<typeof this.registry.getAll>,
    baseOptions: Omit<PluginFetchOptions, 'radiusMeters'>,
    callerRadius: number | undefined,
    includeResults: boolean,
    overallTimeoutMs?: number
  ): Promise<{
    alertSets: Alert[][];
    pluginResults: PluginResultInfo[];
    incompletePlugins: string[];
  }> {
    const collected: Array<{ alerts: Alert[]; info: PluginResultInfo } | undefined> = new Array(
      plugins.length
    );

    let deadlineHit = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline =
      overallTimeoutMs && overallTimeoutMs > 0
        ? new Promise<void>((resolve) => {
            timer = setTimeout(() => {
              deadlineHit = true;
              resolve();
            }, overallTimeoutMs);
          })
        : undefined;

    // Bounded worker pool: each worker pulls the next plugin index until the
    // list is exhausted or the deadline has fired (no point starting new work
    // we're about to abandon).
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < plugins.length && !deadlineHit) {
        const index = next++;
        const plugin = plugins[index];
        const radiusMeters =
          callerRadius ?? plugin.metadata.defaultRadiusMeters ?? DEFAULT_QUERY_RADIUS_METERS;
        const result = await this.fetchFromPlugin(plugin, { ...baseOptions, radiusMeters });
        collected[index] = result;
      }
    };

    const poolSize = Math.max(1, Math.min(this.config.maxConcurrentFetches, plugins.length));
    const run = Promise.all(Array.from({ length: poolSize }, () => worker()));

    try {
      // `run` rejects only when continueOnPluginError is false and a plugin
      // throws — in which case the whole query should fail, so let it propagate.
      await (deadline ? Promise.race([run, deadline]) : run);
    } finally {
      if (timer) clearTimeout(timer);
    }

    const alertSets: Alert[][] = [];
    const pluginResults: PluginResultInfo[] = [];
    const incompletePlugins: string[] = [];

    for (let i = 0; i < plugins.length; i++) {
      const result = collected[i];
      if (result) {
        alertSets.push(result.alerts);
        if (includeResults) pluginResults.push(result.info);
      } else {
        // Never started or still running when the deadline fired.
        incompletePlugins.push(plugins[i].metadata.id);
        if (includeResults) {
          pluginResults.push({
            pluginId: plugins[i].metadata.id,
            pluginName: plugins[i].metadata.name,
            success: false,
            alertCount: 0,
            durationMs: overallTimeoutMs ?? 0,
            error: 'overall query deadline exceeded',
          });
        }
      }
    }

    return { alertSets, pluginResults, incompletePlugins };
  }

  /**
   * Fetch alerts from a single plugin with timeout handling.
   */
  private async fetchFromPlugin(
    plugin: ReturnType<typeof this.registry.getAll>[number],
    options: PluginFetchOptions
  ): Promise<{ alerts: Alert[]; info: PluginResultInfo }> {
    const startTime = Date.now();
    const pluginId = plugin.metadata.id;
    const pluginName = plugin.metadata.name;

    try {
      const result = await withTimeout(
        () => plugin.fetchAlerts(options),
        this.config.pluginTimeoutMs,
        `Plugin "${pluginId}" timed out`
      );

      return {
        alerts: result.alerts,
        info: {
          pluginId,
          pluginName,
          success: true,
          alertCount: result.alerts.length,
          durationMs: Date.now() - startTime,
          fromCache: result.fromCache,
          warnings: result.warnings,
        },
      };
    } catch (error) {
      const durationMs = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);

      const info: PluginResultInfo = {
        pluginId,
        pluginName,
        success: false,
        alertCount: 0,
        durationMs,
        error: errorMessage,
      };

      if (!this.config.continueOnPluginError) {
        if (error instanceof PluginTimeoutError) {
          throw error;
        }
        throw new PluginFetchError(
          pluginId,
          errorMessage,
          error instanceof Error ? error : undefined
        );
      }

      return { alerts: [], info };
    }
  }

  /**
   * Get total count of alerts across all sets.
   */
  private getTotalAlertCount(alertSets: Alert[][]): number {
    return alertSets.reduce((sum, set) => sum + set.length, 0);
  }

  /**
   * Get registered plugin metadata.
   *
   * @param enabledOnly - Only return enabled plugins (default: true)
   */
  getPluginMetadata(enabledOnly = true) {
    return this.registry.getMetadata(enabledOnly);
  }

  /**
   * Check if a plugin is registered.
   */
  hasPlugin(pluginId: string): boolean {
    return this.registry.has(pluginId);
  }

  /**
   * Enable a plugin.
   */
  async enablePlugin(pluginId: string): Promise<void> {
    await this.registry.enable(pluginId);
  }

  /**
   * Disable a plugin.
   */
  disablePlugin(pluginId: string): void {
    this.registry.disable(pluginId);
  }

  /**
   * Dispose of the feed and all plugins.
   */
  async dispose(): Promise<void> {
    await this.registry.dispose();
  }
}
