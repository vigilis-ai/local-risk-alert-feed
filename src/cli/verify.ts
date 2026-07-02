#!/usr/bin/env node
/**
 * `vigilis-plugin-verify` — self-certification CLI for plugin endpoints.
 *
 * Point it at a running plugin endpoint (local or deployed) and it runs the
 * conformance suite over HTTP, printing a pass/fail report and exiting non-zero
 * on failure so it drops straight into CI.
 *
 * Usage:
 *   vigilis-plugin-verify \
 *     --endpoint https://plugins.example.com \
 *     --plugin-id acme-flood \
 *     --token "$PLUGIN_TOKEN" \
 *     --signing-secret "$PLUGIN_SIGNING_SECRET" \
 *     [--lat 33.45 --lng -112.02 --radius 5000] [--no-auth] [--json]
 */
import { runConformanceSuite, formatReport, type ConformanceOptions } from '../testing';

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const eq = key.indexOf('=');
    if (eq !== -1) {
      out[key.slice(0, eq)] = key.slice(eq + 1);
    } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
      out[key] = argv[++i];
    } else {
      out[key] = true;
    }
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const endpoint = args.endpoint as string;
  const pluginId = (args['plugin-id'] ?? args.pluginId) as string;
  const token = args.token as string;
  const signingSecret = (args['signing-secret'] ?? args.signingSecret) as string;

  if (!endpoint || !pluginId || !token || !signingSecret) {
    console.error(
      'Missing required args. Usage:\n' +
        '  vigilis-plugin-verify --endpoint <url> --plugin-id <id> --token <t> --signing-secret <s>\n' +
        '    [--lat <n> --lng <n> --radius <m>] [--no-auth] [--json]'
    );
    process.exit(2);
  }

  const options: ConformanceOptions = {
    endpoint,
    pluginId,
    credentials: { token, signingSecret },
    checkAuth: args['no-auth'] !== true,
  };

  if (args.lat && args.lng) {
    options.sampleQuery = {
      location: { latitude: Number(args.lat), longitude: Number(args.lng) },
      ...(args.radius ? { radiusMeters: Number(args.radius) } : {}),
    };
  }

  const report = await runConformanceSuite(options);

  if (args.json === true) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`Conformance report for "${pluginId}" @ ${endpoint}\n`);
    console.log(formatReport(report));
  }

  process.exit(report.passed ? 0 : 1);
}

main().catch((err) => {
  console.error('verify failed:', err instanceof Error ? err.message : err);
  process.exit(2);
});
