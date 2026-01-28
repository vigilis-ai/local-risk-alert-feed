/**
 * Test Seattle plugins for a specific location.
 *
 * Usage: npx tsx scripts/test-seattle.ts [lat] [lng] [radius]
 * Default: Pike Place Market (47.6097, -122.3422) with 10km radius
 */

import { AlertFeed } from '../src';
import { NWSWeatherPlugin } from '../src/plugins/weather';
import { SeattlePolicePlugin, SeattleFirePlugin, SeattleEMTPlugin } from '../src/plugins/seattle';

async function testSeattle() {
  const args = process.argv.slice(2);
  const latitude = parseFloat(args[0]) || 47.6097;
  const longitude = parseFloat(args[1]) || -122.3422;
  const radiusMeters = parseInt(args[2], 10) || 10000;

  console.log('='.repeat(70));
  console.log('SEATTLE PLUGIN TEST');
  console.log('='.repeat(70));
  console.log(`Location: ${latitude}, ${longitude} (Pike Place Market)`);
  console.log(`Radius: ${radiusMeters}m (${(radiusMeters / 1000).toFixed(1)}km)`);
  console.log(`Time: ${new Date().toISOString()}`);
  console.log('');

  const feed = new AlertFeed({
    continueOnPluginError: true,
    pluginTimeoutMs: 60000,
  });

  await feed.registerPlugins([
    { plugin: new NWSWeatherPlugin() },
    { plugin: new SeattlePolicePlugin() },
    { plugin: new SeattleFirePlugin() },
    { plugin: new SeattleEMTPlugin() },
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

  // Test with past-7d to now+1d range (covers both historical and current)
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

  // Summary by source plugin
  console.log('\n' + '-'.repeat(70));
  console.log('ALERTS BY SOURCE');
  console.log('-'.repeat(70));

  const bySource = response.alerts.reduce((acc, a) => {
    acc[a.source.name] = (acc[a.source.name] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  for (const [source, count] of Object.entries(bySource).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${source}: ${count}`);
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
      if (alert.metadata) {
        const metaKeys = Object.keys(alert.metadata).slice(0, 3);
        for (const key of metaKeys) {
          console.log(`    ${key}: ${alert.metadata[key]}`);
        }
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

testSeattle().catch(console.error);
