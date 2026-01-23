/**
 * Test script for NIFC Wildfire plugin.
 */
import { NIFCWildfirePlugin } from '../src/plugins/fire-emt/nifc-wildfire.plugin';

async function test() {
  // Test with all US wildfires including prescribed burns
  const plugin = new NIFCWildfirePlugin({ includePrescribedBurns: true });
  console.log('Plugin:', plugin.metadata.name);
  console.log('Coverage:', plugin.metadata.coverage.description);
  console.log();

  // Query for US center - should get some results
  const result = await plugin.fetchAlerts({
    location: { latitude: 39.8283, longitude: -98.5795 }, // US center
    timeRange: { start: new Date().toISOString(), end: new Date().toISOString() },
    radiusMeters: 3000000, // 3000km - full US
  });

  console.log('Found', result.alerts.length, 'fire incidents');

  for (const alert of result.alerts.slice(0, 5)) {
    console.log();
    console.log(`[${alert.riskLevel.toUpperCase()}] ${alert.title}`);
    console.log(`  Location: ${alert.location.state || 'Unknown'}`);
    console.log(`  Type: ${alert.metadata?.incidentType}`);
    if (alert.metadata?.acres) {
      console.log(`  Acres: ${alert.metadata.acres}`);
    }
    if (alert.metadata?.percentContained !== undefined) {
      console.log(`  Containment: ${alert.metadata.percentContained}%`);
    }
  }
}

test().catch(console.error);
