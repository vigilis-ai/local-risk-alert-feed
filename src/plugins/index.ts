// Base plugin
export { BasePlugin } from './base-plugin';
export type { BasePluginConfig } from './base-plugin';

// Default plugin list (every production plugin, ready to register)
export { createDefaultPlugins } from './defaults';
export type { DefaultPluginsOptions } from './defaults';

// Baseline risk (historical, percentile-scored summary plugins)
export {
  BaselineRiskPlugin,
  scoreCells,
  percentileToRisk,
} from './baseline';
export type {
  BaselineRiskPluginConfig,
  CellStat,
  CellSeverity,
  ScoredCell,
  BaselineSummaryMetadata,
  RiskSurfaceCell,
} from './baseline';
export { PhoenixCrimeRiskPlugin } from './phoenix-crime';
export type { PhoenixCrimeRiskPluginConfig } from './phoenix-crime';

export { PhoenixRegionalActiveIncidentsPlugin } from './phoenix-regional';
export type { PhoenixRegionalActiveIncidentsPluginConfig } from './phoenix-regional';

// Weather plugins
export { NWSWeatherPlugin, classifyNwsEvent } from './weather';
export type { NWSWeatherPluginConfig } from './weather';

// Fire/EMS plugins
export { PhoenixFirePlugin, NIFCWildfirePlugin } from './fire-emt';
export type { PhoenixFirePluginConfig, NIFCWildfirePluginConfig } from './fire-emt';

// Events plugins
export { PhoenixEventsPlugin, PhoenixConventionCenterPlugin } from './events';
export type { PhoenixEventsPluginConfig } from './events';

// Traffic plugins
export { ArizonaTrafficPlugin } from './traffic';
export type { ArizonaTrafficPluginConfig } from './traffic';

// Air quality plugins
export { AirNowPlugin } from './air-quality';
export type { AirNowPluginConfig } from './air-quality';

// Police plugins
export { BendPolicePlugin } from './police';
export type { BendPolicePluginConfig } from './police';

// Austin plugins
export { AustinTrafficPlugin, AustinFirePlugin, AustinCrimePlugin, AustinEventsPlugin } from './austin';
export type {
  AustinTrafficPluginConfig,
  AustinFirePluginConfig,
  AustinCrimePluginConfig,
  AustinEventsPluginConfig,
} from './austin';

// Seattle plugins
export { SeattlePolicePlugin, SeattleFirePlugin, SeattleEMTPlugin } from './seattle';
export type {
  SeattlePolicePluginConfig,
  SeattleFirePluginConfig,
  SeattleEMTPluginConfig,
} from './seattle';

// Atlanta plugins
export { AtlantaCrimePlugin, AtlantaTrafficPlugin } from './atlanta';
export type { AtlantaCrimePluginConfig, AtlantaTrafficPluginConfig } from './atlanta';

// NYC plugins
export { NYCCrimePlugin, NYCTrafficPlugin } from './nyc';
export type { NYCCrimePluginConfig, NYCTrafficPluginConfig } from './nyc';

// New Jersey plugins
export { NJWorkZonesPlugin, mapWorkZoneRisk } from './nj';
export type { NJWorkZonesPluginConfig } from './nj';

// MTA plugins
export { MTAAlertsPlugin } from './mta';
export type { MTAAlertsPluginConfig } from './mta';

// TRANSCOM (NY/NJ/CT aggregator) — SCAFFOLD, pending registration (see plugin header)
export { TRANSCOMPlugin, mapTranscomSeverity } from './transcom';
export type { TRANSCOMPluginConfig } from './transcom';

// Airport plugins
export { FAAAirportStatusPlugin, parseFaaDurationMinutes } from './airport';
export type { FAAAirportStatusPluginConfig } from './airport';

// Glendale plugins
export { GlendaleEventsPlugin, GlendalePolicePlugin, GlendaleFirePlugin } from './glendale';
export type {
  GlendaleEventsPluginConfig,
  GlendalePolicePluginConfig,
  GlendaleFirePluginConfig,
} from './glendale';
