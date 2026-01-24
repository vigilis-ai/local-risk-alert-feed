/**
 * Run all plugins for a specific location and output results.
 *
 * Usage: npx tsx scripts/run-all-plugins.ts <lat> <lng> <location-name>
 */

import { AlertFeed } from '../src';
import { NWSWeatherPlugin } from '../src/plugins/weather';
import { PhoenixFirePlugin, NIFCWildfirePlugin } from '../src/plugins/fire-emt';
import { PhoenixEventsPlugin, PhoenixConventionCenterPlugin } from '../src/plugins/events';
import { ArizonaTrafficPlugin } from '../src/plugins/traffic';

interface LocationTest {
  name: string;
  latitude: number;
  longitude: number;
}

async function runTest(location: LocationTest, radiusMeters: number = 2000) {
  const output: string[] = [];
  const log = (msg: string) => {
    console.log(msg);
    output.push(msg);
  };

  log('='.repeat(80));
  log(`LOCAL RISK ALERT FEED - PLUGIN TEST RESULTS`);
  log('='.repeat(80));
  log('');
  log(`Location: ${location.name}`);
  log(`Coordinates: ${location.latitude}, ${location.longitude}`);
  log(`Radius: ${radiusMeters}m (${(radiusMeters / 1000).toFixed(1)}km)`);
  log(`Timestamp: ${new Date().toISOString()}`);
  log('');

  // Create the feed
  const feed = new AlertFeed({
    continueOnPluginError: true,
    pluginTimeoutMs: 60000,
  });

  // Check for optional API keys
  const ticketmasterApiKey = process.env.TICKETMASTER_API_KEY;

  // Register all plugins
  await feed.registerPlugins([
    { plugin: new NWSWeatherPlugin() },
    { plugin: new PhoenixFirePlugin({ includeEMS: true }) },
    { plugin: new NIFCWildfirePlugin({ includePrescribedBurns: false }) },
    { plugin: new PhoenixEventsPlugin({
      ticketmasterApiKey,
      enableTicketmaster: !!ticketmasterApiKey,
    }) },
    { plugin: new PhoenixConventionCenterPlugin() },
    { plugin: new ArizonaTrafficPlugin() },
  ]);

  log('-'.repeat(80));
  log('REGISTERED PLUGINS');
  log('-'.repeat(80));

  const plugins = feed.getPluginMetadata();
  for (const p of plugins) {
    log(`  - ${p.name} (${p.id})`);
    log(`    Categories: ${p.supportedCategories.join(', ')}`);
    log(`    Coverage: ${p.coverage.description || p.coverage.type}`);
  }
  log('');

  // Query with past-7d time range
  log('-'.repeat(80));
  log('QUERY PARAMETERS');
  log('-'.repeat(80));

  const timeRange = 'past-7d';

  log(`  Time Range: ${timeRange}`);
  log(`  Radius: ${radiusMeters}m (${(radiusMeters / 1000).toFixed(1)}km)`);
  log('');

  try {
    const response = await feed.query({
      location: { latitude: location.latitude, longitude: location.longitude },
      timeRange,
      radiusMeters,
      limit: 100,
      includePluginResults: true,
    });

    log('-'.repeat(80));
    log('QUERY RESULTS SUMMARY');
    log('-'.repeat(80));
    log(`  Query Time: ${response.meta.queriedAt}`);
    log(`  Time Range: ${response.meta.timeRange.start} to ${response.meta.timeRange.end}`);
    log(`  Total Alerts: ${response.meta.totalCount}`);
    log(`  Truncated: ${response.meta.truncated}`);
    log('');

    log('-'.repeat(80));
    log('PLUGIN RESULTS');
    log('-'.repeat(80));

    if (response.pluginResults) {
      for (const result of response.pluginResults) {
        const status = result.success ? 'SUCCESS' : 'FAILED';
        const cache = result.fromCache ? ' (cached)' : '';
        log(`  [${status}] ${result.pluginName}: ${result.alertCount} alerts in ${result.durationMs}ms${cache}`);
        if (result.error) {
          log(`           Error: ${result.error}`);
        }
        if (result.warnings?.length) {
          for (const w of result.warnings) {
            log(`           Warning: ${w}`);
          }
        }
      }
    }
    log('');

    // Summary by category
    log('-'.repeat(80));
    log('ALERTS BY CATEGORY');
    log('-'.repeat(80));

    const byCategory = response.alerts.reduce((acc, a) => {
      acc[a.category] = (acc[a.category] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    for (const [cat, count] of Object.entries(byCategory).sort((a, b) => b[1] - a[1])) {
      log(`  ${cat}: ${count}`);
    }
    if (Object.keys(byCategory).length === 0) {
      log('  (no alerts)');
    }
    log('');

    // Summary by risk level
    log('-'.repeat(80));
    log('ALERTS BY RISK LEVEL');
    log('-'.repeat(80));

    const byRisk = response.alerts.reduce((acc, a) => {
      acc[a.riskLevel] = (acc[a.riskLevel] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    const riskOrder = ['extreme', 'severe', 'high', 'moderate', 'low'];
    for (const risk of riskOrder) {
      if (byRisk[risk]) {
        log(`  ${risk.toUpperCase()}: ${byRisk[risk]}`);
      }
    }
    if (Object.keys(byRisk).length === 0) {
      log('  (no alerts)');
    }
    log('');

    // Sample alerts by category
    log('-'.repeat(80));
    log('SAMPLE ALERTS (up to 5 per category)');
    log('-'.repeat(80));

    const alertsByCategory: Record<string, typeof response.alerts> = {};
    for (const alert of response.alerts) {
      if (!alertsByCategory[alert.category]) {
        alertsByCategory[alert.category] = [];
      }
      alertsByCategory[alert.category].push(alert);
    }

    for (const [category, alerts] of Object.entries(alertsByCategory)) {
      log('');
      log(`  === ${category.toUpperCase()} ===`);

      for (const alert of alerts.slice(0, 5)) {
        log('');
        log(`  [${alert.riskLevel.toUpperCase()}] ${alert.title}`);
        log(`    ID: ${alert.id}`);
        log(`    Source: ${alert.source.name}`);
        log(`    Type: ${alert.temporalType}`);

        if (alert.location.address) {
          log(`    Address: ${alert.location.address}`);
        }
        if (alert.location.city || alert.location.state) {
          log(`    City/State: ${alert.location.city || ''}, ${alert.location.state || ''}`);
        }
        log(`    Coordinates: ${alert.location.point.latitude.toFixed(4)}, ${alert.location.point.longitude.toFixed(4)}`);

        if (alert.timestamps.eventStart) {
          log(`    Event Start: ${alert.timestamps.eventStart}`);
        }
        log(`    Issued: ${alert.timestamps.issued}`);

        if (alert.description) {
          const desc = alert.description.split('\n').slice(0, 3).join(' | ');
          log(`    Description: ${desc.substring(0, 100)}${desc.length > 100 ? '...' : ''}`);
        }
      }

      if (alerts.length > 5) {
        log(`    ... and ${alerts.length - 5} more ${category} alerts`);
      }
    }

    if (Object.keys(alertsByCategory).length === 0) {
      log('  No alerts found.');
    }

  } catch (error) {
    log(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
  }

  // Cleanup
  await feed.dispose();

  log('');
  log('='.repeat(80));
  log('END OF REPORT');
  log('='.repeat(80));

  return output.join('\n');
}

// Main execution
async function main() {
  const args = process.argv.slice(2);

  if (args.length < 4) {
    console.error('Usage: npx tsx scripts/run-all-plugins.ts <lat> <lng> <radius-meters> <location-name>');
    console.error('Example: npx tsx scripts/run-all-plugins.ts 33.4484 -112.074 2000 "Phoenix Downtown"');
    process.exit(1);
  }

  const latitude = parseFloat(args[0]);
  const longitude = parseFloat(args[1]);
  const radiusMeters = parseInt(args[2], 10);
  const name = args.slice(3).join(' ');

  if (isNaN(latitude) || isNaN(longitude)) {
    console.error('Invalid coordinates');
    process.exit(1);
  }

  if (isNaN(radiusMeters) || radiusMeters <= 0) {
    console.error('Invalid radius');
    process.exit(1);
  }

  const result = await runTest({ name, latitude, longitude }, radiusMeters);

  // Output is already logged, just return for file writing
  return result;
}

main().catch(console.error);
