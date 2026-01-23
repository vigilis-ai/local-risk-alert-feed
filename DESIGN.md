# Local Risk Alert Feed - Design Document

**Version:** 1.0.0
**Last Updated:** January 2026
**Status:** Active Development

## Overview

Local Risk Alert Feed is a TypeScript library that aggregates local risk and safety alerts from multiple data sources via a plugin system. It's designed to provide security personnel with real-time, historical, and scheduled risk information based on GPS location.

## Core Architecture

The library is composed of three core pieces:

### 1. External Library Integration

The library is designed to be plugged into `vigilis-api` or `vigilis-web` as an npm package:

```typescript
import { AlertFeed, PhoenixPolicePlugin, NWSWeatherPlugin } from 'local-risk-alert-feed';

const feed = new AlertFeed({
  plugins: [
    { plugin: new PhoenixPolicePlugin() },
    { plugin: new NWSWeatherPlugin() },
  ],
});

// Query alerts for a specific location
const response = await feed.query({
  location: { latitude: 33.4484, longitude: -112.074 },
  radiusMeters: 5000,
  timeRange: 'last24h',
});
```

**Installation:**
```bash
npm install local-risk-alert-feed
```

**Exports:**
- Main `AlertFeed` coordinator class
- All built-in plugins (Phoenix-focused + global)
- `BasePlugin` class for custom plugin development
- Type definitions for all interfaces
- Utility functions (geo calculations, caching, retry logic)
- Zod schemas for validation

### 2. Internal Plugin API

The plugin API allows consumers to query current, historical, or expected risks/alerts from varied sources based on GPS location.

#### AlertFeed Query Interface

```typescript
interface AlertQuery {
  /** Required: Center point for the query */
  location: GeoPoint;

  /** Radius in meters (default: 10,000) */
  radiusMeters?: number;

  /** Time range: preset string or { start, end } */
  timeRange?: TimeRangeInput;

  /** Filter by categories: 'crime' | 'fire' | 'medical' | 'weather' | 'traffic' | 'event' | 'civil-unrest' | 'other' */
  categories?: AlertCategory[];

  /** Filter by temporal type: 'historical' | 'scheduled' | 'real-time' */
  temporalTypes?: AlertTemporalType[];

  /** Minimum risk level filter */
  minRiskLevel?: RiskLevel;

  /** Maximum results (default: 100) */
  limit?: number;
}
```

#### Alert Structure

```typescript
interface Alert {
  id: string;
  title: string;
  description: string;
  riskLevel: 'low' | 'moderate' | 'high' | 'severe' | 'extreme';
  priority: 1 | 2 | 3 | 4 | 5;  // 1 = highest
  category: AlertCategory;
  temporalType: AlertTemporalType;
  location: AlertLocation;
  timestamps: AlertTimestamps;
  source: AlertSource;
  url?: string;
  metadata?: Record<string, unknown>;
}
```

#### Plugin Interface

All plugins implement the `AlertPlugin` interface:

```typescript
interface AlertPlugin {
  readonly metadata: PluginMetadata;

  /** Check if this plugin covers the given location */
  coversLocation(point: GeoPoint): boolean;

  /** Fetch alerts for the given options */
  fetchAlerts(options: PluginFetchOptions): Promise<PluginFetchResult>;

  /** Optional initialization */
  initialize?(config?: Record<string, unknown>): Promise<void>;

  /** Optional cleanup */
  dispose?(): Promise<void>;
}
```

### 3. Initial Plugins (Phoenix, AZ Focus)

The library ships with plugins focused on Phoenix, AZ as the initial deployment target, plus global plugins for weather.

#### Currently Implemented Plugins

| Plugin | Source | Categories | Temporal Types | Coverage |
|--------|--------|------------|----------------|----------|
| `NWSWeatherPlugin` | National Weather Service API | weather | real-time, scheduled | Global (US) |
| `PhoenixPolicePlugin` | Phoenix Open Data Portal | crime | historical | Phoenix Metro |
| `PhoenixFirePlugin` | Phoenix Open Data Portal | fire, medical | historical, real-time | Phoenix Metro |
| `PhoenixEventsPlugin` | Ticketmaster + Phoenix Permits | event, civil-unrest | scheduled | Downtown Phoenix |
| `PulsepointPlugin` | Pulsepoint API | fire, medical | real-time | Phoenix Metro |
| `ArizonaTrafficPlugin` | AZ511 / ADOT | traffic | real-time | Arizona |
| `AirQualityPlugin` | AirNow.gov API | weather | real-time | Global (US) |

#### Planned Plugins

- **Sports Schedule Plugin**: MLB (Diamondbacks), NBA (Suns), NFL (Cardinals) game schedules
- **Construction Plugin**: Active construction permits and road work
- **School Events Plugin**: ASU and major school event schedules

## Data Flow

```
                                    ┌─────────────────┐
                                    │  NWS Weather    │
                                    └────────┬────────┘
                                             │
┌──────────────┐     ┌──────────────┐        │        ┌─────────────────┐
│ vigilis-api  │────▶│  AlertFeed   │────────┼────────│ Phoenix Police  │
│ vigilis-web  │     │              │        │        └─────────────────┘
└──────────────┘     │  - Registry  │        │
                     │  - Resolver  │        │        ┌─────────────────┐
       Query         │  - Aggregator│────────┼────────│ Phoenix Fire    │
       ──────▶       └──────────────┘        │        └─────────────────┘
                            │                │
       ◀──────              │                │        ┌─────────────────┐
       Response             ▼                └────────│ Phoenix Events  │
                     ┌──────────────┐                 └─────────────────┘
                     │   Alerts[]   │
                     │   Metadata   │
                     └──────────────┘
```

### Query Processing Flow

1. **Query received** with location, radius, time range, filters
2. **Plugin Resolution**: Determine which plugins cover the location and support requested categories
3. **Concurrent Fetch**: Fetch from all applicable plugins (with concurrency limits)
4. **Aggregation**: Deduplicate, filter by risk level, sort by priority
5. **Response**: Return alerts with metadata (count, timing, coverage info)

## Plugin Architecture

### Base Plugin Class

All plugins extend `BasePlugin` which provides:

- **Location Coverage**: Automatic point-in-radius checking for regional plugins
- **HTTP Fetching**: Built-in retry logic with exponential backoff
- **Caching**: Optional caching layer with configurable TTL
- **CSV/JSON Parsing**: Support for both data formats from external APIs
- **Alert Creation**: Helper methods for creating properly structured alerts
- **Risk Mapping**: Utilities for converting numeric scores to risk levels

### Creating Custom Plugins

```typescript
import { BasePlugin, PluginMetadata, PluginFetchOptions, PluginFetchResult } from 'local-risk-alert-feed';

export class MyCustomPlugin extends BasePlugin {
  readonly metadata: PluginMetadata = {
    id: 'my-custom-plugin',
    name: 'My Custom Data Source',
    version: '1.0.0',
    description: 'Description of what this plugin provides',
    coverage: {
      type: 'regional',
      center: { latitude: 33.4484, longitude: -112.074 },
      radiusMeters: 50_000,
      description: 'Phoenix, AZ metropolitan area',
    },
    supportedTemporalTypes: ['real-time', 'historical'],
    supportedCategories: ['crime', 'fire'],
    refreshIntervalMs: 15 * 60 * 1000, // 15 minutes
  };

  async fetchAlerts(options: PluginFetchOptions): Promise<PluginFetchResult> {
    const { location, timeRange, radiusMeters } = options;

    // Fetch data from your source
    const data = await this.fetchJson<MyDataType[]>('https://api.example.com/data');

    // Transform to alerts
    const alerts = data.map(item => this.createAlert({
      id: `my-plugin-${item.id}`,
      title: item.title,
      description: item.description,
      riskLevel: this.mapToRiskLevel(item.severity),
      priority: this.riskLevelToPriority(this.mapToRiskLevel(item.severity)),
      category: 'crime',
      temporalType: 'real-time',
      location: {
        point: { latitude: item.lat, longitude: item.lng },
        address: item.address,
      },
      timestamps: {
        issued: item.timestamp,
        eventStart: item.timestamp,
      },
    }));

    return { alerts };
  }
}
```

## Data Sources

### Phoenix Open Data Portal

The Phoenix Open Data Portal uses the Socrata API for data access.

**Crime Data (Police Plugin):**
- Endpoint: `https://www.phoenixopendata.com/resource/b4ez-nd22.json`
- Key fields: `inc_number`, `ucr_crime_category`, `hundredblockaddr`, `occurred_on`, `location_1`
- Supports `within_circle()` for geospatial queries

**Fire Incidents (Fire Plugin):**
- Endpoint: `https://www.phoenixopendata.com/resource/m3af-pnrm.json`
- Key fields: `incident_number`, `call_type_final`, `incident_date`, `geocoded_column`
- Extensive call type mappings for fire/medical categorization

**Special Events:**
- Endpoint: `https://www.phoenixopendata.com/resource/yqvh-8bti.json`
- Key fields: `event_name`, `event_type`, `start_date`, `street_closure`

### National Weather Service API

Free, no authentication required.

- Active alerts by point: `https://api.weather.gov/alerts/active?point={lat},{lon}`
- Provides: Severity, urgency, certainty, instructions
- Coverage: All US states and territories

### Ticketmaster Discovery API

Requires API key.

- Events by location: `https://app.ticketmaster.com/discovery/v2/events.json`
- Provides: Event name, venue, dates, classifications
- Coverage: Major venues nationwide

### AirNow API

Free with registration.

- Current AQI: `https://www.airnowapi.org/aq/observation/latLong/current/`
- Forecasts available
- Coverage: All US

### Pulsepoint API

Real-time fire/EMS incidents.

- Requires agency registration
- Provides: Active incidents, unit responses, status updates
- Coverage: Participating fire departments

## Risk Level Mapping

All alerts are normalized to a 5-level risk scale:

| Risk Level | Priority | Numeric Range | Example Incidents |
|------------|----------|---------------|-------------------|
| `extreme` | 1 | 80-100 | Structure fire, homicide, extreme weather |
| `severe` | 2 | 60-79 | Aggravated assault, cardiac arrest, severe weather |
| `high` | 3 | 40-59 | Burglary, vehicle fire, moderate weather |
| `moderate` | 4 | 20-39 | Theft, medical aid, minor weather |
| `low` | 5 | 0-19 | Miscellaneous, patient transfer, routine |

## Temporal Types

Alerts are classified by when they occur relative to now:

- **`historical`**: Events that have already occurred (e.g., past crimes, resolved incidents)
- **`real-time`**: Actively happening now (e.g., current fires, active weather alerts)
- **`scheduled`**: Planned future events (e.g., sporting events, concerts, weather forecasts)

## Caching Strategy

- **Plugin-level caching**: Each plugin can cache responses with configurable TTL
- **Default TTL**: 5 minutes (adjustable per plugin)
- **Cache key generation**: Based on plugin ID + location + time range
- **Built-in providers**: In-memory, Vercel KV, DynamoDB

## Error Handling

The library uses a resilient approach to errors:

- **Continue on plugin error**: By default, if one plugin fails, others continue
- **Retry with backoff**: HTTP requests retry 3 times with exponential backoff
- **Timeout protection**: Plugin fetches timeout after 30 seconds (configurable)
- **Error reporting**: Errors are captured in `pluginResults` metadata

## Configuration

```typescript
const feed = new AlertFeed({
  // Plugins to register
  plugins: [...],

  // Cache TTL in milliseconds (default: 5 minutes)
  defaultCacheTtlMs: 5 * 60 * 1000,

  // Plugin fetch timeout (default: 30 seconds)
  pluginTimeoutMs: 30 * 1000,

  // Continue if a plugin fails (default: true)
  continueOnPluginError: true,

  // Max concurrent plugin fetches (default: 5)
  maxConcurrentFetches: 5,
});
```

## Integration Examples

### vigilis-api Integration

```typescript
// api/alerts/route.ts
import { AlertFeed, PhoenixPolicePlugin, NWSWeatherPlugin } from 'local-risk-alert-feed';

const feed = new AlertFeed({
  plugins: [
    { plugin: new PhoenixPolicePlugin({ appToken: process.env.SOCRATA_TOKEN }) },
    { plugin: new NWSWeatherPlugin() },
  ],
});

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const lat = parseFloat(searchParams.get('lat') || '33.4484');
  const lng = parseFloat(searchParams.get('lng') || '-112.074');

  const response = await feed.query({
    location: { latitude: lat, longitude: lng },
    radiusMeters: 5000,
    timeRange: 'last24h',
  });

  return Response.json(response);
}
```

### vigilis-web Integration

```typescript
// hooks/useAlerts.ts
import { AlertFeed, PhoenixPolicePlugin } from 'local-risk-alert-feed';

const feed = new AlertFeed({
  plugins: [{ plugin: new PhoenixPolicePlugin() }],
});

export function useAlerts(location: { lat: number; lng: number }) {
  const [alerts, setAlerts] = useState([]);

  useEffect(() => {
    feed.query({
      location: { latitude: location.lat, longitude: location.lng },
      timeRange: 'last7d',
    }).then(response => {
      setAlerts(response.alerts);
    });
  }, [location]);

  return alerts;
}
```

## Project Structure

```
src/
├── adapters/           # Runtime adapters (Lambda, Vercel)
├── core/               # Core system components
│   ├── alert-aggregator.ts
│   ├── alert-feed.ts
│   ├── plugin-registry.ts
│   ├── plugin-resolver.ts
│   └── time-range.ts
├── errors/             # Custom error types
├── geo/                # Geospatial utilities
├── plugins/            # Alert plugins
│   ├── air-quality/
│   ├── events/
│   ├── fire-emt/
│   ├── police-blotter/
│   ├── pulsepoint/
│   ├── traffic/
│   ├── weather/
│   └── base-plugin.ts
├── schemas/            # Zod validation schemas
├── types/              # TypeScript type definitions
├── utils/              # Utility functions
└── index.ts            # Main exports
```

## Development

```bash
# Install dependencies
npm install

# Run tests
npm test

# Build
npm run build

# Lint
npm run lint
```

## Future Enhancements

1. **WebSocket support**: Real-time alert streaming
2. **Geofencing**: Automated alerts when risk levels change for monitored locations
3. **AI Processing**: Optional AI layer to enhance alert descriptions
4. **Multi-region expansion**: Templates for other metro areas
5. **Rate limiting**: Built-in rate limiting for external APIs
6. **Metrics**: Plugin performance and availability metrics
