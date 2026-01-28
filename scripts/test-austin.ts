/**
 * Test Austin plugins for a specific location.
 *
 * Usage: npx tsx scripts/test-austin.ts [lat] [lng] [radius]
 * Default: Austin downtown (30.2672, -97.7431) with 10km radius
 */

import { AlertFeed } from '../src';
import { NWSWeatherPlugin } from '../src/plugins/weather';
import { AustinTrafficPlugin, AustinFirePlugin, AustinCrimePlugin, AustinEventsPlugin } from '../src/plugins/austin';

async function testAustin() {
  const args = process.argv.slice(2);
  const latitude = parseFloat(args[0]) || 30.2672;
  const longitude = parseFloat(args[1]) || -97.7431;
  const radiusMeters = parseInt(args[2], 10) || 10000;

  console.log('='.repeat(70));
  console.log('AUSTIN PLUGIN TEST');
  console.log('='.repeat(70));
  console.log(`Location: ${latitude}, ${longitude}`);
  console.log(`Radius: ${radiusMeters}m (${(radiusMeters / 1000).toFixed(1)}km)`);
  console.log(`Time: ${new Date().toISOString()}`);
  console.log('');

  const feed = new AlertFeed({
    continueOnPluginError: true,
    pluginTimeoutMs: 60000,
  });

  await feed.registerPlugins([
    { plugin: new NWSWeatherPlugin() },
    { plugin: new AustinTrafficPlugin() },
    { plugin: new AustinFirePlugin() },
    { plugin: new AustinCrimePlugin() },
    { plugin: new AustinEventsPlugin() },
  ]);

  // Show plugin metadata
  console.log('-'.repeat(70));
  console.log('REGISTERED PLUGINS');
  console.log('-'.repeat(70));

  const plugins = feed.getPluginMetadata();
  for (const p of plugins) {
    console.log(`\n${p.name} (${p.id})`);
    console.log(`  Categories: ${p.supportedCategories.join(', ')}`);
    console.log(`  Coverage: ${p.coverage.description || p.coverage.type}`);
    console.log(`  Temporal: ${p.temporal.freshnessDescription}`);
  }

  // Test with past-7d to now+1d range (covers both historical and future)
  console.log('\n' + '-'.repeat(70));
  console.log('QUERY: past-7d to now+1d (combines historical and current)');
  console.log('-'.repeat(70));

  const now = new Date();
  const start = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const end = new Date(now.getTime() + 1 * 24 * 60 * 60 * 1000);

  const response = await feed.query({
    location: { latitude, longitude },
    timeRange: { start: start.toISOString(), end: end.toISOString() },
    radiusMeters,
    limit: 200,
    includePluginResults: true,
  });

  console.log(`\nTime Range: ${response.meta.timeRange.start} to ${response.meta.timeRange.end}`);
  console.log(`Total Alerts: ${response.meta.totalCount}`);
  console.log(`Truncated: ${response.meta.truncated}`);

  console.log('\nPlugin Results:');
  if (response.pluginResults) {
    for (const pr of response.pluginResults) {
      if (pr.skipped) {
        console.log(`  [SKIPPED] ${pr.pluginName}: ${pr.skipReason}`);
      } else {
        const status = pr.success ? 'SUCCESS' : 'FAILED';
        console.log(`  [${status}] ${pr.pluginName}: ${pr.alertCount} alerts in ${pr.durationMs}ms`);
        if (pr.error) {
          console.log(`           Error: ${pr.error}`);
        }
        if (pr.warnings?.length) {
          for (const w of pr.warnings) {
            console.log(`           Warning: ${w}`);
          }
        }
      }
    }
  }

  // Summary by category
  console.log('\n' + '-'.repeat(70));
  console.log('ALERTS BY CATEGORY');
  console.log('-'.repeat(70));

  const byCategory = response.alerts.reduce((acc, a) => {
    acc[a.category] = (acc[a.category] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  for (const [cat, count] of Object.entries(byCategory).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${cat}: ${count}`);
  }

  // Summary by risk level
  console.log('\n' + '-'.repeat(70));
  console.log('ALERTS BY RISK LEVEL');
  console.log('-'.repeat(70));

  const byRisk = response.alerts.reduce((acc, a) => {
    acc[a.riskLevel] = (acc[a.riskLevel] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  const riskOrder = ['extreme', 'severe', 'high', 'moderate', 'low'];
  for (const risk of riskOrder) {
    if (byRisk[risk]) {
      console.log(`  ${risk.toUpperCase()}: ${byRisk[risk]}`);
    }
  }

  // Sample alerts
  console.log('\n' + '-'.repeat(70));
  console.log('SAMPLE ALERTS (up to 3 per category)');
  console.log('-'.repeat(70));

  const alertsByCategory: Record<string, typeof response.alerts> = {};
  for (const alert of response.alerts) {
    if (!alertsByCategory[alert.category]) {
      alertsByCategory[alert.category] = [];
    }
    alertsByCategory[alert.category].push(alert);
  }

  for (const [category, alerts] of Object.entries(alertsByCategory)) {
    console.log(`\n=== ${category.toUpperCase()} ===`);

    for (const alert of alerts.slice(0, 3)) {
      console.log(`\n  [${alert.riskLevel.toUpperCase()}] ${alert.title}`);
      console.log(`    Source: ${alert.source.name}`);
      if (alert.location.address) {
        console.log(`    Address: ${alert.location.address}`);
      }
      console.log(`    Coords: ${alert.location.point.latitude.toFixed(4)}, ${alert.location.point.longitude.toFixed(4)}`);
      if (alert.timestamps.eventStart) {
        console.log(`    Event: ${alert.timestamps.eventStart}`);
      }
    }

    if (alerts.length > 3) {
      console.log(`\n    ... and ${alerts.length - 3} more ${category} alerts`);
    }
  }

  await feed.dispose();

  console.log('\n' + '='.repeat(70));
  console.log('TEST COMPLETE');
  console.log('='.repeat(70));
}

testAustin().catch(console.error);
