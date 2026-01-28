/**
 * Test temporal filtering with various time ranges.
 *
 * Run with: npx tsx scripts/test-time-ranges.ts
 */

import { AlertFeed } from '../src';
import { NWSWeatherPlugin } from '../src/plugins/weather';
import { NIFCWildfirePlugin } from '../src/plugins/fire-emt';
import { BendPolicePlugin } from '../src/plugins/police';
import { PhoenixEventsPlugin } from '../src/plugins/events';

async function test() {
  const feed = new AlertFeed({
    continueOnPluginError: true,
    pluginTimeoutMs: 60000,
  });

  await feed.registerPlugins([
    { plugin: new NWSWeatherPlugin() },
    { plugin: new NIFCWildfirePlugin() },
    { plugin: new BendPolicePlugin() },
    { plugin: new PhoenixEventsPlugin() }, // Future-only plugin for comparison
  ]);

  const location = { latitude: 44.0582, longitude: -121.3153 };
  const radiusMeters = 25000;

  // Show plugin temporal characteristics
  console.log('='.repeat(70));
  console.log('PLUGIN TEMPORAL CHARACTERISTICS');
  console.log('='.repeat(70));

  const plugins = feed.getPluginMetadata();
  for (const p of plugins) {
    console.log('\n' + p.name + ' (' + p.id + ')');
    console.log('  Supports Past: ' + p.temporal.supportsPast);
    console.log('  Supports Future: ' + p.temporal.supportsFuture);
    if (p.temporal.dataLagMinutes !== undefined) {
      const hours = Math.round(p.temporal.dataLagMinutes / 60);
      console.log('  Data Lag: ~' + hours + ' hours');
    }
    if (p.temporal.futureLookaheadMinutes !== undefined) {
      const days = Math.round(p.temporal.futureLookaheadMinutes / 1440);
      console.log('  Future Lookahead: ' + days + ' days');
    }
    console.log('  Description: ' + p.temporal.freshnessDescription);
  }

  // Test 1: Default time range (next-24h) - future only
  console.log('\n' + '='.repeat(70));
  console.log('TEST 1: Default time range (next-24h - future only)');
  console.log('Expected: Future-supporting plugins only, past-only plugins SKIPPED');
  console.log('='.repeat(70));

  const defaultResult = await feed.query({
    location,
    radiusMeters,
    includePluginResults: true,
  });

  console.log('Time range: ' + defaultResult.meta.timeRange.start + ' to ' + defaultResult.meta.timeRange.end);
  console.log('Total alerts: ' + defaultResult.meta.totalCount);
  console.log('\nPlugin Results:');
  if (defaultResult.pluginResults) {
    for (const pr of defaultResult.pluginResults) {
      if (pr.skipped) {
        console.log('  [SKIPPED] ' + pr.pluginName + ': ' + pr.skipReason);
      } else {
        console.log('  [RAN] ' + pr.pluginName + ': ' + pr.alertCount + ' alerts');
      }
    }
  }

  // Test 2: past-24h only
  console.log('\n' + '='.repeat(70));
  console.log('TEST 2: past-24h time range (historical only)');
  console.log('Expected: Delayed plugins SKIPPED (data not yet available)');
  console.log('='.repeat(70));

  const past24hResult = await feed.query({
    location,
    radiusMeters,
    timeRange: 'past-24h',
    includePluginResults: true,
  });

  console.log('Time range: ' + past24hResult.meta.timeRange.start + ' to ' + past24hResult.meta.timeRange.end);
  console.log('Total alerts: ' + past24hResult.meta.totalCount);
  console.log('\nPlugin Results:');
  if (past24hResult.pluginResults) {
    for (const pr of past24hResult.pluginResults) {
      if (pr.skipped) {
        console.log('  [SKIPPED] ' + pr.pluginName + ': ' + pr.skipReason);
      } else {
        console.log('  [RAN] ' + pr.pluginName + ': ' + pr.alertCount + ' alerts');
      }
    }
  }

  // Test 3: past-7d time range
  console.log('\n' + '='.repeat(70));
  console.log('TEST 3: past-7d time range');
  console.log('Expected: All past-supporting plugins run (data lag is within range)');
  console.log('='.repeat(70));

  const past7dResult = await feed.query({
    location,
    radiusMeters,
    timeRange: 'past-7d',
    includePluginResults: true,
  });

  console.log('Time range: ' + past7dResult.meta.timeRange.start + ' to ' + past7dResult.meta.timeRange.end);
  console.log('Total alerts: ' + past7dResult.meta.totalCount);
  console.log('\nPlugin Results:');
  if (past7dResult.pluginResults) {
    for (const pr of past7dResult.pluginResults) {
      if (pr.skipped) {
        console.log('  [SKIPPED] ' + pr.pluginName + ': ' + pr.skipReason);
      } else {
        console.log('  [RAN] ' + pr.pluginName + ': ' + pr.alertCount + ' alerts');
      }
    }
  }

  // Test 4: Custom range -7d to +1d (typical real-world query)
  console.log('\n' + '='.repeat(70));
  console.log('TEST 4: Custom range -7d to +1d (typical real-world query)');
  console.log('Expected: All plugins run (spans both past and future)');
  console.log('='.repeat(70));

  const now = new Date();
  const start7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const end1d = new Date(now.getTime() + 1 * 24 * 60 * 60 * 1000);

  const combinedResult = await feed.query({
    location,
    radiusMeters,
    timeRange: {
      start: start7d.toISOString(),
      end: end1d.toISOString(),
    },
    includePluginResults: true,
  });

  console.log('Time range: ' + combinedResult.meta.timeRange.start + ' to ' + combinedResult.meta.timeRange.end);
  console.log('Total alerts: ' + combinedResult.meta.totalCount);
  console.log('\nPlugin Results:');
  if (combinedResult.pluginResults) {
    for (const pr of combinedResult.pluginResults) {
      if (pr.skipped) {
        console.log('  [SKIPPED] ' + pr.pluginName + ': ' + pr.skipReason);
      } else {
        console.log('  [RAN] ' + pr.pluginName + ': ' + pr.alertCount + ' alerts');
      }
    }
  }

  // Test 5: next-7d (future only)
  console.log('\n' + '='.repeat(70));
  console.log('TEST 5: next-7d time range (future only)');
  console.log('Expected: Past-only plugins SKIPPED');
  console.log('='.repeat(70));

  const next7dResult = await feed.query({
    location,
    radiusMeters,
    timeRange: 'next-7d',
    includePluginResults: true,
  });

  console.log('Time range: ' + next7dResult.meta.timeRange.start + ' to ' + next7dResult.meta.timeRange.end);
  console.log('Total alerts: ' + next7dResult.meta.totalCount);
  console.log('\nPlugin Results:');
  if (next7dResult.pluginResults) {
    for (const pr of next7dResult.pluginResults) {
      if (pr.skipped) {
        console.log('  [SKIPPED] ' + pr.pluginName + ': ' + pr.skipReason);
      } else {
        console.log('  [RAN] ' + pr.pluginName + ': ' + pr.alertCount + ' alerts');
      }
    }
  }

  await feed.dispose();
  console.log('\n' + '='.repeat(70));
  console.log('All tests complete!');
  console.log('='.repeat(70));
}

test().catch(console.error);
