import type { AlertFeedConfig, AlertQueryResponse } from '../types';
import { AlertFeed } from '../core';
import { AlertQueryRequestSchema, transformRequestToQuery } from '../schemas';
import { ValidationError } from '../errors';

/**
 * Options for the Vercel handler factory.
 */
export interface VercelHandlerOptions extends AlertFeedConfig {
  /** CORS origin(s) to allow (default: '*') */
  corsOrigin?: string | string[];
}

/**
 * Next.js App Router request type.
 */
interface NextRequest {
  method: string;
  url: string;
  json(): Promise<unknown>;
  nextUrl: {
    searchParams: URLSearchParams;
  };
}

/**
 * Handler function for Next.js App Router.
 */
export type VercelHandler = (request: NextRequest) => Promise<Response>;

/**
 * Result of createVercelHandler with GET and POST handlers.
 */
export interface VercelHandlerResult {
  GET: VercelHandler;
  POST: VercelHandler;
}

/**
 * Create Next.js App Router handlers for the AlertFeed.
 *
 * Returns GET and POST handlers that can be exported from a route file.
 *
 * @param options - Handler configuration options
 * @returns Object with GET and POST handlers
 *
 * @example
 * ```typescript
 * // app/api/alerts/route.ts
 * import { createVercelHandler } from 'local-risk-alert-feed/adapters/vercel';
 * import { PhoenixPolicePlugin } from 'local-risk-alert-feed/plugins/police-blotter';
 *
 * const { GET, POST } = createVercelHandler({
 *   plugins: [{ plugin: new PhoenixPolicePlugin() }]
 * });
 *
 * export { GET, POST };
 * ```
 */
export function createVercelHandler(options: VercelHandlerOptions): VercelHandlerResult {
  const feed = new AlertFeed(options);
  const corsOrigin = options.corsOrigin ?? '*';

  // Initialize plugins
  if (options.plugins) {
    feed.registerPlugins(options.plugins).catch(console.error);
  }

  const handleRequest = async (request: NextRequest): Promise<Response> => {
    try {
      // Parse request
      const requestData = await parseRequest(request);

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

  return {
    GET: handleRequest,
    POST: handleRequest,
  };
}

/**
 * Parse request data from Next.js request.
 */
async function parseRequest(request: NextRequest): Promise<Record<string, unknown>> {
  if (request.method === 'POST') {
    try {
      return (await request.json()) as Record<string, unknown>;
    } catch {
      throw new ValidationError('Invalid JSON body', [
        { path: 'body', message: 'Request body must be valid JSON', code: 'invalid_type' },
      ]);
    }
  }

  // Parse from query parameters
  const params = request.nextUrl.searchParams;

  return {
    latitude: params.has('latitude') ? parseFloat(params.get('latitude')!) : undefined,
    longitude: params.has('longitude') ? parseFloat(params.get('longitude')!) : undefined,
    radiusMeters: params.has('radiusMeters') ? parseFloat(params.get('radiusMeters')!) : undefined,
    limit: params.has('limit') ? parseInt(params.get('limit')!, 10) : undefined,
    minRiskLevel: params.get('minRiskLevel') ?? undefined,
    timeRange: params.get('timeRange') ?? undefined,
    categories: params.getAll('categories').length > 0 ? params.getAll('categories') : undefined,
    temporalTypes: params.getAll('temporalTypes').length > 0 ? params.getAll('temporalTypes') : undefined,
    includePluginResults: params.get('includePluginResults') === 'true',
  };
}

/**
 * Create a success response.
 */
function createSuccessResponse(
  data: AlertQueryResponse,
  corsOrigin: string | string[]
): Response {
  const origin = Array.isArray(corsOrigin) ? corsOrigin[0] : corsOrigin;
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': origin,
    },
  });
}

/**
 * Create an error response.
 */
function createErrorResponse(
  statusCode: number,
  error: string,
  details: Record<string, unknown>,
  corsOrigin: string | string[]
): Response {
  const origin = Array.isArray(corsOrigin) ? corsOrigin[0] : corsOrigin;
  return new Response(JSON.stringify({ error, ...details }), {
    status: statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': origin,
    },
  });
}
