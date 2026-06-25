import type { AlertPlugin, PluginRegistration } from '../types';

import { NWSWeatherPlugin } from './weather';
import { PhoenixFirePlugin, NIFCWildfirePlugin } from './fire-emt';
import { PhoenixEventsPlugin, PhoenixConventionCenterPlugin } from './events';
import { ArizonaTrafficPlugin } from './traffic';
import { AirNowPlugin } from './air-quality';
import { BendPolicePlugin } from './police';
import { AustinTrafficPlugin, AustinFirePlugin, AustinCrimePlugin, AustinEventsPlugin } from './austin';
import { SeattlePolicePlugin, SeattleFirePlugin, SeattleEMTPlugin } from './seattle';
import { GlendaleEventsPlugin, GlendalePolicePlugin, GlendaleFirePlugin } from './glendale';
import { AtlantaCrimePlugin, AtlantaTrafficPlugin } from './atlanta';
import { NYCCrimePlugin, NYCTrafficPlugin } from './nyc';
import { NJWorkZonesPlugin } from './nj';
import { MTAAlertsPlugin } from './mta';
import { FAAAirportStatusPlugin } from './airport';
import { TRANSCOMPlugin } from './transcom';

/**
 * Options for {@link createDefaultPlugins}. Each key falls back to the matching
 * environment variable. Plugins whose constructors require a key are only
 * included when that key is available.
 */
export interface DefaultPluginsOptions {
  /** Ticketmaster Discovery key (Phoenix/Glendale events). Env: TICKETMASTER_API_KEY */
  ticketmasterApiKey?: string;
  /** EPA AirNow key. Env: AIRNOW_API_KEY. AirNow is only added when present. */
  airnowApiKey?: string;
  /** Georgia 511 key (Atlanta traffic). Env: GEORGIA_511_API_KEY. Only added when present. */
  georgia511ApiKey?: string;
  /** TRANSCOM event-feed URL. Env: TRANSCOM_FEED_URL. TRANSCOM is always registered but stays disabled until this is set. */
  transcomFeedUrl?: string;
  /** TRANSCOM key, if the feed uses one. Env: TRANSCOM_API_KEY */
  transcomApiKey?: string;
}

/**
 * The canonical default plugin list for the feed — every production plugin,
 * ready to register. Plugins are location-scoped, so registering all of them is
 * safe: the feed resolves the applicable ones per query.
 *
 * - Keyless plugins are always included.
 * - Key-required plugins (AirNow, Atlanta traffic) are included only when their
 *   key is provided (otherwise their constructors would throw).
 * - TRANSCOM is always included but stays disabled (zero alerts + a warning)
 *   until `transcomFeedUrl` / TRANSCOM_FEED_URL is set, at which point it
 *   activates with no code change.
 */
export function createDefaultPlugins(options: DefaultPluginsOptions = {}): PluginRegistration[] {
  const ticketmasterApiKey = options.ticketmasterApiKey ?? process.env.TICKETMASTER_API_KEY;
  const airnowApiKey = options.airnowApiKey ?? process.env.AIRNOW_API_KEY;
  const georgia511ApiKey = options.georgia511ApiKey ?? process.env.GEORGIA_511_API_KEY;
  const transcomFeedUrl = options.transcomFeedUrl ?? process.env.TRANSCOM_FEED_URL;
  const transcomApiKey = options.transcomApiKey ?? process.env.TRANSCOM_API_KEY;

  const plugins: AlertPlugin[] = [
    // National / keyless
    new NWSWeatherPlugin(),
    new NIFCWildfirePlugin(),
    new FAAAirportStatusPlugin(),

    // Phoenix / Arizona
    new PhoenixFirePlugin({ includeEMS: true }),
    new PhoenixEventsPlugin({ ticketmasterApiKey, enableTicketmaster: !!ticketmasterApiKey }),
    new PhoenixConventionCenterPlugin(),
    new ArizonaTrafficPlugin(),

    // Bend, OR
    new BendPolicePlugin(),

    // Austin, TX
    new AustinTrafficPlugin(),
    new AustinFirePlugin(),
    new AustinCrimePlugin(),
    new AustinEventsPlugin(),

    // Seattle, WA
    new SeattlePolicePlugin(),
    new SeattleFirePlugin(),
    new SeattleEMTPlugin(),

    // Glendale, AZ
    new GlendaleFirePlugin(),
    new GlendalePolicePlugin(),
    new GlendaleEventsPlugin({ ticketmasterApiKey, enableTicketmaster: !!ticketmasterApiKey }),

    // Atlanta, GA
    new AtlantaCrimePlugin(),

    // New York City
    new NYCCrimePlugin(),
    new NYCTrafficPlugin(),

    // New Jersey / Jersey City
    new NJWorkZonesPlugin(),

    // MTA subway
    new MTAAlertsPlugin(),

    // TRANSCOM (NY/NJ/CT incl. Port Authority/PATH) — registered but disabled
    // until a feed URL is set (registration reopens 2026-08-01).
    new TRANSCOMPlugin({ feedUrl: transcomFeedUrl, apiKey: transcomApiKey }),
  ];

  // Key-required plugins — include only when the key is available.
  if (airnowApiKey) {
    plugins.push(new AirNowPlugin({ apiKey: airnowApiKey }));
  }
  if (georgia511ApiKey) {
    plugins.push(new AtlantaTrafficPlugin({ apiKey: georgia511ApiKey }));
  }

  return plugins.map((plugin) => ({ plugin }));
}
