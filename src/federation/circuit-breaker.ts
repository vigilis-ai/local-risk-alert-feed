/**
 * Per-plugin circuit breaker.
 *
 * A federated plugin that is down or slow shouldn't drag every query. After
 * `failureThreshold` consecutive failures the breaker **opens** and fails fast
 * for `cooldownMs` (no calls made at all), then goes **half-open** to let a
 * single trial through: success closes it, another failure re-opens it.
 *
 * Each {@link RemotePlugin} owns its own breaker instance, so one bad endpoint's
 * health is isolated from the others. A tripped breaker surfaces as a normal
 * per-plugin error, which the AlertFeed's `continueOnPluginError` path already
 * reports without failing the whole query.
 */
export type CircuitState = 'closed' | 'open' | 'half-open';

/** Thrown by {@link CircuitBreaker.execute} while the circuit is open. */
export class CircuitOpenError extends Error {
  readonly retryAfterMs: number;
  constructor(name: string, retryAfterMs: number) {
    super(`Circuit open for "${name}"; retry in ${retryAfterMs}ms`);
    this.name = 'CircuitOpenError';
    this.retryAfterMs = retryAfterMs;
    Object.setPrototypeOf(this, CircuitOpenError.prototype);
  }
}

export interface CircuitBreakerOptions {
  /** Consecutive failures before the circuit opens (default: 5). */
  failureThreshold?: number;
  /** How long the circuit stays open before a half-open trial, in ms (default: 30s). */
  cooldownMs?: number;
  /** Label used in errors (typically the plugin id). */
  name?: string;
  /** Injectable clock (testing). */
  now?: () => number;
}

export class CircuitBreaker {
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly name: string;
  private readonly now: () => number;

  private failures = 0;
  private openedAt = 0;
  private state: CircuitState = 'closed';

  constructor(options: CircuitBreakerOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? 5;
    this.cooldownMs = options.cooldownMs ?? 30_000;
    this.name = options.name ?? 'circuit';
    this.now = options.now ?? (() => Date.now());
  }

  get currentState(): CircuitState {
    return this.state;
  }

  /**
   * Run `fn` through the breaker. Throws {@link CircuitOpenError} immediately
   * (without calling `fn`) while the circuit is open and still cooling down.
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'open') {
      const elapsed = this.now() - this.openedAt;
      if (elapsed < this.cooldownMs) {
        throw new CircuitOpenError(this.name, this.cooldownMs - elapsed);
      }
      this.state = 'half-open';
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  private onSuccess(): void {
    this.failures = 0;
    this.state = 'closed';
  }

  private onFailure(): void {
    this.failures += 1;
    if (this.state === 'half-open' || this.failures >= this.failureThreshold) {
      this.state = 'open';
      this.openedAt = this.now();
    }
  }
}
