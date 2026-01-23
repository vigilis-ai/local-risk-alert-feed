import type { AlertPlugin, GeoPoint, AlertCategory, AlertTemporalType } from '../types';

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
}
