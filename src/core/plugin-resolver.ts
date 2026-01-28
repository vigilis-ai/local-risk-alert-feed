import type { AlertPlugin, GeoPoint, AlertCategory, AlertTemporalType, TimeRange } from '../types';

/**
 * Options for resolving plugins.
 */
export interface PluginResolveOptions {
  /** The location to check coverage for */
  location: GeoPoint;
  /** Filter by categories the plugin must support */
  categories?: AlertCategory[];
  /** Filter by temporal types the plugin must support */
  temporalTypes?: AlertTemporalType[];
}

/**
 * Result of plugin resolution with coverage information.
 */
export interface ResolvedPlugin {
  plugin: AlertPlugin;
  coversLocation: boolean;
  supportsCategories: boolean;
  supportsTemporalTypes: boolean;
}

/**
 * Resolves which plugins are applicable for a given query.
 *
 * Determines plugin coverage based on:
 * - Geographic coverage (global or regional with center + radius)
 * - Supported alert categories
 * - Supported temporal types
 */
export class PluginResolver {
  /**
   * Resolve which plugins cover the given location and match the filters.
   *
   * @param plugins - Available plugins to check
   * @param options - Resolution options including location and filters
   * @returns Array of plugins that match all criteria
   */
  resolve(plugins: AlertPlugin[], options: PluginResolveOptions): AlertPlugin[] {
    const { location, categories, temporalTypes } = options;

    return plugins.filter((plugin) => {
      // Check location coverage
      if (!plugin.coversLocation(location)) {
        return false;
      }

      // Check category support
      if (categories && categories.length > 0) {
        const supported = plugin.metadata.supportedCategories;
        const hasCategory = categories.some((c) => supported.includes(c));
        if (!hasCategory) {
          return false;
        }
      }

      // Check temporal type support
      if (temporalTypes && temporalTypes.length > 0) {
        const supported = plugin.metadata.supportedTemporalTypes;
        const hasTemporalType = temporalTypes.some((t) => supported.includes(t));
        if (!hasTemporalType) {
          return false;
        }
      }

      return true;
    });
  }

  /**
   * Resolve plugins with detailed coverage information.
   *
   * @param plugins - Available plugins to check
   * @param options - Resolution options
   * @returns Array of resolved plugins with coverage details
   */
  resolveWithDetails(plugins: AlertPlugin[], options: PluginResolveOptions): ResolvedPlugin[] {
    const { location, categories, temporalTypes } = options;

    return plugins.map((plugin) => {
      const coversLocation = plugin.coversLocation(location);

      let supportsCategories = true;
      if (categories && categories.length > 0) {
        const supported = plugin.metadata.supportedCategories;
        supportsCategories = categories.some((c) => supported.includes(c));
      }

      let supportsTemporalTypes = true;
      if (temporalTypes && temporalTypes.length > 0) {
        const supported = plugin.metadata.supportedTemporalTypes;
        supportsTemporalTypes = temporalTypes.some((t) => supported.includes(t));
      }

      return {
        plugin,
        coversLocation,
        supportsCategories,
        supportsTemporalTypes,
      };
    });
  }

  /**
   * Get plugins that cover a specific location (regardless of category/temporal filters).
   *
   * @param plugins - Available plugins
   * @param location - The location to check
   * @returns Plugins that cover the location
   */
  getPluginsForLocation(plugins: AlertPlugin[], location: GeoPoint): AlertPlugin[] {
    return plugins.filter((plugin) => plugin.coversLocation(location));
  }

  /**
   * Get plugins that support specific categories.
   *
   * @param plugins - Available plugins
   * @param categories - Categories to filter by
   * @returns Plugins that support at least one of the specified categories
   */
  getPluginsForCategories(plugins: AlertPlugin[], categories: AlertCategory[]): AlertPlugin[] {
    if (categories.length === 0) {
      return plugins;
    }

    return plugins.filter((plugin) => {
      const supported = plugin.metadata.supportedCategories;
      return categories.some((c) => supported.includes(c));
    });
  }

  /**
   * Get global plugins (plugins that cover all locations).
   *
   * @param plugins - Available plugins
   * @returns Plugins with global coverage
   */
  getGlobalPlugins(plugins: AlertPlugin[]): AlertPlugin[] {
    return plugins.filter((plugin) => plugin.metadata.coverage.type === 'global');
  }

  /**
   * Get regional plugins (plugins that cover specific geographic areas).
   *
   * @param plugins - Available plugins
   * @returns Plugins with regional coverage
   */
  getRegionalPlugins(plugins: AlertPlugin[]): AlertPlugin[] {
    return plugins.filter((plugin) => plugin.metadata.coverage.type === 'regional');
  }

  /**
   * Check if a plugin's temporal characteristics are compatible with a time range.
   *
   * @param plugin - The plugin to check
   * @param timeRange - The query time range
   * @returns Object with compatibility status and reason if not compatible
   */
  checkTemporalCompatibility(
    plugin: AlertPlugin,
    timeRange: TimeRange
  ): { compatible: boolean; reason?: string } {
    const { temporal } = plugin.metadata;
    const now = Date.now();
    const startMs = new Date(timeRange.start).getTime();
    const endMs = new Date(timeRange.end).getTime();

    // Use 1-minute tolerance for "now" comparisons to handle timing differences
    const tolerance = 60 * 1000; // 1 minute

    // Check if query is entirely/effectively in the past (ends at or before now)
    const isEntirelyPast = endMs <= now + tolerance;
    // Check if query is entirely/effectively in the future (starts at or after now)
    const isEntirelyFuture = startMs >= now - tolerance;

    // If query is entirely in the past
    if (isEntirelyPast) {
      if (!temporal.supportsPast) {
        return {
          compatible: false,
          reason: 'Plugin only provides future/scheduled data',
        };
      }

      // Check if data lag means no data is available yet
      if (temporal.dataLagMinutes !== undefined) {
        const dataLagMs = temporal.dataLagMinutes * 60 * 1000;
        const effectiveDataCutoff = now - dataLagMs;

        // If the query end is more recent than what's available
        if (startMs > effectiveDataCutoff) {
          const lagHours = Math.round(temporal.dataLagMinutes / 60);
          return {
            compatible: false,
            reason: `Data has ~${lagHours}h delay; no data available for this time range yet`,
          };
        }
      }
    }

    // If query is entirely in the future
    if (isEntirelyFuture) {
      if (!temporal.supportsFuture) {
        return {
          compatible: false,
          reason: 'Plugin only provides historical data',
        };
      }

      // Check if query exceeds lookahead limit
      if (temporal.futureLookaheadMinutes !== undefined) {
        const maxFutureMs = now + temporal.futureLookaheadMinutes * 60 * 1000;
        if (startMs > maxFutureMs) {
          const lookaheadDays = Math.round(temporal.futureLookaheadMinutes / 1440);
          return {
            compatible: false,
            reason: `Query exceeds plugin's ${lookaheadDays}-day lookahead limit`,
          };
        }
      }
    }

    // Query spans current time - check both directions
    if (!isEntirelyPast && !isEntirelyFuture) {
      // Need at least one direction supported
      if (!temporal.supportsPast && !temporal.supportsFuture) {
        return {
          compatible: false,
          reason: 'Plugin does not support past or future data',
        };
      }
    }

    return { compatible: true };
  }

  /**
   * Filter plugins by temporal compatibility with a time range.
   *
   * @param plugins - Plugins to filter
   * @param timeRange - The query time range
   * @returns Object with compatible plugins and skipped plugin info
   */
  filterByTemporalCompatibility(
    plugins: AlertPlugin[],
    timeRange: TimeRange
  ): {
    compatible: AlertPlugin[];
    skipped: Array<{ plugin: AlertPlugin; reason: string }>;
  } {
    const compatible: AlertPlugin[] = [];
    const skipped: Array<{ plugin: AlertPlugin; reason: string }> = [];

    for (const plugin of plugins) {
      const result = this.checkTemporalCompatibility(plugin, timeRange);
      if (result.compatible) {
        compatible.push(plugin);
      } else {
        skipped.push({ plugin, reason: result.reason! });
      }
    }

    return { compatible, skipped };
  }
}
