/**
 * Test Glendale plugins for Tanger Outlets Phoenix.
 *
 * Usage: npx tsx scripts/test-glendale.ts
 * Location: Tanger Outlets Phoenix (33.5340, -112.2340)
 */

import { AlertFeed } from '../src';
import { NWSWeatherPlugin } from '../src/plugins/weather';
import { NIFCWildfirePlugin } from '../src/plugins/fire-emt';
import { ArizonaTrafficPlugin } from '../src/plugins/traffic';
import { GlendaleEventsPlugin, GlendalePolicePlugin, GlendaleFirePlugin } from '../src/plugins/glendale';

// Tanger Outlets Phoenix
const LOCATION = { latitude: 33.5340, longitude: -112.2340 };
const RADIUS = 10_000; // 10km

async function runQuery(
  feed: AlertFeed,
  label: string,
  timeRange: { start: string; end: string },
  limit = 200
) {
  console.log('\n' + '='.repeat(70));
  console.log(label);
  console.log('='.repeat(70));
  console.log(`Time Range: ${timeRange.start} to ${timeRange.end}`);

  const response = await feed.query({
    location: LOCATION,
    timeRange,
    radiusMeters: RADIUS,
    limit,
    includePluginResults: true,
  });

  console.log(`Total Alerts: ${response.meta.totalCount}`);
  console.log(`Truncated: ${response.meta.truncated}`);

  // Plugin results
  if (response.pluginResults) {
    console.log('\nPlugin Results:');
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

  // By category
  const byCategory = response.alerts.reduce((acc, a) => {
    acc[a.category] = (acc[a.category] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  if (Object.keys(byCategory).length > 0) {
    console.log('\nBy Category:');
    for (const [cat, count] of Object.entries(byCategory).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${cat}: ${count}`);
    }
  }

  // By risk level
  const byRisk = response.alerts.reduce((acc, a) => {
    acc[a.riskLevel] = (acc[a.riskLevel] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  if (Object.keys(byRisk).length > 0) {
    console.log('\nBy Risk Level:');
    const riskOrder = ['extreme', 'severe', 'high', 'moderate', 'low'];
    for (const risk of riskOrder) {
      if (byRisk[risk]) {
        console.log(`  ${risk.toUpperCase()}: ${byRisk[risk]}`);
      }
    }
  }

  // By source
  const bySource = response.alerts.reduce((acc, a) => {
    acc[a.source.name] = (acc[a.source.name] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  if (Object.keys(bySource).length > 0) {
    console.log('\nBy Source:');
    for (const [source, count] of Object.entries(bySource).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${source}: ${count}`);
    }
  }

  // Print all alerts
  if (response.alerts.length > 0) {
    console.log('\n' + '-'.repeat(70));
    console.log('ALL ALERTS');
    console.log('-'.repeat(70));

    for (const alert of response.alerts) {
      const time = alert.timestamps.eventStart
        ? new Date(alert.timestamps.eventStart).toLocaleString('en-US', { timeZone: 'America/Phoenix' })
        : 'N/A';
      console.log(`\n  [${alert.riskLevel.toUpperCase()}] ${alert.title}`);
      console.log(`    Source: ${alert.source.name} | Category: ${alert.category}`);
      console.log(`    Time: ${time}`);
      if (alert.location.address) {
        console.log(`    Address: ${alert.location.address}`);
      }
      console.log(`    Location: ${alert.location.city}, ${alert.location.state} (${alert.location.point.latitude.toFixed(4)}, ${alert.location.point.longitude.toFixed(4)})`);
      if (alert.description) {
        // Indent description lines
        const descLines = alert.description.split('\n').slice(0, 4);
        for (const line of descLines) {
          console.log(`    ${line}`);
        }
      }
    }
  } else {
    console.log('\n  (No alerts found for this time range)');
  }

  return response;
}

async function testGlendale() {
  console.log('='.repeat(70));
  console.log('GLENDALE / TANGER OUTLETS PHOENIX - FEED TEST');
  console.log('='.repeat(70));
  console.log(`Customer: Tanger Outlets Phoenix`);
  console.log(`Address: 6800 N 95th Ave, Glendale, AZ 85305`);
  console.log(`Location: ${LOCATION.latitude}, ${LOCATION.longitude}`);
  console.log(`Radius: ${RADIUS}m (${(RADIUS / 1000).toFixed(1)}km)`);
  console.log(`Current Time: ${new Date().toISOString()}`);

  const feed = new AlertFeed({
    continueOnPluginError: true,
    pluginTimeoutMs: 60000,
  });

  await feed.registerPlugins([
    { plugin: new GlendaleEventsPlugin({ ticketmasterApiKey: process.env.TICKETMASTER_API_KEY }) },
    { plugin: new GlendalePolicePlugin() },
    { plugin: new GlendaleFirePlugin({ includeEMS: true }) },
    { plugin: new NWSWeatherPlugin() },
    { plugin: new NIFCWildfirePlugin() },
    { plugin: new ArizonaTrafficPlugin() },
  ]);

  // Show plugin metadata
  console.log('\n' + '-'.repeat(70));
  console.log('REGISTERED PLUGINS');
  console.log('-'.repeat(70));

  const plugins = feed.getPluginMetadata();
  for (const p of plugins) {
    console.log(`  ${p.name} (${p.id}) — ${p.coverage.description}`);
  }

  const now = new Date();

  // --- 1. PAST 7 DAYS ---
  const past7d = {
    start: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString(),
    end: now.toISOString(),
  };
  await runQuery(feed, 'LAST 7 DAYS — What has happened?', past7d, 500);

  // --- 2. TODAY ---
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  const todayEnd = new Date(now);
  todayEnd.setHours(23, 59, 59, 999);
  const today = {
    start: todayStart.toISOString(),
    end: todayEnd.toISOString(),
  };
  await runQuery(feed, 'TODAY — What is happening?', today);

  // --- 3. TOMORROW ---
  const tomorrowStart = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000);
  const tomorrowEnd = new Date(todayEnd.getTime() + 24 * 60 * 60 * 1000);
  const tomorrow = {
    start: tomorrowStart.toISOString(),
    end: tomorrowEnd.toISOString(),
  };
  await runQuery(feed, 'TOMORROW — What is coming?', tomorrow);

  // --- 4. NEXT 7 DAYS ---
  const next7d = {
    start: now.toISOString(),
    end: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(),
  };
  await runQuery(feed, 'NEXT 7 DAYS — What is upcoming?', next7d);

  await feed.dispose();

  console.log('\n' + '='.repeat(70));
  console.log('TEST COMPLETE');
  console.log('='.repeat(70));
}

testGlendale().catch(console.error);
