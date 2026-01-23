import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
import type { AlertFeedConfig, AlertQueryResponse } from '../types';
import { AlertFeed } from '../core';
import { AlertQueryRequestSchema, transformRequestToQuery } from '../schemas';
import { ValidationError } from '../errors';

/**
 * Options for the Lambda handler factory.
 */
export interface LambdaHandlerOptions extends AlertFeedConfig {
  /** CORS origin(s) to allow (default: '*') */
  corsOrigin?: string | string[];
  /** Additional CORS headers to allow */
  corsHeaders?: string[];
  /** Additional CORS methods to allow */
  corsMethods?: string[];
}

/**
 * Lambda handler function type.
 */
export type LambdaHandler = (
  event: APIGatewayProxyEvent,
  context: Context
) => Promise<APIGatewayProxyResult>;

/**
 * Create an AWS Lambda handler for the AlertFeed.
 *
 * Supports both GET (query parameters) and POST (JSON body) requests.
 *
 * @param options - Handler configuration options
 * @returns Lambda handler function
 *
 * @example
 * ```typescript
 * import { createLambdaHandler } from 'local-risk-alert-feed/adapters/lambda';
 * import { PhoenixPolicePlugin } from 'local-risk-alert-feed/plugins/police-blotter';
 *
 * export const handler = createLambdaHandler({
 *   plugins: [{ plugin: new PhoenixPolicePlugin() }]
 * });
 * ```
 */
export function createLambdaHandler(options: LambdaHandlerOptions): LambdaHandler {
  const feed = new AlertFeed(options);
  const corsOrigin = options.corsOrigin ?? '*';
  const corsHeaders = [
    'Content-Type',
    'Authorization',
    ...(options.corsHeaders ?? []),
  ].join(', ');
  const corsMethods = ['GET', 'POST', 'OPTIONS', ...(options.corsMethods ?? [])].join(', ');

  // Initialize plugins
  if (options.plugins) {
    feed.registerPlugins(options.plugins).catch(console.error);
  }

  return async (event: APIGatewayProxyEvent, _context: Context): Promise<APIGatewayProxyResult> => {
    // Handle CORS preflight
    if (event.httpMethod === 'OPTIONS') {
      return createCorsResponse(corsOrigin, corsHeaders, corsMethods);
    }

    try {
      // Parse request
      const requestData = parseRequest(event);

      // Validate request
      const parseResult = AlertQueryRequestSchema.safeParse(requestData);
      if (!parseResult.success) {
        return createErrorResponse(
          400,
          'Validation Error',
          ValidationError.fromZodError(parseResult.error).toJSON(),
          corsOrigin
        );
      }

      // Transform to query
      const query = transformRequestToQuery(parseResult.data);

      // Execute query
      const response = await feed.query(query);

      return createSuccessResponse(response, corsOrigin);
    } catch (error) {
      console.error('AlertFeed error:', error);

      if (error instanceof ValidationError) {
        return createErrorResponse(400, 'Validation Error', error.toJSON(), corsOrigin);
      }

      return createErrorResponse(
        500,
        'Internal Server Error',
        {
          message: error instanceof Error ? error.message : 'An unexpected error occurred',
        },
        corsOrigin
      );
    }
  };
}

/**
 * Parse request data from Lambda event.
 */
function parseRequest(event: APIGatewayProxyEvent): Record<string, unknown> {
  if (event.httpMethod === 'POST' && event.body) {
    try {
      return JSON.parse(event.body);
    } catch {
      throw new ValidationError('Invalid JSON body', [
        { path: 'body', message: 'Request body must be valid JSON', code: 'invalid_type' },
      ]);
    }
  }

  // Parse from query parameters
  const params = event.queryStringParameters ?? {};
  const multiParams = event.multiValueQueryStringParameters ?? {};

  return {
    latitude: params.latitude ? parseFloat(params.latitude) : undefined,
    longitude: params.longitude ? parseFloat(params.longitude) : undefined,
    radiusMeters: params.radiusMeters ? parseFloat(params.radiusMeters) : undefined,
    limit: params.limit ? parseInt(params.limit, 10) : undefined,
    minRiskLevel: params.minRiskLevel,
    timeRange: params.timeRange,
    categories: multiParams.categories ?? (params.categories ? [params.categories] : undefined),
    temporalTypes: multiParams.temporalTypes ?? (params.temporalTypes ? [params.temporalTypes] : undefined),
    includePluginResults: params.includePluginResults === 'true',
  };
}

/**
 * Create a success response.
 */
function createSuccessResponse(
  data: AlertQueryResponse,
  corsOrigin: string | string[]
): APIGatewayProxyResult {
  return {
    statusCode: 200,
    headers: getCorsHeaders(corsOrigin),
    body: JSON.stringify(data),
  };
}

/**
 * Create an error response.
 */
function createErrorResponse(
  statusCode: number,
  error: string,
  details: Record<string, unknown>,
  corsOrigin: string | string[]
): APIGatewayProxyResult {
  return {
    statusCode,
    headers: getCorsHeaders(corsOrigin),
    body: JSON.stringify({ error, ...details }),
  };
}

/**
 * Create a CORS preflight response.
 */
function createCorsResponse(
  corsOrigin: string | string[],
  corsHeaders: string,
  corsMethods: string
): APIGatewayProxyResult {
  const origin = Array.isArray(corsOrigin) ? corsOrigin[0] : corsOrigin;
  return {
    statusCode: 204,
    headers: {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Headers': corsHeaders,
      'Access-Control-Allow-Methods': corsMethods,
      'Access-Control-Max-Age': '86400',
    },
    body: '',
  };
}

/**
 * Get CORS headers for response.
 */
function getCorsHeaders(corsOrigin: string | string[]): Record<string, string> {
  const origin = Array.isArray(corsOrigin) ? corsOrigin[0] : corsOrigin;
  return {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': origin,
  };
}
