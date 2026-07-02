/**
 * Registration & credential storage seams.
 *
 * The library defines the interfaces and ships trivial defaults; **the platform
 * supplies the durable implementations** (DynamoDB / control-plane API for the
 * catalog, Secrets Manager / SSM SecureString for credentials). Endpoints and
 * secrets are data the host reads at runtime — never baked into the bundle.
 */
import type { PluginRegistration } from '../types';
import { FederationClient } from './client';
import { RemotePlugin } from './remote-plugin';
import type { PluginCredentials } from './auth';
import type { EgressPolicy } from './egress';
import type { CircuitBreakerOptions } from './circuit-breaker';

/**
 * A single plugin catalog entry. Deliberately minimal in v1: no `auth` field —
 * bearer + HMAC is fixed/defaulted and credentials are resolved separately by
 * {@link CredentialResolver}. `endpoint` is the base; a plugin's routes are
 * `{endpoint}/plugins/{id}/…`, and two ids may share one endpoint/deployment.
 */
export interface RemotePluginRecord {
  id: string;
  endpoint: string;
  enabled?: boolean;
}

/** Source of the plugin catalog (per tenant). */
export interface RegistrationStore {
  list(): Promise<RemotePluginRecord[]>;
}

/** Resolves a plugin id to its bearer token + signing secret. */
export interface CredentialResolver {
  resolve(pluginId: string): Promise<PluginCredentials>;
}

/** In-memory catalog for local/dev/tests. Platform provides the durable store. */
export class StaticRegistrationStore implements RegistrationStore {
  constructor(private readonly records: RemotePluginRecord[]) {}
  async list(): Promise<RemotePluginRecord[]> {
    return this.records;
  }
}

/**
 * Convention-based resolver for local/dev: reads
 * `PLUGIN_<ID>_TOKEN` / `PLUGIN_<ID>_SIGNING_SECRET` from the environment
 * (id upper-cased, non-alphanumerics → `_`). Production reads from the vault.
 */
export class EnvCredentialResolver implements CredentialResolver {
  constructor(private readonly env: Record<string, string | undefined> = process.env) {}

  async resolve(pluginId: string): Promise<PluginCredentials> {
    const key = pluginId.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
    const token = this.env[`PLUGIN_${key}_TOKEN`];
    const signingSecret = this.env[`PLUGIN_${key}_SIGNING_SECRET`];
    if (!token || !signingSecret) {
      throw new Error(
        `Missing credentials for plugin "${pluginId}" (expected PLUGIN_${key}_TOKEN and PLUGIN_${key}_SIGNING_SECRET)`
      );
    }
    return { token, signingSecret };
  }
}

export interface LoadRemotePluginsOptions {
  store: RegistrationStore;
  credentials: CredentialResolver;
  /** Shared client (owns the connection pool); one is created if omitted. */
  client?: FederationClient;
  /** Manifest freshness TTL in ms applied to every loaded plugin (see {@link RemotePlugin}). */
  manifestTtlMs?: number;
  /** SSRF egress policy for the default client (ignored when `client` is provided). */
  egress?: EgressPolicy;
  /** Circuit-breaker settings applied per plugin (each gets its own breaker instance). */
  circuitBreaker?: CircuitBreakerOptions;
  /** Hard response-size cap in bytes for the default client (ignored when `client` is provided). */
  maxResponseBytes?: number;
}

/**
 * Load the catalog into `PluginRegistration[]` ready for the existing registry.
 *
 * This is the runtime-extensibility entry point: adding a plugin is adding a
 * store record — no rebuild, no redeploy. Credentials are resolved lazily and
 * per-plugin so one tenant's config can never read another's.
 */
export async function loadRemotePlugins(
  options: LoadRemotePluginsOptions
): Promise<PluginRegistration[]> {
  const client =
    options.client ??
    new FederationClient({ egress: options.egress, maxResponseBytes: options.maxResponseBytes });
  const records = await options.store.list();

  return Promise.all(
    records.map(async (record) => {
      const credentials = await options.credentials.resolve(record.id);
      const plugin = new RemotePlugin({
        id: record.id,
        endpoint: record.endpoint,
        credentials,
        client,
        manifestTtlMs: options.manifestTtlMs,
        circuitBreaker: options.circuitBreaker,
      });
      return { plugin, enabled: record.enabled ?? true } satisfies PluginRegistration;
    })
  );
}
