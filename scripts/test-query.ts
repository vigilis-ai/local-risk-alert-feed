/**
 * Test script for the Local Risk Alert Feed library.
 *
 * Run with: npx ts-node scripts/test-query.ts
 * Or after build: node dist/esm/scripts/test-query.js
 */

import { AlertFeed } from '../src';
import { NWSWeatherPlugin } from '../src/plugins/weather';
import { PhoenixPolicePlugin } from '../src/plugins/police-blotter';
import { PhoenixFirePlugin } from '../src/plugins/fire-emt';
import { PhoenixEventsPlugin } from '../src/plugins/events';

// Phoenix, AZ coordinates
const PHOENIX_LOCATION = {
  latitude: 33.4484,
  longitude: -112.0740,
};

// Test location outside Phoenix (New York)
const NYC_LOCATION = {
  latitude: 40.7128,
  longitude: -74.0060,
};

async function main() {
  console.log('='.repeat(60));
  console.log('Local Risk Alert Feed - Test Script');
  console.log('='.repeat(60));
  console.log();

  // Create the feed
  const feed = new AlertFeed({
    continueOnPluginError: true,
    pluginTimeoutMs: 30000,
  });

  // Register plugins
  console.log('Registering plugins...');
  await feed.registerPlugins([
    { plugin: new NWSWeatherPlugin() },
    { plugin: new PhoenixPolicePlugin() },
    { plugin: new PhoenixFirePlugin() },
    { plugin: new PhoenixEventsPlugin({ enableTicketmaster: false }) }, // No API key
  ]);

  // Show registered plugins
  const plugins = feed.getPluginMetadata();
  console.log(`Registered ${plugins.length} plugins:`);
  for (const p of plugins) {
    console.log(`  - ${p.name} (${p.id}): ${p.coverage.description}`);
  }
  console.log();

  // Test 1: Query Phoenix location
  console.log('-'.repeat(60));
  console.log('Test 1: Query Phoenix, AZ');
  console.log(`Location: ${PHOENIX_LOCATION.latitude}, ${PHOENIX_LOCATION.longitude}`);
  console.log('-'.repeat(60));

  try {
    const phoenixResponse = await feed.query({
      location: PHOENIX_LOCATION,
      timeRange: 'past-7d',
      limit: 10,
      includePluginResults: true,
    });

    console.log(`\nQuery completed at: ${phoenixResponse.meta.queriedAt}`);
    console.log(`Time range: ${phoenixResponse.meta.timeRange.start} to ${phoenixResponse.meta.timeRange.end}`);
    console.log(`Total alerts: ${phoenixResponse.meta.totalCount}`);
    console.log(`Truncated: ${phoenixResponse.meta.truncated}`);

    if (phoenixResponse.pluginResults) {
      console.log('\nPlugin Results:');
      for (const result of phoenixResponse.pluginResults) {
        const status = result.success ? '✓' : '✗';
        const cache = result.fromCache ? ' (cached)' : '';
        console.log(`  ${status} ${result.pluginName}: ${result.alertCount} alerts in ${result.durationMs}ms${cache}`);
        if (result.error) {
          console.log(`    Error: ${result.error}`);
        }
        if (result.warnings?.length) {
          for (const w of result.warnings) {
            console.log(`    Warning: ${w}`);
          }
        }
      }
    }

    if (phoenixResponse.alerts.length > 0) {
      console.log('\nSample Alerts:');
      for (const alert of phoenixResponse.alerts.slice(0, 5)) {
        console.log(`\n  [${alert.riskLevel.toUpperCase()}] ${alert.title}`);
        console.log(`    Category: ${alert.category}`);
        console.log(`    Source: ${alert.source.name}`);
        console.log(`    Location: ${alert.location.address || `${alert.location.point.latitude}, ${alert.location.point.longitude}`}`);
        console.log(`    Time: ${alert.timestamps.eventStart || alert.timestamps.issued}`);
      }
    } else {
      console.log('\nNo alerts found.');
    }
  } catch (error) {
    console.error('Error querying Phoenix:', error);
  }

  // Test 2: Query NYC (should only get weather, not Phoenix-specific data)
  console.log('\n');
  console.log('-'.repeat(60));
  console.log('Test 2: Query New York City (outside Phoenix coverage)');
  console.log(`Location: ${NYC_LOCATION.latitude}, ${NYC_LOCATION.longitude}`);
  console.log('-'.repeat(60));

  try {
    const nycResponse = await feed.query({
      location: NYC_LOCATION,
      timeRange: 'next-24h',
      limit: 5,
      includePluginResults: true,
    });

    console.log(`\nTotal alerts: ${nycResponse.meta.totalCount}`);

    if (nycResponse.pluginResults) {
      console.log('\nPlugin Results:');
      for (const result of nycResponse.pluginResults) {
        const status = result.success ? '✓' : '✗';
        console.log(`  ${status} ${result.pluginName}: ${result.alertCount} alerts`);
      }
    }

    if (nycResponse.alerts.length > 0) {
      console.log('\nAlerts (should only be weather):');
      for (const alert of nycResponse.alerts) {
        console.log(`  - [${alert.category}] ${alert.title}`);
      }
    } else {
      console.log('\nNo alerts found (no active weather alerts for NYC).');
    }
  } catch (error) {
    console.error('Error querying NYC:', error);
  }

  // Test 3: Filter by category
  console.log('\n');
  console.log('-'.repeat(60));
  console.log('Test 3: Query Phoenix - Weather Only');
  console.log('-'.repeat(60));

  try {
    const weatherResponse = await feed.query({
      location: PHOENIX_LOCATION,
      timeRange: 'next-24h',
      categories: ['weather'],
      limit: 5,
    });

    console.log(`\nWeather alerts: ${weatherResponse.meta.totalCount}`);

    for (const alert of weatherResponse.alerts) {
      console.log(`  - ${alert.title}`);
      console.log(`    Risk: ${alert.riskLevel}, Expires: ${alert.timestamps.expires || 'N/A'}`);
    }

    if (weatherResponse.alerts.length === 0) {
      console.log('  No active weather alerts for Phoenix.');
    }
  } catch (error) {
    console.error('Error:', error);
  }

  // Cleanup
  await feed.dispose();

  console.log('\n');
  console.log('='.repeat(60));
  console.log('Test complete!');
  console.log('='.repeat(60));
}

main().catch(console.error);
