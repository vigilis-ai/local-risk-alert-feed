import type { PluginMetadata, PluginFetchOptions, PluginFetchResult, RiskLevel } from '../../types';
import { BasePlugin, BasePluginConfig } from '../base-plugin';

/**
 * AirNow observation structure.
 */
interface AirNowObservation {
  DateObserved: string;
  HourObserved: number;
  LocalTimeZone: string;
  ReportingArea: string;
  StateCode: string;
  Latitude: number;
  Longitude: number;
  ParameterName: string; // 'O3', 'PM2.5', 'PM10'
  AQI: number;
  Category: {
    Number: number; // 1-6
    Name: string;
  };
}

/**
 * AirNow forecast structure.
 */
interface AirNowForecast {
  DateIssue: string;
  DateForecast: string;
  ReportingArea: string;
  StateCode: string;
  Latitude: number;
  Longitude: number;
  ParameterName: string;
  AQI: number;
  Category: {
    Number: number;
    Name: string;
  };
  ActionDay: boolean;
  Discussion?: string;
}

/**
 * AirNow plugin configuration.
 */
export interface AirNowPluginConfig extends BasePluginConfig {
  /** AirNow API key (get one at https://docs.airnowapi.org) */
  apiKey: string;
  /** Include forecasts in addition to current observations. Default: true */
  includeForecast?: boolean;
  /** Distance in miles for nearby observations. Default: 25 */
  distanceMiles?: number;
}

/**
 * AQI Category to risk level mapping.
 * Based on EPA AQI scale:
 * 1: Good (0-50)
 * 2: Moderate (51-100)
 * 3: Unhealthy for Sensitive Groups (101-150)
 * 4: Unhealthy (151-200)
 * 5: Very Unhealthy (201-300)
 * 6: Hazardous (301+)
 */
const AQI_CATEGORY_RISK_MAP: Record<number, RiskLevel> = {
  1: 'low',        // Good
  2: 'low',        // Moderate
  3: 'moderate',   // Unhealthy for Sensitive Groups
  4: 'high',       // Unhealthy
  5: 'severe',     // Very Unhealthy
  6: 'extreme',    // Hazardous
};

/**
 * AQI Category descriptions.
 */
const AQI_CATEGORY_DESCRIPTIONS: Record<number, string> = {
  1: 'Good - Air quality is satisfactory and poses little or no risk.',
  2: 'Moderate - Air quality is acceptable; some pollutants may affect unusually sensitive people.',
  3: 'Unhealthy for Sensitive Groups - Members of sensitive groups may experience health effects.',
  4: 'Unhealthy - Everyone may begin to experience health effects.',
  5: 'Very Unhealthy - Health alert: everyone may experience more serious health effects.',
  6: 'Hazardous - Health warnings of emergency conditions.',
};

/**
 * Plugin that fetches air quality data from AirNow API.
 *
 * Provides current AQI observations and forecasts for US locations.
 * Important for Phoenix due to dust storms and air quality concerns.
 *
 * @see https://docs.airnowapi.org
 */
export class AirNowPlugin extends BasePlugin {
  readonly metadata: PluginMetadata = {
    id: 'airnow',
    name: 'AirNow Air Quality',
    version: '1.0.0',
    description: 'Air quality index (AQI) data from EPA AirNow',
    coverage: {
      type: 'global',
      description: 'United States',
    },
    temporal: {
      supportsPast: true,
      supportsFuture: true,
      dataLagMinutes: 60, // Hourly updates
      futureLookaheadMinutes: 2880, // 2 days of forecasts
      freshnessDescription: 'Hourly observations, 2-day forecasts',
    },
    supportedTemporalTypes: ['real-time', 'scheduled'],
    supportedCategories: ['weather'], // Air quality is weather-related
    refreshIntervalMs: 60 * 60 * 1000, // 1 hour - AQI updates hourly
  };

  private airNowConfig: AirNowPluginConfig;

  constructor(config: AirNowPluginConfig) {
    super(config);
    if (!config.apiKey) {
      throw new Error('AirNow API key is required');
    }
    this.airNowConfig = {
      includeForecast: true,
      distanceMiles: 25,
      ...config,
    };
  }

  async fetchAlerts(options: PluginFetchOptions): Promise<PluginFetchResult> {
    const { location } = options;
    const cacheKey = this.generateCacheKey(options);
    const warnings: string[] = [];

    try {
      const { data, fromCache } = await this.getCachedOrFetch(
        cacheKey,
        () => this.fetchAirQualityData(location, warnings),
        this.config.cacheTtlMs
      );

      return {
        alerts: data,
        fromCache,
        cacheKey,
        warnings: warnings.length > 0 ? warnings : undefined,
      };
    } catch (error) {
      console.error('AirNow fetch error:', error);
      throw error;
    }
  }

  /**
   * Fetch air quality data from AirNow API.
   */
  private async fetchAirQualityData(
    location: { latitude: number; longitude: number },
    warnings: string[]
  ) {
    const allAlerts: ReturnType<typeof this.transformObservation | typeof this.transformForecast>[] = [];

    // Fetch current observations
    try {
      const observations = await this.fetchCurrentObservations(location);
      const observationAlerts = observations.map((obs) => this.transformObservation(obs));
      allAlerts.push(...observationAlerts);
    } catch (error) {
      warnings.push(
        `Failed to fetch current observations: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }

    // Fetch forecasts if enabled
    if (this.airNowConfig.includeForecast) {
      try {
        const forecasts = await this.fetchForecasts(location);
        const forecastAlerts = forecasts.map((forecast) => this.transformForecast(forecast));
        allAlerts.push(...forecastAlerts);
      } catch (error) {
        warnings.push(
          `Failed to fetch forecasts: ${error instanceof Error ? error.message : 'Unknown error'}`
        );
      }
    }

    // Deduplicate and prioritize by AQI
    return this.deduplicateAlerts(allAlerts);
  }

  /**
   * Fetch current air quality observations.
   */
  private async fetchCurrentObservations(
    location: { latitude: number; longitude: number }
  ): Promise<AirNowObservation[]> {
    const url = new URL('https://www.airnowapi.org/aq/observation/latLong/current/');
    url.searchParams.set('format', 'application/json');
    url.searchParams.set('latitude', String(location.latitude));
    url.searchParams.set('longitude', String(location.longitude));
    url.searchParams.set('distance', String(this.airNowConfig.distanceMiles));
    url.searchParams.set('API_KEY', this.airNowConfig.apiKey);

    return this.fetchJson<AirNowObservation[]>(url.toString());
  }

  /**
   * Fetch air quality forecasts.
   */
  private async fetchForecasts(
    location: { latitude: number; longitude: number }
  ): Promise<AirNowForecast[]> {
    const url = new URL('https://www.airnowapi.org/aq/forecast/latLong/');
    url.searchParams.set('format', 'application/json');
    url.searchParams.set('latitude', String(location.latitude));
    url.searchParams.set('longitude', String(location.longitude));
    url.searchParams.set('distance', String(this.airNowConfig.distanceMiles));
    url.searchParams.set('API_KEY', this.airNowConfig.apiKey);

    // Get next 3 days of forecasts
    const today = new Date();
    const endDate = new Date(today);
    endDate.setDate(endDate.getDate() + 3);

    url.searchParams.set('date', this.formatDate(today));

    return this.fetchJson<AirNowForecast[]>(url.toString());
  }

  /**
   * Transform an observation to an alert.
   */
  private transformObservation(obs: AirNowObservation) {
    const riskLevel = this.mapAqiToRiskLevel(obs.AQI, obs.Category.Number);

    // Only create alerts for notable air quality (category 3+)
    // Or always create if the AQI is significant
    const issued = `${obs.DateObserved}T${String(obs.HourObserved).padStart(2, '0')}:00:00`;

    return this.createAlert({
      id: `airnow-obs-${obs.ReportingArea}-${obs.ParameterName}-${obs.DateObserved}`,
      externalId: `${obs.ReportingArea}-${obs.ParameterName}`,
      title: this.buildObservationTitle(obs),
      description: this.buildObservationDescription(obs),
      riskLevel,
      priority: this.riskLevelToPriority(riskLevel),
      category: 'weather',
      temporalType: 'real-time',
      location: {
        point: { latitude: obs.Latitude, longitude: obs.Longitude },
        address: `${obs.ReportingArea}, ${obs.StateCode}`,
      },
      timestamps: {
        issued,
        eventStart: issued,
      },
      metadata: {
        parameterName: obs.ParameterName,
        aqi: obs.AQI,
        categoryNumber: obs.Category.Number,
        categoryName: obs.Category.Name,
        reportingArea: obs.ReportingArea,
        isObservation: true,
      },
    });
  }

  /**
   * Transform a forecast to an alert.
   */
  private transformForecast(forecast: AirNowForecast) {
    const riskLevel = this.mapAqiToRiskLevel(forecast.AQI, forecast.Category.Number);

    return this.createAlert({
      id: `airnow-fcst-${forecast.ReportingArea}-${forecast.ParameterName}-${forecast.DateForecast}`,
      externalId: `${forecast.ReportingArea}-${forecast.ParameterName}-${forecast.DateForecast}`,
      title: this.buildForecastTitle(forecast),
      description: this.buildForecastDescription(forecast),
      riskLevel,
      priority: this.riskLevelToPriority(riskLevel),
      category: 'weather',
      temporalType: 'scheduled',
      location: {
        point: { latitude: forecast.Latitude, longitude: forecast.Longitude },
        address: `${forecast.ReportingArea}, ${forecast.StateCode}`,
      },
      timestamps: {
        issued: forecast.DateIssue,
        eventStart: `${forecast.DateForecast}T00:00:00`,
        eventEnd: `${forecast.DateForecast}T23:59:59`,
      },
      metadata: {
        parameterName: forecast.ParameterName,
        aqi: forecast.AQI,
        categoryNumber: forecast.Category.Number,
        categoryName: forecast.Category.Name,
        reportingArea: forecast.ReportingArea,
        actionDay: forecast.ActionDay,
        discussion: forecast.Discussion,
        isForecast: true,
      },
    });
  }

  /**
   * Map AQI value to risk level.
   */
  private mapAqiToRiskLevel(aqi: number, categoryNumber: number): RiskLevel {
    // Use category number if available
    if (AQI_CATEGORY_RISK_MAP[categoryNumber]) {
      return AQI_CATEGORY_RISK_MAP[categoryNumber];
    }

    // Fall back to AQI value ranges
    if (aqi <= 50) return 'low';
    if (aqi <= 100) return 'low';
    if (aqi <= 150) return 'moderate';
    if (aqi <= 200) return 'high';
    if (aqi <= 300) return 'severe';
    return 'extreme';
  }

  /**
   * Build observation title.
   */
  private buildObservationTitle(obs: AirNowObservation): string {
    const pollutant = this.formatPollutant(obs.ParameterName);
    return `Air Quality ${obs.Category.Name} - ${pollutant} AQI ${obs.AQI}`;
  }

  /**
   * Build forecast title.
   */
  private buildForecastTitle(forecast: AirNowForecast): string {
    const pollutant = this.formatPollutant(forecast.ParameterName);
    const dateStr = this.formatForecastDate(forecast.DateForecast);
    const actionDay = forecast.ActionDay ? ' (Action Day)' : '';
    return `${dateStr} Air Quality Forecast: ${pollutant} AQI ${forecast.AQI}${actionDay}`;
  }

  /**
   * Format pollutant name for display.
   */
  private formatPollutant(parameterName: string): string {
    const names: Record<string, string> = {
      O3: 'Ozone',
      'PM2.5': 'Fine Particles (PM2.5)',
      PM10: 'Coarse Particles (PM10)',
    };
    return names[parameterName] ?? parameterName;
  }

  /**
   * Format forecast date.
   */
  private formatForecastDate(dateStr: string): string {
    const date = new Date(dateStr);
    const today = new Date();
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    if (date.toDateString() === today.toDateString()) {
      return 'Today';
    }
    if (date.toDateString() === tomorrow.toDateString()) {
      return 'Tomorrow';
    }

    return date.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
  }

  /**
   * Build observation description.
   */
  private buildObservationDescription(obs: AirNowObservation): string {
    const parts: string[] = [];

    parts.push(`${this.formatPollutant(obs.ParameterName)}: AQI ${obs.AQI}`);
    parts.push(`Category: ${obs.Category.Name}`);
    parts.push('');
    parts.push(AQI_CATEGORY_DESCRIPTIONS[obs.Category.Number] ?? '');
    parts.push('');
    parts.push(`Reporting Area: ${obs.ReportingArea}, ${obs.StateCode}`);
    parts.push(`Observed: ${obs.DateObserved} ${obs.HourObserved}:00 ${obs.LocalTimeZone}`);

    return parts.join('\n');
  }

  /**
   * Build forecast description.
   */
  private buildForecastDescription(forecast: AirNowForecast): string {
    const parts: string[] = [];

    parts.push(`${this.formatPollutant(forecast.ParameterName)}: AQI ${forecast.AQI}`);
    parts.push(`Category: ${forecast.Category.Name}`);

    if (forecast.ActionDay) {
      parts.push('');
      parts.push('⚠️ ACTION DAY - Consider reducing outdoor activities');
    }

    parts.push('');
    parts.push(AQI_CATEGORY_DESCRIPTIONS[forecast.Category.Number] ?? '');

    if (forecast.Discussion) {
      parts.push('');
      parts.push(`Forecast Discussion: ${forecast.Discussion}`);
    }

    parts.push('');
    parts.push(`Reporting Area: ${forecast.ReportingArea}, ${forecast.StateCode}`);
    parts.push(`Forecast Date: ${forecast.DateForecast}`);

    return parts.join('\n');
  }

  /**
   * Format date as YYYY-MM-DD.
   */
  private formatDate(date: Date): string {
    return date.toISOString().split('T')[0];
  }

  /**
   * Deduplicate alerts, keeping highest AQI per location/date.
   */
  private deduplicateAlerts(alerts: ReturnType<typeof this.transformObservation>[]) {
    const seen = new Map<string, ReturnType<typeof this.transformObservation>>();

    for (const alert of alerts) {
      const key = `${alert.location.address}-${alert.temporalType}-${alert.timestamps.eventStart?.split('T')[0]}`;

      const existing = seen.get(key);
      if (!existing) {
        seen.set(key, alert);
      } else {
        // Keep higher AQI
        const existingAqi = (existing.metadata?.aqi as number) ?? 0;
        const currentAqi = (alert.metadata?.aqi as number) ?? 0;
        if (currentAqi > existingAqi) {
          seen.set(key, alert);
        }
      }
    }

    return Array.from(seen.values());
  }
}
