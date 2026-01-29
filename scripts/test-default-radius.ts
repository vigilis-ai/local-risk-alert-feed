/**
 * Test per-plugin default radius across all locations from the plan.
 * No explicit radius — each plugin uses its own defaultRadiusMeters.
 */

import { AlertFeed } from '../src';
import type { AlertPlugin, PluginMetadata } from '../src/types';
import { NWSWeatherPlugin } from '../src/plugins/weather';
import { SeattlePolicePlugin, SeattleFirePlugin, SeattleEMTPlugin } from '../src/plugins/seattle';
import { AustinTrafficPlugin, AustinFirePlugin, AustinCrimePlugin, AustinEventsPlugin } from '../src/plugins/austin';
import { BendPolicePlugin } from '../src/plugins/police';

interface CityConfig {
  city: string;
  plugins: AlertPlugin[];
  locations: Array<{ name: string; latitude: number; longitude: number }>;
}

const CITIES: CityConfig[] = [
  {
    city: 'Seattle',
    plugins: [
      new NWSWeatherPlugin(),
      new SeattlePolicePlugin(),
      new SeattleFirePlugin(),
      new SeattleEMTPlugin(),
    ],
    locations: [
      { name: 'Pike Place Market', latitude: 47.6097, longitude: -122.3422 },
      { name: 'Climate Pledge Arena', latitude: 47.6221, longitude: -122.3540 },
      { name: 'T-Mobile Park', latitude: 47.5914, longitude: -122.3325 },
    ],
  },
  {
    city: 'Austin',
    plugins: [
      new NWSWeatherPlugin(),
      new AustinTrafficPlugin(),
      new AustinFirePlugin(),
      new AustinCrimePlugin(),
      new AustinEventsPlugin(),
    ],
    locations: [
      { name: 'Austin Downtown', latitude: 30.2672, longitude: -97.7431 },
      { name: 'UT Austin', latitude: 30.2849, longitude: -97.7341 },
    ],
  },
  {
    city: 'Bend',
    plugins: [
      new NWSWeatherPlugin(),
      new BendPolicePlugin(),
    ],
    locations: [
      { name: 'Bend Downtown', latitude: 44.0582, longitude: -121.3153 },
    ],
  },
];

interface Row {
  city: string;
  location: string;
  defaultRadius: string;
  total: number;
  bySource: Record<string, number>;
  byRisk: Record<string, number>;
}

async function run() {
  const now = new Date();
  const start = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const end = new Date(now.getTime() + 1 * 24 * 60 * 60 * 1000);
  const timeRange = { start: start.toISOString(), end: end.toISOString() };

  console.log(`Time range: ${start.toISOString().split('T')[0]} to ${end.toISOString().split('T')[0]} (7-day window)`);
  console.log('Radius: (none specified — using plugin defaults)');
  console.log('');

  const allRows: Row[] = [];
  const allPluginMeta: PluginMetadata[] = [];

  for (const cityConfig of CITIES) {
    const feed = new AlertFeed({
      continueOnPluginError: true,
      pluginTimeoutMs: 60000,
    });

    await feed.registerPlugins(cityConfig.plugins.map(p => ({ plugin: p })));

    // Collect plugin metadata (deduplicate by id)
    for (const p of feed.getPluginMetadata()) {
      if (!allPluginMeta.find(m => m.id === p.id)) {
        allPluginMeta.push(p);
      }
    }

    for (const loc of cityConfig.locations) {
      const response = await feed.query({
        location: { latitude: loc.latitude, longitude: loc.longitude },
        timeRange,
        limit: 1000,
        includePluginResults: true,
      });

      const bySource: Record<string, number> = {};
      const byRisk: Record<string, number> = {};

      for (const alert of response.alerts) {
        bySource[alert.source.pluginId] = (bySource[alert.source.pluginId] || 0) + 1;
        byRisk[alert.riskLevel] = (byRisk[alert.riskLevel] || 0) + 1;
      }

      // Build default radius description from the plugins that contributed
      const pluginRadii = feed.getPluginMetadata()
        .filter(p => p.id !== 'nws-weather') // skip global
        .map(p => p.defaultRadiusMeters)
        .filter((r): r is number => r != null);
      const uniqueRadii = [...new Set(pluginRadii)];
      const defaultRadius = uniqueRadii.length === 1
        ? `${(uniqueRadii[0] / 1000).toFixed(0)}km`
        : uniqueRadii.map(r => `${(r / 1000).toFixed(0)}km`).join('/');

      allRows.push({
        city: cityConfig.city,
        location: loc.name,
        defaultRadius,
        total: response.meta.totalCount,
        bySource,
        byRisk,
      });
    }

    await feed.dispose();
  }

  // Print plugin defaults table
  console.log('='.repeat(100));
  console.log('PLUGIN DEFAULT RADII');
  console.log('='.repeat(100));
  for (const p of allPluginMeta) {
    const r = p.defaultRadiusMeters;
    console.log(`  ${p.name.padEnd(40)} ${r != null ? `${r}m (${(r / 1000).toFixed(0)}km)` : '(framework default 10km)'}`);
  }

  // Collect all source plugin ids across all rows
  const allSourceIds = [...new Set(allRows.flatMap(r => Object.keys(r.bySource)))].sort();

  // Print results table
  console.log('');
  console.log('='.repeat(100));
  console.log('RESULTS BY LOCATION & SOURCE (plugin default radius)');
  console.log('='.repeat(100));

  const hdr = [
    'Location'.padEnd(24),
    'Radius'.padStart(7),
    'Total'.padStart(6),
    ...allSourceIds.map(id => {
      // Shorten plugin ids for column headers
      const short = id.replace(/-/g, ' ').split(' ').map(w => w[0].toUpperCase() + w.slice(1)).join('');
      return short.substring(0, 8).padStart(9);
    }),
  ].join(' | ');
  console.log(hdr);
  console.log('-'.repeat(hdr.length));

  for (const r of allRows) {
    console.log([
      r.location.padEnd(24),
      r.defaultRadius.padStart(7),
      String(r.total).padStart(6),
      ...allSourceIds.map(id => String(r.bySource[id] || '-').padStart(9)),
    ].join(' | '));
  }

  // Print risk table
  const riskLevels = ['extreme', 'severe', 'high', 'moderate', 'low'];

  console.log('');
  console.log('='.repeat(100));
  console.log('RESULTS BY RISK LEVEL');
  console.log('='.repeat(100));

  const riskHdr = [
    'Location'.padEnd(24),
    'Total'.padStart(6),
    ...riskLevels.map(r => r.padStart(9)),
  ].join(' | ');
  console.log(riskHdr);
  console.log('-'.repeat(riskHdr.length));

  for (const r of allRows) {
    console.log([
      r.location.padEnd(24),
      String(r.total).padStart(6),
      ...riskLevels.map(level => String(r.byRisk[level] || 0).padStart(9)),
    ].join(' | '));
  }
}

run().catch(console.error);
