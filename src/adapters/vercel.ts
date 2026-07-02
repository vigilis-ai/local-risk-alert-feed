import type { AlertFeedConfig, AlertQueryResponse } from '../types';
import { AlertFeed } from '../core';
import { AlertQueryRequestSchema, transformRequestToQuery } from '../schemas';
import { ValidationError } from '../errors';
import { loadRemotePlugins } from '../federation';
import type { LoadRemotePluginsOptions } from '../federation';

/**
 * Options for the Vercel handler factory.
 */
export interface VercelHandlerOptions extends AlertFeedConfig {
  /** CORS origin(s) to allow (default: '*') */
  corsOrigin?: string | string[];
  /**
   * Federated plugins to load at startup from a registration store —
   * runtime-extensible endpoints (ours or third parties') with no redeploy.
   * Loaded and registered alongside `plugins`; see {@link loadRemotePlugins}.
   */
  remotePlugins?: LoadRemotePluginsOptions;
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
 * import { createDefaultPlugins } from 'local-risk-alert-feed';
 *
 * const { GET, POST } = createVercelHandler({
 *   plugins: createDefaultPlugins(),
 *   // Optional: load runtime-configured federated plugins from a store.
 *   remotePlugins: {
 *     store: myRegistrationStore,        // DynamoDB / control-plane API
 *     credentials: myCredentialResolver, // secrets vault
 *   },
 * });
 *
 * export { GET, POST };
 * ```
 */
export function createVercelHandler(options: VercelHandlerOptions): VercelHandlerResult {
  // Register everything through the awaited `ready` promise below (not via the
  // AlertFeed constructor) so local + federated plugins land through one
  // deterministic path and the first request can't race an unfinished
  // registration.
  const feed = new AlertFeed({ ...options, plugins: undefined });
  const corsOrigin = options.corsOrigin ?? '*';

  // Initialize plugins once at startup: static registrations plus any
  // federated (remote) plugins loaded from the registration store.
  const ready = (async () => {
    if (options.plugins?.length) {
      await feed.registerPlugins(options.plugins);
    }
    if (options.remotePlugins) {
      await feed.registerPlugins(await loadRemotePlugins(options.remotePlugins));
    }
  })();
  ready.catch((error) => console.error('Plugin registration error:', error));

  const handleRequest = async (request: NextRequest): Promise<Response> => {
    try {
      // Ensure plugin registration finished before serving the first query.
      await ready;

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
