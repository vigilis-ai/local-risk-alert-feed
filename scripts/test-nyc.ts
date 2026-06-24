/**
 * Test NYC plugins across the priority focus areas.
 *
 * Usage: npx tsx scripts/test-nyc.ts [lat] [lng] [radius]
 *   - With no args: runs a tour of FiDi, Hudson Yards, and JFK.
 *   - With args: runs a single location query.
 *
 * Note: Jersey City is in New Jersey and is NOT covered by NYPD data — it has
 * no live open-data crime API (its portal only has 2014-2017 snapshots).
 */

import { AlertFeed } from '../src';
import { NWSWeatherPlugin } from '../src/plugins/weather';
import { NYCCrimePlugin, NYCTrafficPlugin } from '../src/plugins/nyc';

const FOCUS_AREAS: Array<{ name: string; lat: number; lng: number; radius: number }> = [
  { name: 'Financial District (Lower Manhattan)', lat: 40.7075, lng: -74.0113, radius: 1500 },
  { name: 'Hudson Yards', lat: 40.7536, lng: -74.0014, radius: 1500 },
  { name: 'JFK Airport', lat: 40.6413, lng: -73.7781, radius: 3000 },
];

async function queryArea(
  feed: AlertFeed,
  area: { name: string; lat: number; lng: number; radius: number }
) {
  const now = new Date();
  const start = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000); // wide window (data is quarterly)
  const end = now;

  const response = await feed.query({
    location: { latitude: area.lat, longitude: area.lng },
    timeRange: { start: start.toISOString(), end: end.toISOString() },
    radiusMeters: area.radius,
    limit: 200,
    includePluginResults: true,
  });

  console.log('\n' + '='.repeat(70));
  console.log(`${area.name}  (${area.lat}, ${area.lng}, ${(area.radius / 1000).toFixed(1)}km)`);
  console.log('='.repeat(70));
  console.log(`Total Alerts: ${response.meta.totalCount}${response.meta.truncated ? ' (truncated)' : ''}`);

  const byCat = response.alerts.reduce((acc, a) => {
    acc[a.category] = (acc[a.category] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);
  console.log('By category: ' + Object.entries(byCat).map(([c, n]) => `${c}=${n}`).join(' '));

  const byRisk = response.alerts.reduce((acc, a) => {
    acc[a.riskLevel] = (acc[a.riskLevel] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);
  const riskOrder = ['extreme', 'severe', 'high', 'moderate', 'low'];
  console.log('By risk: ' + riskOrder.filter((r) => byRisk[r]).map((r) => `${r}=${byRisk[r]}`).join(' '));

  for (const alert of response.alerts.slice(0, 4)) {
    console.log(`  [${alert.riskLevel.toUpperCase()}] ${alert.title} — ${alert.location.city} (${alert.timestamps.eventStart?.split('T')[0]})`);
  }
}

async function testNYC() {
  const args = process.argv.slice(2);

  const feed = new AlertFeed({ continueOnPluginError: true, pluginTimeoutMs: 60000 });
  await feed.registerPlugins([
    { plugin: new NWSWeatherPlugin() },
    { plugin: new NYCCrimePlugin() },
    { plugin: new NYCTrafficPlugin() },
  ]);

  console.log('NYC PLUGIN TEST — ' + new Date().toISOString());

  if (args.length >= 2) {
    await queryArea(feed, {
      name: 'Custom',
      lat: parseFloat(args[0]),
      lng: parseFloat(args[1]),
      radius: parseInt(args[2], 10) || 1500,
    });
  } else {
    for (const area of FOCUS_AREAS) {
      await queryArea(feed, area);
    }
    console.log('\n[note] Jersey City, NJ is not covered by NYPD data and has no live crime API.');
  }

  await feed.dispose();
  console.log('\nTEST COMPLETE');
}

testNYC().catch(console.error);
