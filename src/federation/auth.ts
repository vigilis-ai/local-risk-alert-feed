/**
 * Federation request authentication — the Stripe / GitHub-webhook model.
 *
 * Every host→plugin request carries **both**:
 *  1. a per-plugin **bearer token** (`Authorization: Bearer …`) — authenticates
 *     the caller, and
 *  2. an **HMAC-SHA256 signature** over `timestamp . method . canonicalPath .
 *     body` (`X-Vigilis-Signature: t=<ms>,v1=<hex>`) — authenticates the
 *     request (integrity + replay window).
 *
 * This is fixed and defaulted in v1: no manifest `auth` field, no scheme
 * selector. Signing is ~microseconds of CPU and adds no round trip, so we do it
 * on every call rather than gate it behind a flag.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

/** `Authorization: Bearer <token>` */
export const AUTH_HEADER = 'authorization';
/** `X-Vigilis-Signature: t=<ms epoch>,v1=<hex hmac>` (Stripe-style). */
export const SIGNATURE_HEADER = 'x-vigilis-signature';

/** Default replay window: reject signatures whose timestamp is older/newer than this. */
export const DEFAULT_SIGNATURE_TOLERANCE_MS = 5 * 60 * 1000; // 5 minutes

/**
 * The two secrets a plugin registration needs. Resolved per-plugin from the
 * platform vault (never baked into the bundle); see {@link CredentialResolver}.
 */
export interface PluginCredentials {
  /** Bearer token the plugin issued to us. */
  token: string;
  /** Shared secret used to HMAC-sign each request. */
  signingSecret: string;
}

/**
 * Compute the HMAC-SHA256 signature (hex) for a request.
 *
 * The signed string is `${timestampMs}.${method}.${canonicalPath}.${body}`.
 * `canonicalPath` is derived from `(pluginId, action)` — not the raw URL — so
 * stage prefixes / base paths don't affect the signature.
 */
export function computeSignature(params: {
  signingSecret: string;
  timestampMs: number;
  method: string;
  canonicalPath: string;
  body: string;
}): string {
  const base = `${params.timestampMs}.${params.method.toUpperCase()}.${params.canonicalPath}.${params.body}`;
  return createHmac('sha256', params.signingSecret).update(base).digest('hex');
}

/**
 * Build the auth headers a host attaches to a plugin request.
 */
export function buildAuthHeaders(params: {
  credentials: PluginCredentials;
  timestampMs: number;
  method: string;
  canonicalPath: string;
  body: string;
}): Record<string, string> {
  const signature = computeSignature({
    signingSecret: params.credentials.signingSecret,
    timestampMs: params.timestampMs,
    method: params.method,
    canonicalPath: params.canonicalPath,
    body: params.body,
  });
  return {
    Authorization: `Bearer ${params.credentials.token}`,
    'X-Vigilis-Signature': `t=${params.timestampMs},v1=${signature}`,
  };
}

/** Result of verifying an inbound request. */
export interface VerifyResult {
  ok: boolean;
  reason?: string;
}

/** Constant-time string compare that never throws on length mismatch. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Parse a `t=<ms>,v1=<hex>` signature header. */
export function parseSignatureHeader(
  header: string | undefined
): { timestampMs: number; signature: string } | null {
  if (!header) return null;
  let timestampMs: number | undefined;
  let signature: string | undefined;
  for (const part of header.split(',')) {
    const [k, v] = part.split('=');
    if (k?.trim() === 't') timestampMs = Number(v);
    else if (k?.trim() === 'v1') signature = v?.trim();
  }
  if (timestampMs === undefined || Number.isNaN(timestampMs) || !signature) return null;
  return { timestampMs, signature };
}

/**
 * Verify an inbound plugin request (server side).
 *
 * Checks the bearer token, the timestamp freshness (replay window), and the
 * HMAC signature — all in constant time where it matters.
 *
 * @param nowMs - current time in ms; injectable for testing.
 */
export function verifyRequest(params: {
  credentials: PluginCredentials;
  headers: Record<string, string | undefined>;
  method: string;
  canonicalPath: string;
  body: string;
  toleranceMs?: number;
  nowMs?: number;
}): VerifyResult {
  const tolerance = params.toleranceMs ?? DEFAULT_SIGNATURE_TOLERANCE_MS;
  const now = params.nowMs ?? Date.now();

  // Normalize header lookup to lower-case keys.
  const headers = normalizeHeaders(params.headers);

  const authHeader = headers[AUTH_HEADER];
  const bearer = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined;
  if (!bearer || !safeEqual(bearer, params.credentials.token)) {
    return { ok: false, reason: 'invalid or missing bearer token' };
  }

  const parsed = parseSignatureHeader(headers[SIGNATURE_HEADER]);
  if (!parsed) {
    return { ok: false, reason: 'missing or malformed signature header' };
  }

  if (Math.abs(now - parsed.timestampMs) > tolerance) {
    return { ok: false, reason: 'signature timestamp outside tolerance (replay?)' };
  }

  const expected = computeSignature({
    signingSecret: params.credentials.signingSecret,
    timestampMs: parsed.timestampMs,
    method: params.method,
    canonicalPath: params.canonicalPath,
    body: params.body,
  });
  if (!safeEqual(expected, parsed.signature)) {
    return { ok: false, reason: 'signature mismatch' };
  }

  return { ok: true };
}

/** Lower-case all header keys so lookups are case-insensitive. */
export function normalizeHeaders(
  headers: Record<string, string | undefined>
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k.toLowerCase()] = v;
  }
  return out;
}
