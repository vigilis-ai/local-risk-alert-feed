# local-risk-alert-feed

A TypeScript library for aggregating local risk alerts from multiple data sources via a plugin system. Designed for SaaS and serverless applications.

## Installation

```bash
npm install @vigilis-ai/local-risk-alert-feed
```

## Quick Start

```typescript
import {
  AlertFeed,
  NWSWeatherPlugin,
  PhoenixFirePlugin,
  NIFCWildfirePlugin,
  ArizonaTrafficPlugin,
} from '@vigilis-ai/local-risk-alert-feed';

// Create the feed
const feed = new AlertFeed({
  continueOnPluginError: true,
  pluginTimeoutMs: 30000,
});

// Register plugins
await feed.registerPlugins([
  { plugin: new NWSWeatherPlugin() },
  { plugin: new PhoenixFirePlugin({ includeEMS: true }) },
  { plugin: new NIFCWildfirePlugin() },
  { plugin: new ArizonaTrafficPlugin() },
]);

// Query for alerts near a location
const response = await feed.query({
  location: { latitude: 33.4484, longitude: -112.074 },
  timeRange: 'past-7d',
  radiusMeters: 2000,
  limit: 100,
});

console.log(`Found ${response.alerts.length} alerts`);

// Cleanup when done
await feed.dispose();
```

## Available Plugins

| Plugin | Coverage | Categories | Data Freshness |
|--------|----------|------------|----------------|
| `NWSWeatherPlugin` | United States | weather | Real-time |
| `PhoenixFirePlugin` | Phoenix metro | fire, medical | ~1-2 days |
| `NIFCWildfirePlugin` | United States | fire | Real-time |
| `ArizonaTrafficPlugin` | Arizona | traffic | Real-time |
| `PhoenixEventsPlugin` | Phoenix area | event | Real-time |
| `PhoenixConventionCenterPlugin` | Downtown Phoenix | event | Real-time |
| `AirNowPlugin` | United States | air-quality | Real-time |

## Plugin Configuration

### NWSWeatherPlugin

National Weather Service alerts for the United States.

```typescript
new NWSWeatherPlugin({
  cacheTtlMs: 300000, // 5 minute cache (default)
});
```

### PhoenixFirePlugin

Fire and EMS incidents from Phoenix Fire Department (ArcGIS 30-day history).

```typescript
new PhoenixFirePlugin({
  includeEMS: true,      // Include medical calls (default: true)
  includeService: false, // Include non-emergency service calls (default: false)
  limit: 500,            // Max records per request (default: 500)
});
```

### NIFCWildfirePlugin

Active wildfires from National Interagency Fire Center.

```typescript
new NIFCWildfirePlugin({
  includePrescribedBurns: false, // Include RX burns (default: false)
  minAcres: 0,                   // Minimum fire size (default: 0)
  states: ['AZ', 'CA', 'NV'],    // Filter by states (default: all)
});
```

### PhoenixEventsPlugin

Events from Ticketmaster Discovery API.

```typescript
new PhoenixEventsPlugin({
  ticketmasterApiKey: process.env.TICKETMASTER_API_KEY,
  limit: 100,
});
```

### AirNowPlugin

Air quality data from EPA AirNow.

```typescript
new AirNowPlugin({
  apiKey: process.env.AIRNOW_API_KEY, // Required
});
```

## Cache Providers

The library uses a **bring-your-own-client** pattern for caching. No external dependencies are required.

### In-Memory (Default)

Zero dependencies, suitable for development or single-instance deployments.

```typescript
import { AlertFeed, InMemoryCacheProvider } from '@vigilis-ai/local-risk-alert-feed';

const feed = new AlertFeed({
  cacheProvider: new InMemoryCacheProvider(),
});
```

### Vercel KV

Pass your own `@vercel/kv` instance (any version).

```typescript
import { kv } from '@vercel/kv';
import { AlertFeed, VercelKVCacheProvider } from '@vigilis-ai/local-risk-alert-feed';

const feed = new AlertFeed({
  cacheProvider: new VercelKVCacheProvider(kv, 'my-prefix:'),
});
```

### DynamoDB

Pass your own AWS SDK DynamoDB Document Client (any v3 version).

```typescript
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { AlertFeed, DynamoDBCacheProvider } from '@vigilis-ai/local-risk-alert-feed';

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);

const feed = new AlertFeed({
  cacheProvider: new DynamoDBCacheProvider(docClient, {
    tableName: 'alert-cache',
    keyAttribute: 'pk',       // optional, default: 'pk'
    valueAttribute: 'value',  // optional, default: 'value'
    ttlAttribute: 'ttl',      // optional, default: 'ttl'
  }),
});
```

### Custom Cache Provider

Implement the `CacheProvider` interface for any backend.

```typescript
import { CacheProvider, AlertFeed } from '@vigilis-ai/local-risk-alert-feed';

const customCache: CacheProvider = {
  async get<T>(key: string): Promise<T | null> {
    // Your implementation
  },
  async set<T>(key: string, value: T, ttlMs?: number): Promise<void> {
    // Your implementation
  },
  async delete(key: string): Promise<void> {
    // Your implementation
  },
  async has(key: string): Promise<boolean> {
    // Your implementation
  },
};

const feed = new AlertFeed({ cacheProvider: customCache });
```

## Query Options

```typescript
const response = await feed.query({
  // Required
  location: { latitude: 33.4484, longitude: -112.074 },

  // Time range - preset string or explicit range
  timeRange: 'past-7d',  // or 'past-24h', 'past-1h', 'next-7d', etc.
  // timeRange: { start: '2024-01-01T00:00:00Z', end: '2024-01-07T00:00:00Z' },

  // Optional filters
  radiusMeters: 2000,           // Default: 10000 (10km)
  categories: ['fire', 'weather'], // Filter by category
  plugins: ['nws-weather'],     // Filter by plugin ID
  limit: 100,                   // Max alerts to return

  // Include per-plugin timing/status info
  includePluginResults: true,
});
```

## Response Format

```typescript
interface AlertFeedResponse {
  alerts: Alert[];
  meta: {
    queriedAt: string;
    timeRange: { start: string; end: string };
    location: { latitude: number; longitude: number };
    radiusMeters: number;
    totalCount: number;
    truncated: boolean;
  };
  pluginResults?: PluginResult[];  // If includePluginResults: true
}

interface Alert {
  id: string;
  title: string;
  description: string;
  category: 'weather' | 'fire' | 'medical' | 'traffic' | 'event' | 'air-quality' | ...;
  riskLevel: 'low' | 'moderate' | 'high' | 'severe' | 'extreme';
  priority: number;  // 1-5, higher = more urgent
  temporalType: 'real-time' | 'scheduled' | 'historical';
  location: {
    point: { latitude: number; longitude: number };
    address?: string;
    city?: string;
    state?: string;
  };
  timestamps: {
    issued: string;
    eventStart?: string;
    eventEnd?: string;
    expires?: string;
  };
  source: {
    id: string;
    name: string;
  };
  url?: string;
  metadata?: Record<string, unknown>;
}
```

## Serverless Adapters

### Vercel Edge/Serverless

```typescript
import { createVercelHandler } from 'local-risk-alert-feed/adapters/vercel';
import { NWSWeatherPlugin, PhoenixFirePlugin } from '@vigilis-ai/local-risk-alert-feed';

export default createVercelHandler({
  plugins: [
    new NWSWeatherPlugin(),
    new PhoenixFirePlugin(),
  ],
  // Optional: custom cache provider
  // cacheProvider: new VercelKVCacheProvider(kv),
});
```

### AWS Lambda

```typescript
import { createLambdaHandler } from 'local-risk-alert-feed/adapters/lambda';
import { NWSWeatherPlugin, PhoenixFirePlugin } from '@vigilis-ai/local-risk-alert-feed';

export const handler = createLambdaHandler({
  plugins: [
    new NWSWeatherPlugin(),
    new PhoenixFirePlugin(),
  ],
});
```

## Creating Custom Plugins

Extend `BasePlugin` to create your own data source plugins.

```typescript
import { BasePlugin, PluginMetadata, PluginFetchOptions, PluginFetchResult } from '@vigilis-ai/local-risk-alert-feed';

export class MyCustomPlugin extends BasePlugin {
  readonly metadata: PluginMetadata = {
    id: 'my-custom-plugin',
    name: 'My Custom Data Source',
    version: '1.0.0',
    description: 'Fetches alerts from my custom API',
    coverage: {
      type: 'regional',
      center: { latitude: 40.7128, longitude: -74.0060 },
      radiusMeters: 50000,
      description: 'New York City area',
    },
    supportedTemporalTypes: ['real-time'],
    supportedCategories: ['custom'],
    refreshIntervalMs: 60000,
  };

  async fetchAlerts(options: PluginFetchOptions): Promise<PluginFetchResult> {
    const { location, timeRange, radiusMeters } = options;

    // Fetch from your API
    const data = await this.fetchJson<MyApiResponse>('https://my-api.com/alerts');

    // Transform to Alert format
    const alerts = data.items.map(item => this.createAlert({
      id: `my-plugin-${item.id}`,
      title: item.title,
      description: item.description,
      riskLevel: 'moderate',
      priority: 3,
      category: 'custom',
      temporalType: 'real-time',
      location: {
        point: { latitude: item.lat, longitude: item.lng },
      },
      timestamps: {
        issued: item.createdAt,
      },
    }));

    return { alerts, fromCache: false };
  }
}
```

## Environment Variables

```bash
# Optional - for Ticketmaster events
TICKETMASTER_API_KEY=your_key_here

# Optional - for AirNow air quality
AIRNOW_API_KEY=your_key_here
```

## License

UNLICENSED - Private package
