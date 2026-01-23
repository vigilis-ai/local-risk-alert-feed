/**
 * Test script for Phoenix Fire plugin debugging.
 */
import { PhoenixFirePlugin } from '../src/plugins/fire-emt/phoenix-fire.plugin';

async function test() {
  const plugin = new PhoenixFirePlugin({ includeEMS: true });
  console.log('Plugin:', plugin.metadata.name);
  console.log('Coverage:', plugin.metadata.coverage.description);
  console.log();

  // Use past-7d time range
  const now = new Date();
  const start = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  console.log('Time range:');
  console.log('  Start:', start.toISOString());
  console.log('  End:', now.toISOString());
  console.log('  Start (ms):', start.getTime());
  console.log('  End (ms):', now.getTime());
  console.log();

  // Query for Phoenix downtown
  const result = await plugin.fetchAlerts({
    location: { latitude: 33.4484, longitude: -112.074 }, // Phoenix downtown
    timeRange: { start: start.toISOString(), end: now.toISOString() },
    radiusMeters: 50000, // 50km
  });

  console.log('Found', result.alerts.length, 'fire incidents');
  console.log('From cache:', result.fromCache);

  if (result.warnings) {
    console.log('Warnings:', result.warnings);
  }

  for (const alert of result.alerts.slice(0, 5)) {
    console.log();
    console.log(`[${alert.riskLevel.toUpperCase()}] ${alert.title}`);
    console.log(`  Location: ${alert.location.city || 'Unknown'}`);
    console.log(`  Type: ${alert.metadata?.type}`);
    console.log(`  Category: ${alert.metadata?.category}`);
    console.log(`  Issued: ${alert.timestamps.issued}`);
  }
}

test().catch(console.error);
