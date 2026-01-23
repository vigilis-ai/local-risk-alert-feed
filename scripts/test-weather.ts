/**
 * Simple test for NWS Weather plugin.
 * Run with: npx tsx scripts/test-weather.ts
 */

import { AlertFeed } from '../src';
import { NWSWeatherPlugin } from '../src/plugins/weather';

// Locations to test
const LOCATIONS = {
  phoenix: { latitude: 33.4484, longitude: -112.0740, name: 'Phoenix, AZ' },
  miami: { latitude: 25.7617, longitude: -80.1918, name: 'Miami, FL' },
  seattle: { latitude: 47.6062, longitude: -122.3321, name: 'Seattle, WA' },
  denver: { latitude: 39.7392, longitude: -104.9903, name: 'Denver, CO' },
};

async function main() {
  console.log('NWS Weather Plugin Test');
  console.log('='.repeat(50));

  const feed = new AlertFeed();
  await feed.registerPlugin({ plugin: new NWSWeatherPlugin() });

  for (const [key, loc] of Object.entries(LOCATIONS)) {
    console.log(`\n${loc.name}`);
    console.log('-'.repeat(50));

    try {
      const response = await feed.query({
        location: { latitude: loc.latitude, longitude: loc.longitude },
        timeRange: 'next-7d',
        categories: ['weather'],
        includePluginResults: true,
      });

      console.log(`Active alerts: ${response.alerts.length}`);

      if (response.alerts.length > 0) {
        for (const alert of response.alerts) {
          console.log(`\n  [${alert.riskLevel.toUpperCase()}] ${alert.title}`);
          if (alert.timestamps.expires) {
            console.log(`    Expires: ${new Date(alert.timestamps.expires).toLocaleString()}`);
          }
          if (alert.metadata?.instruction) {
            const instruction = String(alert.metadata.instruction).slice(0, 100);
            console.log(`    ${instruction}...`);
          }
        }
      } else {
        console.log('  No active weather alerts');
      }
    } catch (error) {
      console.error(`  Error: ${error instanceof Error ? error.message : error}`);
    }
  }

  await feed.dispose();
  console.log('\n' + '='.repeat(50));
  console.log('Test complete');
}

main().catch(console.error);
