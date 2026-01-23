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
  >;

  constructor(config?: AlertFeedConfig) {
    this.registry = new PluginRegistry();
    this.resolver = new PluginResolver();
    this.aggregator = new AlertAggregator();
    this.config = {
      defaultCacheTtlMs: config?.defaultCacheTtlMs ?? 5 * 60 * 1000,
      pluginTimeoutMs: config?.pluginTimeoutMs ?? 30 * 1000,
      continueOnPluginError: config?.continueOnPluginError ?? true,
      maxConcurrentFetches: config?.maxConcurrentFetches ?? 5,
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
    const radiusMeters = query.radiusMeters ?? DEFAULT_QUERY_RADIUS_METERS;
    const limit = query.limit ?? DEFAULT_QUERY_LIMIT;
    const timeRange = normalizeTimeRange(query.timeRange);

    // Get all enabled plugins
    const allPlugins = this.registry.getAll(true);

    // Resolve which plugins to query based on location and filters
    const applicablePlugins = this.resolver.resolve(allPlugins, {
      location: query.location,
      categories: query.categories,
      temporalTypes: query.temporalTypes,
    });

    // Fetch from all applicable plugins
    const { alertSets, pluginResults } = await this.fetchFromPlugins(
      applicablePlugins,
      {
        location: query.location,
        radiusMeters,
        timeRange,
        limit,
        categories: query.categories,
        temporalTypes: query.temporalTypes,
      },
      query.includePluginResults ?? false
    );

    // Aggregate alerts
    const aggregatedAlerts = this.aggregator.aggregate(alertSets, {
      minRiskLevel: query.minRiskLevel,
      timeRange,
      location: query.location,
      radiusMeters,
      limit,
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
        radiusMeters,
        truncated,
      },
    };

    if (query.includePluginResults) {
      response.pluginResults = pluginResults;
    }

    return response;
  }

  /**
   * Fetch alerts from multiple plugins with concurrency control.
   */
  private async fetchFromPlugins(
    plugins: ReturnType<typeof this.registry.getAll>,
    options: PluginFetchOptions,
    includeResults: boolean
  ): Promise<{
    alertSets: Alert[][];
    pluginResults: PluginResultInfo[];
  }> {
    const alertSets: Alert[][] = [];
    const pluginResults: PluginResultInfo[] = [];

    // Process plugins with concurrency limit
    const chunks = this.chunkArray(plugins, this.config.maxConcurrentFetches);

    for (const chunk of chunks) {
      const chunkResults = await Promise.all(
        chunk.map((plugin) => this.fetchFromPlugin(plugin, options))
      );

      for (const result of chunkResults) {
        alertSets.push(result.alerts);
        if (includeResults) {
          pluginResults.push(result.info);
        }
      }
    }

    return { alertSets, pluginResults };
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
   * Split an array into chunks.
   */
  private chunkArray<T>(array: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < array.length; i += size) {
      chunks.push(array.slice(i, i + size));
    }
    return chunks;
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
