// Base plugin
export { BasePlugin } from './base-plugin';
export type { BasePluginConfig } from './base-plugin';

// Weather plugins
export { NWSWeatherPlugin } from './weather';
export type { NWSWeatherPluginConfig } from './weather';

// Fire/EMS plugins
export { PhoenixFirePlugin, NIFCWildfirePlugin } from './fire-emt';
export type { PhoenixFirePluginConfig, NIFCWildfirePluginConfig } from './fire-emt';

// Events plugins
export { PhoenixEventsPlugin } from './events';
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
