# Changelog

All notable changes to this project will be documented in this file.

## [0.3.0] - 2026-01-23

### Added
- **Bend Police Plugin** (`BendPolicePlugin`) - New plugin for Bend, Oregon police calls for service
  - Uses Bend Police Department ArcGIS service
  - Provides real-time and historical police call data
  - Configurable filtering for low-priority calls
  - Coverage: Bend, Oregon metropolitan area
- **Phoenix Convention Center Plugin** (`PhoenixConventionCenterPlugin`) - New plugin for Phoenix Convention Center events
  - Integrates with Ungerboeck API for convention center events
  - Includes events from Phoenix Convention Center, Orpheum Theatre, and Symphony Hall
  - Provides scheduled event alerts for downtown Phoenix area
  - Configurable venue filtering

### Changed
- **Package Exports** - Added individual plugin export paths for better tree-shaking
  - `./plugins/police` - Exports police-related plugins
  - `./plugins/fire-emt` - Exports fire and EMS plugins
  - `./plugins/events` - Exports event-related plugins
  - `./plugins/weather` - Exports weather plugins
  - `./plugins/traffic` - Exports traffic plugins
  - `./plugins/air-quality` - Exports air quality plugins

## [0.2.3] - 2026-01-23

### Added
- Comprehensive README.md with usage documentation, plugin configuration, cache providers, and examples

## [0.2.2] - 2026-01-23

### Changed
- **Cache providers are now fully interface-based** - Removed peer dependencies on `@vercel/kv` and `@aws-sdk/*`
  - `VercelKVCacheProvider` and `DynamoDBCacheProvider` now accept any object matching the interface
  - Host applications pass their own SDK instances, avoiding version conflicts
  - `InMemoryCacheProvider` remains the zero-dependency default

## [0.2.1] - 2026-01-23

### Added
- **NIFC Wildfires Plugin** - New plugin for national wildfire data from National Interagency Fire Center (NIFC)
  - Covers all active wildfires across the United States
  - Includes fire size, containment percentage, and cause information
  - Configurable to include/exclude prescribed burns

### Changed
- **Phoenix Fire Plugin** - Completely rewritten to use Phoenix Fire Department's ArcGIS service
  - Now uses live data (~1-2 days old) instead of the discontinued Socrata API
  - Includes both Fire and EMS incidents
  - Configurable EMS and service call filtering
- **Phoenix Events Plugin** - Simplified to use only Ticketmaster API
  - Removed discontinued Phoenix permits data source
  - Requires Ticketmaster API key for operation
- **Arizona Traffic Plugin** - Updated to use new ADOT ArcGIS endpoint
  - Consolidated multiple endpoints into single traffic events feed

### Removed
- **Phoenix Police Plugin** - Removed due to Phoenix Open Data discontinuing the Socrata API
- **Pulsepoint Plugin** - Removed due to API now requiring authentication

### Fixed
- Alert deduplication no longer produces duplicate entries
- Date filtering now works correctly with Phoenix Fire ArcGIS service

## [0.1.0] - 2026-01-22

### Added
- Initial release
- Core alert aggregation framework with plugin system
- Built-in plugins:
  - NWS Weather (National Weather Service alerts)
  - Phoenix Fire Department
  - Phoenix Police Department
  - Phoenix Events (Ticketmaster + city permits)
  - Pulsepoint (real-time fire/EMS)
  - Arizona Traffic
  - AirNow (air quality, requires API key)
  - Phoenix Convention Center
- Lambda and Vercel serverless adapters
- In-memory, Vercel KV, and DynamoDB cache providers
- Geo utilities for distance calculations and coverage filtering
- TypeScript support with full type definitions
