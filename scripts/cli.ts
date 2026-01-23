#!/usr/bin/env npx tsx
/**
 * CLI utility for querying the Local Risk Alert Feed.
 *
 * Usage:
 *   npx tsx scripts/cli.ts --lat 33.4484 --lng -112.074
 *   npx tsx scripts/cli.ts --lat 33.4484 --lng -112.074 --range past-24h
 *   npx tsx scripts/cli.ts --lat 33.4484 --lng -112.074 --category weather
 *   npx tsx scripts/cli.ts --lat 33.4484 --lng -112.074 --radius 5000 --limit 50
 */

import { AlertFeed } from '../src';
import { NWSWeatherPlugin } from '../src/plugins/weather';
import { PhoenixPolicePlugin } from '../src/plugins/police-blotter';
import { PhoenixFirePlugin } from '../src/plugins/fire-emt';
import { PhoenixEventsPlugin } from '../src/plugins/events';
import { PulsepointPlugin } from '../src/plugins/pulsepoint';
import { ArizonaTrafficPlugin } from '../src/plugins/traffic';
import type { TimeRangePreset, AlertCategory } from '../src/types';

// Parse command line arguments
function parseArgs(): {
  lat: number;
  lng: number;
  range: TimeRangePreset;
  category?: AlertCategory;
  radius: number;
  limit: number;
  json: boolean;
  verbose: boolean;
} {
  const args = process.argv.slice(2);
  const result = {
    lat: 33.4484, // Default: Phoenix
    lng: -112.074,
    range: 'past-24h' as TimeRangePreset,
    category: undefined as AlertCategory | undefined,
    radius: 10000,
    limit: 20,
    json: false,
    verbose: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];

    switch (arg) {
      case '--lat':
      case '-lat':
        result.lat = parseFloat(next);
        i++;
        break;
      case '--lng':
      case '-lng':
      case '--lon':
      case '-lon':
        result.lng = parseFloat(next);
        i++;
        break;
      case '--range':
      case '-r':
        result.range = next as TimeRangePreset;
        i++;
        break;
      case '--category':
      case '-c':
        result.category = next as AlertCategory;
        i++;
        break;
      case '--radius':
        result.radius = parseInt(next, 10);
        i++;
        break;
      case '--limit':
      case '-l':
        result.limit = parseInt(next, 10);
        i++;
        break;
      case '--json':
      case '-j':
        result.json = true;
        break;
      case '--verbose':
      case '-v':
        result.verbose = true;
        break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
    }
  }

  return result;
}

function printHelp() {
  console.log(`
Local Risk Alert Feed CLI

Usage:
  npx tsx scripts/cli.ts [options]

Options:
  --lat <number>      Latitude (default: 33.4484 - Phoenix)
  --lng <number>      Longitude (default: -112.074 - Phoenix)
  --range <preset>    Time range preset (default: past-24h)
                      Options: past-1h, past-6h, past-12h, past-24h, past-48h,
                               past-7d, past-30d, next-1h, next-6h, next-12h,
                               next-24h, next-48h, next-7d
  --category <cat>    Filter by category
                      Options: crime, fire, medical, weather, traffic, event, civil-unrest
  --radius <meters>   Search radius in meters (default: 10000)
  --limit <number>    Maximum results (default: 20)
  --json              Output as JSON
  --verbose           Show plugin details
  --help              Show this help

Examples:
  # Query Phoenix downtown
  npx tsx scripts/cli.ts --lat 33.4484 --lng -112.074

  # Query weather only for next 24 hours
  npx tsx scripts/cli.ts --lat 33.4484 --lng -112.074 --category weather --range next-24h

  # Query NYC with JSON output
  npx tsx scripts/cli.ts --lat 40.7128 --lng -74.006 --json

  # Query with larger radius
  npx tsx scripts/cli.ts --lat 33.4484 --lng -112.074 --radius 50000 --limit 50
`);
}

async function main() {
  const opts = parseArgs();

  if (isNaN(opts.lat) || isNaN(opts.lng)) {
    console.error('Error: Invalid latitude or longitude');
    process.exit(1);
  }

  // Create the feed
  const feed = new AlertFeed({
    continueOnPluginError: true,
    pluginTimeoutMs: 30000,
  });

  // Register plugins
  await feed.registerPlugins([
    { plugin: new NWSWeatherPlugin() },
    { plugin: new PhoenixPolicePlugin() },
    { plugin: new PhoenixFirePlugin() },
    { plugin: new PhoenixEventsPlugin({ enableTicketmaster: false }) },
    { plugin: new PulsepointPlugin() },
    { plugin: new ArizonaTrafficPlugin() },
  ]);

  // Build query
  const query: Parameters<typeof feed.query>[0] = {
    location: { latitude: opts.lat, longitude: opts.lng },
    timeRange: opts.range,
    radiusMeters: opts.radius,
    limit: opts.limit,
    includePluginResults: opts.verbose,
  };

  if (opts.category) {
    query.categories = [opts.category];
  }

  // Execute query
  const response = await feed.query(query);

  // Output results
  if (opts.json) {
    console.log(JSON.stringify(response, null, 2));
  } else {
    console.log('='.repeat(60));
    console.log('Local Risk Alert Feed - Query Results');
    console.log('='.repeat(60));
    console.log(`Location: ${opts.lat}, ${opts.lng}`);
    console.log(`Time Range: ${opts.range}`);
    console.log(`Radius: ${opts.radius}m`);
    if (opts.category) {
      console.log(`Category Filter: ${opts.category}`);
    }
    console.log('-'.repeat(60));
    console.log(`Total Alerts: ${response.meta.totalCount}`);
    console.log(`Query Time: ${response.meta.queriedAt}`);
    console.log();

    if (opts.verbose && response.pluginResults) {
      console.log('Plugin Results:');
      for (const result of response.pluginResults) {
        const status = result.success ? '✓' : '✗';
        const cache = result.fromCache ? ' (cached)' : '';
        console.log(`  ${status} ${result.pluginName}: ${result.alertCount} alerts in ${result.durationMs}ms${cache}`);
        if (result.error) {
          console.log(`    Error: ${result.error}`);
        }
      }
      console.log();
    }

    if (response.alerts.length > 0) {
      console.log('Alerts:');
      for (const alert of response.alerts) {
        console.log();
        console.log(`  [${alert.riskLevel.toUpperCase()}] ${alert.title}`);
        console.log(`    Category: ${alert.category} | Type: ${alert.temporalType}`);
        console.log(`    Source: ${alert.source.name}`);
        if (alert.location.address) {
          console.log(`    Location: ${alert.location.address}`);
        } else {
          console.log(`    Location: ${alert.location.point.latitude}, ${alert.location.point.longitude}`);
        }
        console.log(`    Time: ${alert.timestamps.eventStart || alert.timestamps.issued}`);
        if (alert.description && alert.description.length < 200) {
          console.log(`    ${alert.description.split('\n')[0]}`);
        }
      }
    } else {
      console.log('No alerts found.');
    }

    // Summary
    if (response.alerts.length > 0) {
      console.log();
      console.log('-'.repeat(60));
      console.log('Summary by Category:');
      const byCategory = response.alerts.reduce((acc, a) => {
        acc[a.category] = (acc[a.category] || 0) + 1;
        return acc;
      }, {} as Record<string, number>);
      for (const [cat, count] of Object.entries(byCategory)) {
        console.log(`  ${cat}: ${count}`);
      }

      console.log();
      console.log('Summary by Risk Level:');
      const byRisk = response.alerts.reduce((acc, a) => {
        acc[a.riskLevel] = (acc[a.riskLevel] || 0) + 1;
        return acc;
      }, {} as Record<string, number>);
      for (const level of ['extreme', 'severe', 'high', 'moderate', 'low']) {
        if (byRisk[level]) {
          console.log(`  ${level}: ${byRisk[level]}`);
        }
      }
    }
  }

  await feed.dispose();
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
