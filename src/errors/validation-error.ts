import type { ZodError, ZodIssue } from 'zod';

/**
 * Represents a single validation issue.
 */
export interface ValidationIssue {
  path: string;
  message: string;
  code: string;
}

/**
 * Error thrown when input validation fails.
 */
export class ValidationError extends Error {
  readonly code = 'VALIDATION_ERROR';
  readonly issues: ValidationIssue[];

  constructor(message: string, issues: ValidationIssue[]) {
    super(message);
    this.name = 'ValidationError';
    this.issues = issues;
    Object.setPrototypeOf(this, ValidationError.prototype);
  }

  /**
   * Create a ValidationError from a Zod error.
   */
  static fromZodError(error: ZodError): ValidationError {
    const issues = error.issues.map((issue: ZodIssue) => ({
      path: issue.path.join('.'),
      message: issue.message,
      code: issue.code,
    }));

    const paths = issues.map((i) => i.path || 'value').join(', ');
    const message = `Validation failed for: ${paths}`;

    return new ValidationError(message, issues);
  }

  /**
   * Get a formatted string representation of all issues.
   */
  getFormattedIssues(): string {
    return this.issues
      .map((issue) => `  - ${issue.path || 'value'}: ${issue.message}`)
      .join('\n');
  }

  /**
   * Convert to a plain object for serialization.
   */
  toJSON(): { code: string; message: string; issues: ValidationIssue[] } {
    return {
      code: this.code,
      message: this.message,
      issues: this.issues,
    };
  }
}
