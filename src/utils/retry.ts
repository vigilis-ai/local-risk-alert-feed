/**
 * Options for retry behavior.
 */
export interface RetryOptions {
  /** Maximum number of retry attempts (default: 3) */
  maxAttempts?: number;
  /** Initial delay in milliseconds before first retry (default: 1000) */
  initialDelayMs?: number;
  /** Maximum delay in milliseconds between retries (default: 10000) */
  maxDelayMs?: number;
  /** Exponential backoff multiplier (default: 2) */
  backoffMultiplier?: number;
  /** Function to determine if an error is retryable (default: all errors) */
  isRetryable?: (error: Error) => boolean;
  /** Called before each retry attempt */
  onRetry?: (error: Error, attempt: number, delayMs: number) => void;
}

/**
 * Default retry options.
 */
const DEFAULT_OPTIONS: Required<Omit<RetryOptions, 'onRetry' | 'isRetryable'>> = {
  maxAttempts: 3,
  initialDelayMs: 1000,
  maxDelayMs: 10000,
  backoffMultiplier: 2,
};

/**
 * Execute a function with automatic retry on failure.
 *
 * Uses exponential backoff with jitter for retry delays.
 *
 * @param fn - The async function to execute
 * @param options - Retry configuration options
 * @returns The result of the function
 * @throws The last error if all retries fail
 */
export async function withRetry<T>(fn: () => Promise<T>, options?: RetryOptions): Promise<T> {
  const config = {
    ...DEFAULT_OPTIONS,
    ...options,
  };

  let lastError: Error | undefined;
  let delay = config.initialDelayMs;

  for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Check if we should retry
      const shouldRetry =
        attempt < config.maxAttempts && (config.isRetryable ? config.isRetryable(lastError) : true);

      if (!shouldRetry) {
        throw lastError;
      }

      // Notify about retry
      if (config.onRetry) {
        config.onRetry(lastError, attempt, delay);
      }

      // Wait with jitter
      await sleep(addJitter(delay));

      // Increase delay for next retry
      delay = Math.min(delay * config.backoffMultiplier, config.maxDelayMs);
    }
  }

  throw lastError;
}

/**
 * Sleep for a given duration.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Add random jitter to a delay value (±25%).
 */
function addJitter(delay: number): number {
  const jitter = delay * 0.25 * (Math.random() * 2 - 1);
  return Math.max(0, Math.round(delay + jitter));
}

/**
 * Execute a function with a timeout.
 *
 * @param fn - The async function to execute
 * @param timeoutMs - Maximum execution time in milliseconds
 * @param timeoutMessage - Optional error message for timeout
 * @returns The result of the function
 * @throws TimeoutError if the function takes longer than timeoutMs
 */
export async function withTimeout<T>(
  fn: () => Promise<T>,
  timeoutMs: number,
  timeoutMessage = 'Operation timed out'
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout>;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new TimeoutError(timeoutMessage, timeoutMs));
    }, timeoutMs);
  });

  try {
    const result = await Promise.race([fn(), timeoutPromise]);
    clearTimeout(timeoutId!);
    return result;
  } catch (error) {
    clearTimeout(timeoutId!);
    throw error;
  }
}

/**
 * Error thrown when an operation times out.
 */
export class TimeoutError extends Error {
  readonly code = 'TIMEOUT_ERROR';
  readonly timeoutMs: number;

  constructor(message: string, timeoutMs: number) {
    super(message);
    this.name = 'TimeoutError';
    this.timeoutMs = timeoutMs;
    Object.setPrototypeOf(this, TimeoutError.prototype);
  }
}
