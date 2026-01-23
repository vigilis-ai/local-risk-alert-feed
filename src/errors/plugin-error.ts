/**
 * Base error class for plugin-related errors.
 */
export class PluginError extends Error {
  readonly pluginId: string;
  readonly code: string;

  constructor(message: string, pluginId: string, code = 'PLUGIN_ERROR') {
    super(message);
    this.name = 'PluginError';
    this.pluginId = pluginId;
    this.code = code;
    Object.setPrototypeOf(this, PluginError.prototype);
  }
}

/**
 * Error thrown when a plugin fails to initialize.
 */
export class PluginInitializationError extends PluginError {
  readonly cause?: Error;

  constructor(pluginId: string, message: string, cause?: Error) {
    super(`Plugin "${pluginId}" failed to initialize: ${message}`, pluginId, 'PLUGIN_INIT_ERROR');
    this.name = 'PluginInitializationError';
    this.cause = cause;
    Object.setPrototypeOf(this, PluginInitializationError.prototype);
  }
}

/**
 * Error thrown when a plugin fetch operation fails.
 */
export class PluginFetchError extends PluginError {
  readonly cause?: Error;

  constructor(pluginId: string, message: string, cause?: Error) {
    super(`Plugin "${pluginId}" fetch failed: ${message}`, pluginId, 'PLUGIN_FETCH_ERROR');
    this.name = 'PluginFetchError';
    this.cause = cause;
    Object.setPrototypeOf(this, PluginFetchError.prototype);
  }
}

/**
 * Error thrown when a plugin operation times out.
 */
export class PluginTimeoutError extends PluginError {
  readonly timeoutMs: number;

  constructor(pluginId: string, timeoutMs: number) {
    super(
      `Plugin "${pluginId}" timed out after ${timeoutMs}ms`,
      pluginId,
      'PLUGIN_TIMEOUT_ERROR'
    );
    this.name = 'PluginTimeoutError';
    this.timeoutMs = timeoutMs;
    Object.setPrototypeOf(this, PluginTimeoutError.prototype);
  }
}

/**
 * Error thrown when trying to register a plugin with a duplicate ID.
 */
export class DuplicatePluginError extends PluginError {
  constructor(pluginId: string) {
    super(`Plugin with ID "${pluginId}" is already registered`, pluginId, 'DUPLICATE_PLUGIN_ERROR');
    this.name = 'DuplicatePluginError';
    Object.setPrototypeOf(this, DuplicatePluginError.prototype);
  }
}

/**
 * Error thrown when a referenced plugin is not found.
 */
export class PluginNotFoundError extends PluginError {
  constructor(pluginId: string) {
    super(`Plugin with ID "${pluginId}" not found`, pluginId, 'PLUGIN_NOT_FOUND_ERROR');
    this.name = 'PluginNotFoundError';
    Object.setPrototypeOf(this, PluginNotFoundError.prototype);
  }
}
