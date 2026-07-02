// Host-side federation: call plugins that live behind HTTP endpoints.
export { RemotePlugin } from './remote-plugin';
export type { RemotePluginOptions } from './remote-plugin';

export { FederationClient, joinUrl } from './client';
export type { FederationClientOptions } from './client';

export {
  StaticRegistrationStore,
  EnvCredentialResolver,
  loadRemotePlugins,
} from './store';
export type {
  RemotePluginRecord,
  RegistrationStore,
  CredentialResolver,
  LoadRemotePluginsOptions,
} from './store';

// Auth primitives (bearer + HMAC) — shared by client (sign) and server (verify).
export {
  buildAuthHeaders,
  verifyRequest,
  computeSignature,
  parseSignatureHeader,
  normalizeHeaders,
  AUTH_HEADER,
  SIGNATURE_HEADER,
  DEFAULT_SIGNATURE_TOLERANCE_MS,
} from './auth';
export type { PluginCredentials, VerifyResult } from './auth';
