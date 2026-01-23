# Changelist for Local Risk Alert Feed (local-risk-alert-feed + plugins)

## [0.1.0] - 2025-01-22

### Added

#### Core System
- **AlertFeed** - Main class for aggregating local risk alerts from multiple data sources
- **Plugin System** - Pluggable architecture for integrating various data sources
  - `PluginRegistry` - Central registry for managing alert plugins
  - `PluginResolver` - Resolves and validates plugins based on configuration
  - `BasePlugin` - Abstract base class for building custom plugins
- **Alert Aggregation** - `AlertAggregator` for combining alerts from multiple sources with filtering, sorting, and deduplication
- **Time Range Utilities** - Support for time-based queries with presets (last hour, day, week, etc.)

#### Built-in Plugins
- **Weather Plugin** (`NWSWeatherPlugin`) - National Weather Service integration for weather alerts and forecasts
- **Police Blotter Plugin** (`PhoenixPolicePlugin`) - Phoenix Police Department crime data integration
- **Fire/EMT Plugin** (`PhoenixFirePlugin`) - Phoenix Fire Department emergency response data
- **PulsePoint Plugin** (`PulsepointPlugin`) - PulsePoint emergency services integration
- **Events Plugin** (`PhoenixEventsPlugin`) - Local events data for Phoenix area
- **Traffic Plugin** (`ArizonaTrafficPlugin`) - Arizona traffic incident data
- **Air Quality Plugin** (`AirNowPlugin`) - AirNow air quality data integration

#### Geo Utilities
- **Distance Calculations** - Haversine formula for calculating distances between geographic points
- **Location Filtering** - Utilities for filtering alerts by geographic proximity
  - `isPointInRadius` - Check if point is within radius
  - `isPointInCircle` - Check if point is within circle
  - `isPointInBoundingBox` - Check if point is within bounding box
  - `getBoundingBoxForRadius` - Calculate bounding box for radius queries

#### Cache Providers
- **In-Memory Cache** - Simple in-memory caching for development and testing
- **Vercel KV Cache** - Vercel KV integration for serverless caching
- **DynamoDB Cache** - AWS DynamoDB integration for persistent caching

#### Adapters
- **Lambda Adapter** - AWS Lambda serverless function adapter
- **Vercel Adapter** - Vercel serverless function adapter

#### Type System
- Comprehensive TypeScript type definitions for:
  - Alert objects with location, timestamps, risk levels, and categories
  - Plugin interfaces and metadata
  - Query parameters and responses
  - Configuration options
  - Geographic data structures

#### Schema Validation
- **Zod Schemas** - Runtime validation for:
  - Alert objects
  - Query parameters
  - Geographic coordinates
  - Time ranges

#### Error Handling
- Custom error classes:
  - `PluginError` - Base error for plugin-related issues
  - `PluginInitializationError` - Plugin initialization failures
  - `PluginFetchError` - Data fetching errors
  - `PluginTimeoutError` - Plugin timeout errors
  - `DuplicatePluginError` - Duplicate plugin registration
  - `PluginNotFoundError` - Plugin not found errors
  - `ValidationError` - Schema validation errors
  - `FetchError` - Network fetch errors

#### Utilities
- **Retry Logic** - Configurable retry mechanism with exponential backoff
- **Timeout Handling** - Timeout utilities for async operations
- **CSV Parsing** - Utilities for parsing and generating CSV data
- **Date Utilities** - Date formatting and manipulation helpers

#### Build System
- TypeScript compilation for:
  - ESM (ES Modules) output
  - CJS (CommonJS) output
  - Type definitions
- Package exports configured for tree-shaking and optimal bundling

### Features
- **Location-Based Filtering** - Query alerts by geographic location and radius
- **Time-Based Filtering** - Filter alerts by time ranges (past, present, future)
- **Risk Level Classification** - Alert severity levels (low, medium, high, critical)
- **Category Classification** - Alert categories (weather, crime, fire, medical, traffic, events, air-quality, other)
- **Temporal Type Classification** - Distinguish between current, predicted, and historical alerts
- **Deduplication** - Automatic deduplication of alerts from multiple sources
- **Sorting** - Multiple sort options (time, distance, priority, risk level)
- **Pagination** - Limit and offset support for query results
- **Caching** - Pluggable caching system to reduce API calls
- **Error Recovery** - Retry logic and graceful error handling

### Technical Details
- **Node.js** - Requires Node.js >= 18.0.0
- **TypeScript** - Full TypeScript support with type definitions
- **Dependencies** - Zod for schema validation
- **Peer Dependencies** - Optional dependencies for cache providers:
  - `@aws-sdk/client-dynamodb` and `@aws-sdk/lib-dynamodb` for DynamoDB
  - `@vercel/kv` for Vercel KV
