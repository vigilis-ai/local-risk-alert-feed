/**
 * Egress guard — SSRF defense for host→plugin calls.
 *
 * Third parties supply the `endpoint` URLs we call, so an unguarded host could
 * be tricked into fetching internal services or the cloud metadata endpoint
 * (`169.254.169.254`). Before every request the {@link FederationClient} asks
 * this policy whether the URL is allowed.
 *
 * Layers (each optional, safe defaults):
 *  - **protocol** — HTTPS only unless `allowHttp`.
 *  - **allowlist** — when `allowedHosts` is set, only those hosts pass.
 *  - **IP-literal ranges** — private / loopback / link-local / metadata IPs are
 *    blocked unless `allowPrivateAddresses`.
 *  - **DNS resolution** — when `resolveDns` is on, the hostname is resolved and
 *    every returned address is range-checked too.
 *
 * Note: DNS-resolution checking reduces but does not fully eliminate DNS-
 * rebinding risk (the OS re-resolves at connect time). For hard guarantees, run
 * behind an allowlist and/or an egress proxy.
 */
import { isIP } from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';

/** Thrown when a URL fails the egress policy. */
export class EgressBlockedError extends Error {
  readonly url: string;
  constructor(url: string, reason: string) {
    super(`Egress blocked for ${url}: ${reason}`);
    this.name = 'EgressBlockedError';
    this.url = url;
    Object.setPrototypeOf(this, EgressBlockedError.prototype);
  }
}

export interface EgressPolicyOptions {
  /**
   * When set, only these hosts are permitted. Entries are matched exactly, or
   * as a domain suffix when they start with a dot (`.example.com` matches
   * `api.example.com` and `example.com`).
   */
  allowedHosts?: string[];
  /** Permit `http:` in addition to `https:` (default: false). */
  allowHttp?: boolean;
  /** Permit private/loopback/link-local/metadata addresses (default: false). */
  allowPrivateAddresses?: boolean;
  /** Resolve hostnames and range-check the resolved addresses too (default: false). */
  resolveDns?: boolean;
  /** Injectable DNS lookup (testing); returns IP strings for a host. */
  lookup?: (host: string) => Promise<string[]>;
}

export class EgressPolicy {
  private readonly allowedHosts?: string[];
  private readonly allowHttp: boolean;
  private readonly allowPrivate: boolean;
  private readonly resolveDns: boolean;
  private readonly lookup: (host: string) => Promise<string[]>;

  constructor(options: EgressPolicyOptions = {}) {
    this.allowedHosts = options.allowedHosts?.map((h) => h.toLowerCase());
    this.allowHttp = options.allowHttp ?? false;
    this.allowPrivate = options.allowPrivateAddresses ?? false;
    this.resolveDns = options.resolveDns ?? false;
    this.lookup =
      options.lookup ??
      (async (host) => {
        const records = await dnsLookup(host, { all: true });
        return records.map((r) => r.address);
      });
  }

  /** Throw {@link EgressBlockedError} unless `rawUrl` satisfies the policy. */
  async assertAllowed(rawUrl: string): Promise<void> {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new EgressBlockedError(rawUrl, 'invalid URL');
    }

    if (url.protocol !== 'https:' && !(this.allowHttp && url.protocol === 'http:')) {
      throw new EgressBlockedError(rawUrl, `protocol "${url.protocol}" not allowed`);
    }

    const host = url.hostname.toLowerCase();

    if (this.allowedHosts && !this.hostAllowed(host)) {
      throw new EgressBlockedError(rawUrl, 'host not in allowlist');
    }

    if (isIP(host)) {
      if (!this.allowPrivate && isBlockedIp(host)) {
        throw new EgressBlockedError(rawUrl, 'address is in a private/blocked range');
      }
      return;
    }

    if (this.resolveDns && !this.allowPrivate) {
      const addresses = await this.lookup(host);
      for (const addr of addresses) {
        if (isBlockedIp(addr)) {
          throw new EgressBlockedError(rawUrl, `resolves to blocked address ${addr}`);
        }
      }
    }
  }

  private hostAllowed(host: string): boolean {
    if (!this.allowedHosts) return true;
    return this.allowedHosts.some((entry) => {
      if (entry.startsWith('.')) {
        return host === entry.slice(1) || host.endsWith(entry);
      }
      return host === entry;
    });
  }
}

/**
 * True for IPv4/IPv6 literals in private, loopback, link-local, multicast,
 * reserved, or cloud-metadata ranges.
 */
export function isBlockedIp(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) return isBlockedIpv4(ip);
  if (version === 6) return isBlockedIpv6(ip);
  return false;
}

function isBlockedIpv4(ip: string): boolean {
  const octets = ip.split('.').map(Number);
  if (octets.length !== 4 || octets.some((o) => Number.isNaN(o) || o < 0 || o > 255)) {
    return true; // malformed → treat as blocked
  }
  const [a, b] = octets;
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local incl. 169.254.169.254 metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 192 && b === 0) return true; // 192.0.0.0/24 (protocol assignments)
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmarking
  if (a >= 224) return true; // multicast + reserved (224.0.0.0/4, 240.0.0.0/4)
  return false;
}

function isBlockedIpv6(ip: string): boolean {
  const addr = ip.toLowerCase();
  if (addr === '::1' || addr === '::') return true; // loopback / unspecified
  // IPv4-mapped (::ffff:a.b.c.d) → check the embedded v4.
  const mapped = addr.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isBlockedIpv4(mapped[1]);
  const firstHextet = addr.split(':')[0];
  // fc00::/7 (unique-local, incl. AWS IMDSv6 fd00:ec2::254) and fe80::/10 (link-local).
  if (firstHextet.startsWith('fc') || firstHextet.startsWith('fd')) return true;
  if (firstHextet.startsWith('fe8') || firstHextet.startsWith('fe9')) return true;
  if (firstHextet.startsWith('fea') || firstHextet.startsWith('feb')) return true;
  if (firstHextet.startsWith('ff')) return true; // multicast
  return false;
}
