/**
 * Test script for the Local Risk Alert Feed library.
 *
 * Run with: npx tsx scripts/test-query.ts
 */

import { AlertFeed } from '../src';
import { NWSWeatherPlugin } from '../src/plugins/weather';
import { PhoenixFirePlugin, NIFCWildfirePlugin } from '../src/plugins/fire-emt';
import { PhoenixEventsPlugin, PhoenixConventionCenterPlugin } from '../src/plugins/events';
import { ArizonaTrafficPlugin } from '../src/plugins/traffic';
// Note: AirNowPlugin requires an API key, so it's optional
// import { AirNowPlugin } from '../src/plugins/air-quality';

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

  // Check for optional API keys from environment
  const ticketmasterApiKey = process.env.TICKETMASTER_API_KEY;

  await feed.registerPlugins([
    { plugin: new NWSWeatherPlugin() },
    { plugin: new PhoenixFirePlugin() },
    { plugin: new NIFCWildfirePlugin() },
    { plugin: new PhoenixEventsPlugin({
      ticketmasterApiKey,
      enableTicketmaster: !!ticketmasterApiKey,
    }) },
    { plugin: new PhoenixConventionCenterPlugin() },
    { plugin: new ArizonaTrafficPlugin() },
    // Uncomment if you have an AirNow API key:
    // { plugin: new AirNowPlugin({ apiKey: process.env.AIRNOW_API_KEY! }) },
  ]);

  // Show registered plugins
  const plugins = feed.getPluginMetadata();
  console.log(`Registered ${plugins.length} plugins:`);
  for (const p of plugins) {
    console.log(`  - ${p.name} (${p.id})`);
    console.log(`    Categories: ${p.supportedCategories.join(', ')}`);
    console.log(`    Coverage: ${p.coverage.description || p.coverage.type}`);
  }
  console.log();

  // Test 1: Query Phoenix location - All categories
  console.log('-'.repeat(60));
  console.log('Test 1: Query Phoenix, AZ - All Categories');
  console.log(`Location: ${PHOENIX_LOCATION.latitude}, ${PHOENIX_LOCATION.longitude}`);
  console.log('-'.repeat(60));

  try {
    const phoenixResponse = await feed.query({
      location: PHOENIX_LOCATION,
      timeRange: 'past-7d',
      radiusMeters: 10000,
      limit: 20,
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
      for (const alert of phoenixResponse.alerts.slice(0, 10)) {
        console.log(`\n  [${alert.riskLevel.toUpperCase()}] ${alert.title}`);
        console.log(`    Category: ${alert.category}`);
        console.log(`    Type: ${alert.temporalType}`);
        console.log(`    Source: ${alert.source.name}`);
        console.log(`    Location: ${alert.location.address || `${alert.location.point.latitude}, ${alert.location.point.longitude}`}`);
        console.log(`    Time: ${alert.timestamps.eventStart || alert.timestamps.issued}`);
      }
    } else {
      console.log('\nNo alerts found.');
    }

    // Summary by category
    console.log('\nAlerts by Category:');
    const byCategory = phoenixResponse.alerts.reduce((acc, a) => {
      acc[a.category] = (acc[a.category] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);
    for (const [cat, count] of Object.entries(byCategory)) {
      console.log(`  ${cat}: ${count}`);
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
      console.log('\nAlerts (should only be weather since Phoenix plugins dont cover NYC):');
      for (const alert of nycResponse.alerts) {
        console.log(`  - [${alert.category}] ${alert.title}`);
      }
    } else {
      console.log('\nNo alerts found (no active weather alerts for NYC).');
    }
  } catch (error) {
    console.error('Error querying NYC:', error);
  }

  // Test 3: Query Phoenix - Real-time only
  console.log('\n');
  console.log('-'.repeat(60));
  console.log('Test 3: Query Phoenix - Real-Time Alerts Only');
  console.log('-'.repeat(60));

  try {
    const realtimeResponse = await feed.query({
      location: PHOENIX_LOCATION,
      timeRange: 'past-24h',
      temporalTypes: ['real-time'],
      limit: 10,
      includePluginResults: true,
    });

    console.log(`\nReal-time alerts: ${realtimeResponse.meta.totalCount}`);

    if (realtimeResponse.pluginResults) {
      console.log('\nPlugin Results:');
      for (const result of realtimeResponse.pluginResults) {
        if (result.alertCount > 0) {
          console.log(`  ✓ ${result.pluginName}: ${result.alertCount} real-time alerts`);
        }
      }
    }

    for (const alert of realtimeResponse.alerts.slice(0, 5)) {
      console.log(`\n  [${alert.riskLevel.toUpperCase()}] ${alert.title}`);
      console.log(`    Source: ${alert.source.name}`);
      console.log(`    Category: ${alert.category}`);
    }

    if (realtimeResponse.alerts.length === 0) {
      console.log('  No active real-time alerts.');
    }
  } catch (error) {
    console.error('Error:', error);
  }

  // Test 4: Query Phoenix - Traffic only
  console.log('\n');
  console.log('-'.repeat(60));
  console.log('Test 4: Query Phoenix - Traffic Incidents');
  console.log('-'.repeat(60));

  try {
    const trafficResponse = await feed.query({
      location: PHOENIX_LOCATION,
      radiusMeters: 50000, // 50km for traffic
      timeRange: 'past-24h',
      categories: ['traffic'],
      limit: 10,
    });

    console.log(`\nTraffic alerts: ${trafficResponse.meta.totalCount}`);

    for (const alert of trafficResponse.alerts) {
      console.log(`  - [${alert.riskLevel}] ${alert.title}`);
      if (alert.location.address) {
        console.log(`    Location: ${alert.location.address}`);
      }
    }

    if (trafficResponse.alerts.length === 0) {
      console.log('  No traffic incidents found.');
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
