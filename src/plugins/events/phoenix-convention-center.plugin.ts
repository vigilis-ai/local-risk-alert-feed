import type { PluginMetadata, PluginFetchOptions, PluginFetchResult, RiskLevel, Alert } from '../../types';
import { BasePlugin, BasePluginConfig } from '../base-plugin';

/**
 * Phoenix Convention Center event structure from Ungerboeck API.
 */
interface ConventionCenterEvent {
  id: string;
  title: string;
  start: string;
  end: string;
  start_date_formatted: string;
  end_date_formatted: string;
  start_date_week_formatted: string;
  end_date_week_formatted: string;
  start_time: string;
  end_time: string;
  allDay: string;
  location_override: string;
  event_notes_description: string;
  event_url: string;
  event_type: string;
  func_ID: string;
}

/**
 * Phoenix Convention Center plugin configuration.
 */
export interface PhoenixConventionCenterPluginConfig extends BasePluginConfig {
  /** Include Orpheum Theatre events. Default: true */
  includeOrpheum?: boolean;
  /** Include Symphony Hall events. Default: true */
  includeSymphonyHall?: boolean;
  /** Maximum events to fetch. Default: 100 */
  limit?: number;
}

/**
 * Phoenix Convention Center coordinates.
 */
const CONVENTION_CENTER_LOCATION = {
  latitude: 33.4419,
  longitude: -112.0711,
};

/**
 * Venue locations for different event types.
 */
const VENUE_LOCATIONS: Record<string, { name: string; latitude: number; longitude: number }> = {
  B: { name: 'Phoenix Convention Center', latitude: 33.4419, longitude: -112.0711 },
  O: { name: 'Orpheum Theatre', latitude: 33.4461, longitude: -112.0710 },
  S: { name: 'Symphony Hall', latitude: 33.4459, longitude: -112.0712 },
  M: { name: 'Phoenix Convention Center', latitude: 33.4419, longitude: -112.0711 },
};

/**
 * Coverage radius in meters (downtown Phoenix area).
 */
const COVERAGE_RADIUS_METERS = 5_000;

/**
 * Keywords that indicate potentially high-impact events.
 */
const HIGH_IMPACT_KEYWORDS = [
  'final four',
  'super bowl',
  'championship',
  'convention',
  'expo',
  'conference',
  'festival',
  'marathon',
  'parade',
];

/**
 * Plugin that fetches events from Phoenix Convention Center, Orpheum Theatre, and Symphony Hall.
 *
 * Uses the Ungerboeck event management system API.
 *
 * @see https://www.phoenixconventioncenter.com/events
 */
export class PhoenixConventionCenterPlugin extends BasePlugin {
  readonly metadata: PluginMetadata = {
    id: 'phoenix-convention-center',
    name: 'Phoenix Convention Center',
    version: '1.0.0',
    description: 'Events from Phoenix Convention Center, Orpheum Theatre, and Symphony Hall',
    coverage: {
      type: 'regional',
      center: CONVENTION_CENTER_LOCATION,
      radiusMeters: COVERAGE_RADIUS_METERS,
      description: 'Downtown Phoenix venues (Convention Center, Orpheum, Symphony Hall)',
    },
    supportedTemporalTypes: ['scheduled'],
    supportedCategories: ['event'],
    refreshIntervalMs: 60 * 60 * 1000, // 1 hour
  };

  private pluginConfig: PhoenixConventionCenterPluginConfig;

  constructor(config?: PhoenixConventionCenterPluginConfig) {
    super(config);
    this.pluginConfig = {
      includeOrpheum: true,
      includeSymphonyHall: true,
      limit: 100,
      ...config,
    };
  }

  async fetchAlerts(options: PluginFetchOptions): Promise<PluginFetchResult> {
    const cacheKey = this.generateCacheKey(options);

    try {
      const { data, fromCache } = await this.getCachedOrFetch(
        cacheKey,
        () => this.fetchEvents(options),
        this.config.cacheTtlMs
      );

      return {
        alerts: data,
        fromCache,
        cacheKey,
      };
    } catch (error) {
      console.error('Phoenix Convention Center fetch error:', error);
      throw error;
    }
  }

  /**
   * Fetch events from the convention center API.
   */
  private async fetchEvents(options: PluginFetchOptions): Promise<Alert[]> {
    const { timeRange } = options;

    // Build API URL with start date
    const startDate = timeRange.start.split('T')[0];
    const url = `https://phoenixcc-web.ungerboeck.com/Digital_Services/api/events/getall?orgcode=01&start=${startDate}`;

    const events = await this.fetchJson<ConventionCenterEvent[]>(url);

    if (!Array.isArray(events)) {
      return [];
    }

    // Filter and transform events
    const endDate = new Date(timeRange.end);
    const alerts: Alert[] = [];

    for (const event of events) {
      // Filter by event type
      if (!this.shouldIncludeEvent(event)) {
        continue;
      }

      // Filter by time range
      const eventStart = new Date(event.start);
      if (eventStart > endDate) {
        continue;
      }

      alerts.push(this.transformEvent(event));

      if (alerts.length >= this.pluginConfig.limit!) {
        break;
      }
    }

    return alerts;
  }

  /**
   * Check if an event should be included based on configuration.
   */
  private shouldIncludeEvent(event: ConventionCenterEvent): boolean {
    const eventType = event.event_type;

    // Always include convention center events
    if (eventType === 'B' || eventType === 'M') {
      return true;
    }

    // Check Orpheum
    if (eventType === 'O' && !this.pluginConfig.includeOrpheum) {
      return false;
    }

    // Check Symphony Hall
    if (eventType === 'S' && !this.pluginConfig.includeSymphonyHall) {
      return false;
    }

    return true;
  }

  /**
   * Transform a convention center event to our Alert format.
   */
  private transformEvent(event: ConventionCenterEvent): Alert {
    const venue = this.getVenue(event.event_type);
    const riskLevel = this.assessEventRisk(event);

    return this.createAlert({
      id: `pcc-${event.id}`,
      externalId: event.id,
      title: this.cleanTitle(event.title),
      description: this.buildDescription(event, venue),
      riskLevel,
      priority: this.riskLevelToPriority(riskLevel),
      category: 'event',
      temporalType: 'scheduled',
      location: {
        point: { latitude: venue.latitude, longitude: venue.longitude },
        address: venue.name,
        city: 'Phoenix',
        state: 'AZ',
      },
      timestamps: {
        issued: new Date().toISOString(),
        eventStart: event.start,
        eventEnd: event.end,
      },
      url: event.event_url || undefined,
      metadata: {
        source: 'phoenix-convention-center',
        venue: venue.name,
        eventType: event.event_type,
        allDay: event.allDay === 'True',
      },
    });
  }

  /**
   * Get venue information from event type.
   */
  private getVenue(eventType: string): { name: string; latitude: number; longitude: number } {
    return VENUE_LOCATIONS[eventType] ?? VENUE_LOCATIONS.B;
  }

  /**
   * Clean up event title.
   */
  private cleanTitle(title: string): string {
    // Remove common suffixes and clean up
    return title
      .replace(/\s*\(Cancelling\)\s*/gi, '')
      .replace(/\s*\(Cancelled\)\s*/gi, '')
      .replace(/^FOTOT:\s*/i, '') // Remove internal prefix
      .trim();
  }

  /**
   * Assess risk level for an event based on expected impact.
   */
  private assessEventRisk(event: ConventionCenterEvent): RiskLevel {
    const title = event.title.toLowerCase();
    const description = (event.event_notes_description || '').toLowerCase();
    const combined = `${title} ${description}`;

    // Check for high-impact keywords
    for (const keyword of HIGH_IMPACT_KEYWORDS) {
      if (combined.includes(keyword)) {
        return 'moderate';
      }
    }

    // Convention center events (type B) tend to be larger
    if (event.event_type === 'B') {
      return 'moderate';
    }

    // Multi-day events suggest larger gatherings
    if (event.start_date_formatted !== event.end_date_formatted) {
      return 'moderate';
    }

    return 'low';
  }

  /**
   * Build description from event data.
   */
  private buildDescription(
    event: ConventionCenterEvent,
    venue: { name: string }
  ): string {
    const parts: string[] = [];

    parts.push(`Venue: ${venue.name}`);

    if (event.start_date_formatted === event.end_date_formatted) {
      parts.push(`Date: ${event.start_date_week_formatted}, ${event.start_date_formatted}`);
      if (event.allDay !== 'True') {
        parts.push(`Time: ${event.start_time} - ${event.end_time}`);
      }
    } else {
      parts.push(`Dates: ${event.start_date_formatted} - ${event.end_date_formatted}`);
    }

    if (event.event_notes_description) {
      parts.push(`\n${event.event_notes_description}`);
    }

    return parts.join('\n');
  }
}
