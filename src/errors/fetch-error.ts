/**
 * Error thrown when an HTTP fetch operation fails.
 */
export class FetchError extends Error {
  readonly code = 'FETCH_ERROR';
  readonly url: string;
  readonly statusCode?: number;
  readonly statusText?: string;
  readonly cause?: Error;

  constructor(
    message: string,
    url: string,
    options?: {
      statusCode?: number;
      statusText?: string;
      cause?: Error;
    }
  ) {
    super(message);
    this.name = 'FetchError';
    this.url = url;
    this.statusCode = options?.statusCode;
    this.statusText = options?.statusText;
    this.cause = options?.cause;
    Object.setPrototypeOf(this, FetchError.prototype);
  }

  /**
   * Create a FetchError from a failed Response object.
   */
  static fromResponse(url: string, response: Response): FetchError {
    return new FetchError(`HTTP ${response.status}: ${response.statusText}`, url, {
      statusCode: response.status,
      statusText: response.statusText,
    });
  }

  /**
   * Create a FetchError from a network error.
   */
  static fromNetworkError(url: string, error: Error): FetchError {
    return new FetchError(`Network error: ${error.message}`, url, {
      cause: error,
    });
  }

  /**
   * Check if this is a client error (4xx status code).
   */
  isClientError(): boolean {
    return this.statusCode !== undefined && this.statusCode >= 400 && this.statusCode < 500;
  }

  /**
   * Check if this is a server error (5xx status code).
   */
  isServerError(): boolean {
    return this.statusCode !== undefined && this.statusCode >= 500;
  }

  /**
   * Check if this error is retryable (network error or 5xx status).
   */
  isRetryable(): boolean {
    return this.statusCode === undefined || this.isServerError() || this.statusCode === 429;
  }

  /**
   * Convert to a plain object for serialization.
   */
  toJSON(): {
    code: string;
    message: string;
    url: string;
    statusCode?: number;
    statusText?: string;
  } {
    return {
      code: this.code,
      message: this.message,
      url: this.url,
      statusCode: this.statusCode,
      statusText: this.statusText,
    };
  }
}
