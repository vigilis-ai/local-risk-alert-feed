import type { AlertPlugin, PluginRegistration, PluginMetadata } from '../types';
import {
  DuplicatePluginError,
  PluginNotFoundError,
  PluginInitializationError,
} from '../errors';

/**
 * Entry stored in the registry for each plugin.
 */
interface PluginEntry {
  plugin: AlertPlugin;
  config?: Record<string, unknown>;
  enabled: boolean;
  initialized: boolean;
}

/**
 * Registry for managing alert plugins.
 *
 * Handles registration, initialization, and lifecycle of plugins.
 */
export class PluginRegistry {
  private plugins = new Map<string, PluginEntry>();

  /**
   * Register a single plugin.
   *
   * @param registration - Plugin registration details
   * @throws DuplicatePluginError if a plugin with the same ID is already registered
   */
  async register(registration: PluginRegistration): Promise<void> {
    const { plugin, config, enabled = true } = registration;
    const pluginId = plugin.metadata.id;

    if (this.plugins.has(pluginId)) {
      throw new DuplicatePluginError(pluginId);
    }

    const entry: PluginEntry = {
      plugin,
      config,
      enabled,
      initialized: false,
    };

    this.plugins.set(pluginId, entry);

    // Initialize if enabled
    if (enabled) {
      await this.initializePlugin(entry);
    }
  }

  /**
   * Register multiple plugins at once.
   *
   * @param registrations - Array of plugin registrations
   */
  async registerAll(registrations: PluginRegistration[]): Promise<void> {
    for (const registration of registrations) {
      await this.register(registration);
    }
  }

  /**
   * Unregister a plugin by ID.
   *
   * @param pluginId - The plugin ID to unregister
   * @throws PluginNotFoundError if the plugin is not registered
   */
  async unregister(pluginId: string): Promise<void> {
    const entry = this.plugins.get(pluginId);

    if (!entry) {
      throw new PluginNotFoundError(pluginId);
    }

    // Dispose if initialized
    if (entry.initialized && entry.plugin.dispose) {
      await entry.plugin.dispose();
    }

    this.plugins.delete(pluginId);
  }

  /**
   * Get a plugin by ID.
   *
   * @param pluginId - The plugin ID to retrieve
   * @returns The plugin instance or undefined if not found
   */
  get(pluginId: string): AlertPlugin | undefined {
    return this.plugins.get(pluginId)?.plugin;
  }

  /**
   * Get all registered plugins.
   *
   * @param enabledOnly - If true, only return enabled plugins (default: true)
   * @returns Array of plugin instances
   */
  getAll(enabledOnly = true): AlertPlugin[] {
    const plugins: AlertPlugin[] = [];

    for (const entry of this.plugins.values()) {
      if (!enabledOnly || entry.enabled) {
        plugins.push(entry.plugin);
      }
    }

    return plugins;
  }

  /**
   * Get metadata for all registered plugins.
   *
   * @param enabledOnly - If true, only return enabled plugins
   * @returns Array of plugin metadata
   */
  getMetadata(enabledOnly = true): PluginMetadata[] {
    return this.getAll(enabledOnly).map((p) => p.metadata);
  }

  /**
   * Check if a plugin is registered.
   *
   * @param pluginId - The plugin ID to check
   * @returns true if the plugin is registered
   */
  has(pluginId: string): boolean {
    return this.plugins.has(pluginId);
  }

  /**
   * Enable a registered plugin.
   *
   * @param pluginId - The plugin ID to enable
   */
  async enable(pluginId: string): Promise<void> {
    const entry = this.plugins.get(pluginId);

    if (!entry) {
      throw new PluginNotFoundError(pluginId);
    }

    entry.enabled = true;

    if (!entry.initialized) {
      await this.initializePlugin(entry);
    }
  }

  /**
   * Disable a registered plugin.
   *
   * @param pluginId - The plugin ID to disable
   */
  disable(pluginId: string): void {
    const entry = this.plugins.get(pluginId);

    if (!entry) {
      throw new PluginNotFoundError(pluginId);
    }

    entry.enabled = false;
  }

  /**
   * Check if a plugin is enabled.
   *
   * @param pluginId - The plugin ID to check
   * @returns true if the plugin is enabled
   */
  isEnabled(pluginId: string): boolean {
    return this.plugins.get(pluginId)?.enabled ?? false;
  }

  /**
   * Get the number of registered plugins.
   *
   * @param enabledOnly - If true, only count enabled plugins
   */
  size(enabledOnly = false): number {
    if (!enabledOnly) {
      return this.plugins.size;
    }

    let count = 0;
    for (const entry of this.plugins.values()) {
      if (entry.enabled) count++;
    }
    return count;
  }

  /**
   * Dispose all plugins and clear the registry.
   */
  async dispose(): Promise<void> {
    for (const entry of this.plugins.values()) {
      if (entry.initialized && entry.plugin.dispose) {
        try {
          await entry.plugin.dispose();
        } catch {
          // Ignore disposal errors
        }
      }
    }

    this.plugins.clear();
  }

  /**
   * Initialize a plugin.
   */
  private async initializePlugin(entry: PluginEntry): Promise<void> {
    if (entry.initialized) return;

    const pluginId = entry.plugin.metadata.id;

    try {
      if (entry.plugin.initialize) {
        await entry.plugin.initialize(entry.config);
      }
      entry.initialized = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new PluginInitializationError(
        pluginId,
        message,
        error instanceof Error ? error : undefined
      );
    }
  }
}
