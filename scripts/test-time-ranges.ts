/**
 * Test Bend Police plugin with various time ranges.
 *
 * Run with: npx tsx scripts/test-time-ranges.ts
 */

import { AlertFeed } from '../src';
import { NWSWeatherPlugin } from '../src/plugins/weather';
import { NIFCWildfirePlugin } from '../src/plugins/fire-emt';
import { BendPolicePlugin } from '../src/plugins/police';

async function test() {
  const feed = new AlertFeed({
    continueOnPluginError: true,
    pluginTimeoutMs: 60000,
  });

  await feed.registerPlugins([
    { plugin: new NWSWeatherPlugin() },
    { plugin: new NIFCWildfirePlugin() },
    { plugin: new BendPolicePlugin() },
  ]);

  const location = { latitude: 44.0582, longitude: -121.3153 };
  const radiusMeters = 25000;

  // Test 1: Default time range (next-24h) - should show future scheduled events
  console.log('='.repeat(70));
  console.log('TEST 1: Default time range (next-24h - future only)');
  console.log('='.repeat(70));

  const defaultResult = await feed.query({
    location,
    radiusMeters,
    includePluginResults: true,
  });

  console.log('Time range: ' + defaultResult.meta.timeRange.start + ' to ' + defaultResult.meta.timeRange.end);
  console.log('Total alerts: ' + defaultResult.meta.totalCount);
  if (defaultResult.pluginResults) {
    for (const pr of defaultResult.pluginResults) {
      console.log('  ' + pr.pluginName + ': ' + pr.alertCount + ' alerts');
    }
  }
  console.log();

  // Test 2: past-24h only - should show recent police activity
  console.log('='.repeat(70));
  console.log('TEST 2: past-24h time range (historical only)');
  console.log('='.repeat(70));

  const past24hResult = await feed.query({
    location,
    radiusMeters,
    timeRange: 'past-24h',
    includePluginResults: true,
  });

  console.log('Time range: ' + past24hResult.meta.timeRange.start + ' to ' + past24hResult.meta.timeRange.end);
  console.log('Total alerts: ' + past24hResult.meta.totalCount);
  if (past24hResult.pluginResults) {
    for (const pr of past24hResult.pluginResults) {
      console.log('  ' + pr.pluginName + ': ' + pr.alertCount + ' alerts');
    }
  }
  console.log();

  // Test 3: Custom range -24h to +24h (typical use case)
  console.log('='.repeat(70));
  console.log('TEST 3: Custom range -24h to +24h (typical real-world use)');
  console.log('='.repeat(70));

  const now = new Date();
  const start24h = new Date(now.getTime() - 24 * 60 * 60 * 1000); // -24h
  const end24h = new Date(now.getTime() + 24 * 60 * 60 * 1000);   // +24h

  const combinedResult = await feed.query({
    location,
    radiusMeters,
    timeRange: {
      start: start24h.toISOString(),
      end: end24h.toISOString(),
    },
    includePluginResults: true,
  });

  console.log('Time range: ' + combinedResult.meta.timeRange.start + ' to ' + combinedResult.meta.timeRange.end);
  console.log('Total alerts: ' + combinedResult.meta.totalCount);
  if (combinedResult.pluginResults) {
    for (const pr of combinedResult.pluginResults) {
      console.log('  ' + pr.pluginName + ': ' + pr.alertCount + ' alerts');
    }
  }

  // Show sample alerts
  if (combinedResult.alerts.length > 0) {
    console.log('\nSample alerts from combined range:');
    for (const alert of combinedResult.alerts.slice(0, 5)) {
      const risk = alert.riskLevel.toUpperCase();
      console.log('  [' + risk + '] ' + alert.title);
      console.log('    Source: ' + alert.source.name);
      console.log('    Time: ' + (alert.timestamps.eventStart || alert.timestamps.issued));
      console.log('    Category: ' + alert.category);
      console.log();
    }
  }
  console.log();

  // Test 4: Custom range -7d to +1d
  console.log('='.repeat(70));
  console.log('TEST 4: Custom range -7d to +1d');
  console.log('='.repeat(70));

  const start7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000); // -7d
  const end1d = new Date(now.getTime() + 1 * 24 * 60 * 60 * 1000);   // +1d

  const weekResult = await feed.query({
    location,
    radiusMeters,
    timeRange: {
      start: start7d.toISOString(),
      end: end1d.toISOString(),
    },
    includePluginResults: true,
  });

  console.log('Time range: ' + weekResult.meta.timeRange.start + ' to ' + weekResult.meta.timeRange.end);
  console.log('Total alerts: ' + weekResult.meta.totalCount);
  if (weekResult.pluginResults) {
    for (const pr of weekResult.pluginResults) {
      console.log('  ' + pr.pluginName + ': ' + pr.alertCount + ' alerts');
    }
  }

  // Breakdown by category
  const byCategory: Record<string, number> = {};
  for (const a of weekResult.alerts) {
    byCategory[a.category] = (byCategory[a.category] || 0) + 1;
  }

  console.log('\nBy category:');
  const sortedCategories = Object.entries(byCategory).sort((a, b) => b[1] - a[1]);
  for (const [cat, count] of sortedCategories) {
    console.log('  ' + cat + ': ' + count);
  }

  // Breakdown by risk level
  const byRisk: Record<string, number> = {};
  for (const a of weekResult.alerts) {
    byRisk[a.riskLevel] = (byRisk[a.riskLevel] || 0) + 1;
  }

  console.log('\nBy risk level:');
  const riskOrder = ['extreme', 'severe', 'high', 'moderate', 'low'];
  for (const risk of riskOrder) {
    if (byRisk[risk]) {
      console.log('  ' + risk.toUpperCase() + ': ' + byRisk[risk]);
    }
  }

  // Test 5: Query for specific day when data exists (Jan 26)
  console.log('\n' + '='.repeat(70));
  console.log('TEST 5: Query for Jan 26 only (verify filtering works)');
  console.log('='.repeat(70));

  const jan26Result = await feed.query({
    location,
    radiusMeters,
    timeRange: {
      start: '2026-01-26T00:00:00Z',
      end: '2026-01-26T23:59:59Z',
    },
    includePluginResults: true,
  });

  console.log('Time range: ' + jan26Result.meta.timeRange.start + ' to ' + jan26Result.meta.timeRange.end);
  console.log('Total alerts: ' + jan26Result.meta.totalCount);
  if (jan26Result.pluginResults) {
    for (const pr of jan26Result.pluginResults) {
      console.log('  ' + pr.pluginName + ': ' + pr.alertCount + ' alerts');
    }
  }

  if (jan26Result.alerts.length > 0) {
    console.log('\nFirst 3 alerts from Jan 26:');
    for (const a of jan26Result.alerts.slice(0, 3)) {
      const risk = a.riskLevel.toUpperCase();
      console.log('  [' + risk + '] ' + a.title);
      console.log('    Time: ' + a.timestamps.eventStart);
    }
  }

  // Test 6: Query for Jan 27 (should have fewer/no results due to data lag)
  console.log('\n' + '='.repeat(70));
  console.log('TEST 6: Query for Jan 27 only (recent - may have data lag)');
  console.log('='.repeat(70));

  const jan27Result = await feed.query({
    location,
    radiusMeters,
    timeRange: {
      start: '2026-01-27T00:00:00Z',
      end: '2026-01-27T23:59:59Z',
    },
    includePluginResults: true,
  });

  console.log('Time range: ' + jan27Result.meta.timeRange.start + ' to ' + jan27Result.meta.timeRange.end);
  console.log('Total alerts: ' + jan27Result.meta.totalCount);
  if (jan27Result.pluginResults) {
    for (const pr of jan27Result.pluginResults) {
      console.log('  ' + pr.pluginName + ': ' + pr.alertCount + ' alerts');
    }
  }

  await feed.dispose();
  console.log('\n' + '='.repeat(70));
  console.log('All tests complete!');
  console.log('='.repeat(70));
  console.log('\nNOTE: Bend Police data has ~24-48 hour delay from real-time.');
  console.log('The most recent data available is from Jan 26, 2026.');
}

test().catch(console.error);
