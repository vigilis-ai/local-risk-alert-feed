import type { PluginMetadata, PluginFetchOptions, PluginFetchResult, RiskLevel, Alert } from '../../types';
import { BasePlugin, BasePluginConfig } from '../base-plugin';

/**
 * Austin Convention Center event from Socrata API.
 */
interface AustinConventionEvent {
  arrive_date: string;
  depart_date: string;
  location: string;
  event_name: string;
  website?: string;
}

/**
 * Austin Special Events permit from Socrata API.
 */
interface AustinSpecialEvent {
  folderrsn: string;
  foldertype: string;
  foldername: string;
  status: string;
  tier_type?: string;
  event_applicant_organization?: string;
  start_date: string;
  end_date: string;
  event_length?: string;
  event_setup?: string;
  event_teardown?: string;
  amplified_sound?: string;
  alcohol_served?: string;
  road_closure?: string;
  type_of_road_closure?: string;
  gpslatitude?: string;
  gpslongitude?: string;
}

/**
 * Austin Events plugin configuration.
 */
export interface AustinEventsPluginConfig extends BasePluginConfig {
  /** Include convention center events. Default: true */
  includeConventionEvents?: boolean;
  /** Include special events permits. Default: true */
  includeSpecialEvents?: boolean;
  /** Only include events with road closures. Default: false */
  roadClosuresOnly?: boolean;
}

/**
 * Austin, TX center coordinates.
 */
const AUSTIN_CENTER = {
  latitude: 30.2672,
  longitude: -97.7431,
};

/**
 * Coverage radius in meters (~40km covers Austin metro).
 */
const COVERAGE_RADIUS_METERS = 40_000;

/**
 * Known venue coordinates.
 */
const VENUE_COORDINATES: Record<string, { latitude: number; longitude: number }> = {
  'Palmer Events Center': { latitude: 30.2598, longitude: -97.7526 },
  'Austin Convention Center': { latitude: 30.2636, longitude: -97.7397 },
  'Long Center': { latitude: 30.2590, longitude: -97.7525 },
};

/**
 * Plugin that fetches events from Austin, Texas.
 *
 * Combines data from:
 * - Austin Convention Center/Palmer Events Center calendar
 * - Special Events Permits (includes road closures)
 *
 * @see https://data.austintexas.gov/City-Government/ACCD-Event-Listings/p9ma-z6y9
 * @see https://data.austintexas.gov/Permitting/Special-Events-Permits-Current-Year/teth-r7k8
 */
export class AustinEventsPlugin extends BasePlugin {
  readonly metadata: PluginMetadata = {
    id: 'austin-events',
    name: 'Austin Events',
    version: '1.0.0',
    description: 'Events from Austin Convention Center, Palmer Events Center, and special events permits',
    coverage: {
      type: 'regional',
      center: AUSTIN_CENTER,
      radiusMeters: COVERAGE_RADIUS_METERS,
      description: 'Austin, TX metropolitan area',
    },
    temporal: {
      supportsPast: false,
      supportsFuture: true,
      futureLookaheadMinutes: 43200, // 30 days
      freshnessDescription: 'Scheduled events up to 30 days ahead',
    },
    supportedTemporalTypes: ['scheduled'],
    supportedCategories: ['event'],
    refreshIntervalMs: 60 * 60 * 1000, // 1 hour
  };

  private eventsConfig: AustinEventsPluginConfig;

  constructor(config?: AustinEventsPluginConfig) {
    super(config);
    this.eventsConfig = {
      includeConventionEvents: true,
      includeSpecialEvents: true,
      roadClosuresOnly: false,
      ...config,
    };
  }

  async fetchAlerts(options: PluginFetchOptions): Promise<PluginFetchResult> {
    const { location, radiusMeters, timeRange } = options;
    const cacheKey = this.generateCacheKey(options);
    const warnings: string[] = [];

    try {
      const { data, fromCache } = await this.getCachedOrFetch(
        cacheKey,
        () => this.fetchEvents(location, radiusMeters, timeRange, warnings),
        this.config.cacheTtlMs
      );

      return {
        alerts: data,
        fromCache,
        cacheKey,
        warnings: warnings.length > 0 ? warnings : undefined,
      };
    } catch (error) {
      console.error('Austin Events fetch error:', error);
      throw error;
    }
  }

  /**
   * Fetch events from both sources.
   */
  private async fetchEvents(
    location: { latitude: number; longitude: number },
    radiusMeters: number,
    timeRange: { start: string; end: string },
    warnings: string[]
  ): Promise<Alert[]> {
    const allAlerts: Alert[] = [];

    // Fetch convention events
    if (this.eventsConfig.includeConventionEvents) {
      try {
        const conventionAlerts = await this.fetchConventionEvents(location, radiusMeters, timeRange);
        allAlerts.push(...conventionAlerts);
      } catch (error) {
        warnings.push(
          `Failed to fetch convention events: ${error instanceof Error ? error.message : 'Unknown error'}`
        );
      }
    }

    // Fetch special events permits
    if (this.eventsConfig.includeSpecialEvents) {
      try {
        const specialAlerts = await this.fetchSpecialEvents(location, radiusMeters, timeRange);
        allAlerts.push(...specialAlerts);
      } catch (error) {
        warnings.push(
          `Failed to fetch special events: ${error instanceof Error ? error.message : 'Unknown error'}`
        );
      }
    }

    // Deduplicate by title similarity
    return this.deduplicateEvents(allAlerts);
  }

  /**
   * Fetch convention center events.
   */
  private async fetchConventionEvents(
    location: { latitude: number; longitude: number },
    radiusMeters: number,
    timeRange: { start: string; end: string }
  ): Promise<Alert[]> {
    const baseUrl = 'https://data.austintexas.gov/resource/p9ma-z6y9.json';

    const startDate = new Date(timeRange.start).toISOString().split('T')[0];
    const endDate = new Date(timeRange.end).toISOString().split('T')[0];

    const params = new URLSearchParams({
      $limit: '500',
      $order: 'arrive_date ASC',
      $where: `arrive_date >= '${startDate}' AND arrive_date <= '${endDate}'`,
    });

    const url = `${baseUrl}?${params}`;
    const events = await this.fetchJson<AustinConventionEvent[]>(url);

    if (!events || !Array.isArray(events)) {
      return [];
    }

    // Filter by location (based on venue)
    const filtered = events.filter((event) => {
      const venueCoords = VENUE_COORDINATES[event.location];
      if (!venueCoords) {
        // Default to Austin Convention Center if venue unknown
        return true;
      }

      const distance = this.calculateDistance(
        location.latitude,
        location.longitude,
        venueCoords.latitude,
        venueCoords.longitude
      );

      return distance <= radiusMeters;
    });

    return filtered.map((event) => this.transformConventionEvent(event));
  }

  /**
   * Fetch special events permits.
   */
  private async fetchSpecialEvents(
    location: { latitude: number; longitude: number },
    radiusMeters: number,
    timeRange: { start: string; end: string }
  ): Promise<Alert[]> {
    const baseUrl = 'https://data.austintexas.gov/resource/teth-r7k8.json';

    const params = new URLSearchParams({
      $limit: '500',
      $order: 'start_date ASC',
    });

    // Filter by active/approved status
    params.set('$where', "status='Active' OR status='Approved'");

    const url = `${baseUrl}?${params}`;
    const events = await this.fetchJson<AustinSpecialEvent[]>(url);

    if (!events || !Array.isArray(events)) {
      return [];
    }

    const startTime = new Date(timeRange.start).getTime();
    const endTime = new Date(timeRange.end).getTime();

    // Filter by location, time, and config
    const filtered = events.filter((event) => {
      // Filter by road closures only if configured
      if (this.eventsConfig.roadClosuresOnly && !event.road_closure) {
        return false;
      }

      // Filter by time range
      const eventStart = this.parseEventDate(event.start_date);
      const eventEnd = this.parseEventDate(event.end_date);

      if (!eventStart) return false;

      // Event must overlap with time range
      const eventStartTime = eventStart.getTime();
      const eventEndTime = eventEnd?.getTime() ?? eventStartTime;

      if (eventEndTime < startTime || eventStartTime > endTime) {
        return false;
      }

      // Filter by location
      if (event.gpslatitude && event.gpslongitude) {
        const lat = parseFloat(event.gpslatitude);
        const lng = parseFloat(event.gpslongitude);

        if (!isNaN(lat) && !isNaN(lng)) {
          const distance = this.calculateDistance(
            location.latitude,
            location.longitude,
            lat,
            lng
          );

          if (distance > radiusMeters) return false;
        }
      }

      return true;
    });

    return filtered.map((event) => this.transformSpecialEvent(event));
  }

  /**
   * Transform a convention event to our Alert format.
   */
  private transformConventionEvent(event: AustinConventionEvent): Alert {
    const venueCoords = VENUE_COORDINATES[event.location] ?? AUSTIN_CENTER;

    return this.createAlert({
      id: `austin-conv-${this.slugify(event.event_name)}-${event.arrive_date}`,
      externalId: `${event.event_name}-${event.arrive_date}`,
      title: event.event_name,
      description: this.buildConventionDescription(event),
      riskLevel: 'low',
      priority: this.riskLevelToPriority('low'),
      category: 'event',
      temporalType: 'scheduled',
      location: {
        point: venueCoords,
        address: event.location,
        city: 'Austin',
        state: 'TX',
      },
      timestamps: {
        issued: new Date().toISOString(),
        eventStart: event.arrive_date,
        eventEnd: event.depart_date,
      },
      metadata: {
        venue: event.location,
        website: event.website,
        source: 'convention-center',
      },
    });
  }

  /**
   * Transform a special event to our Alert format.
   */
  private transformSpecialEvent(event: AustinSpecialEvent): Alert {
    const hasRoadClosure = !!event.road_closure;
    const riskLevel = this.mapSpecialEventToRisk(event);

    const lat = parseFloat(event.gpslatitude ?? '');
    const lng = parseFloat(event.gpslongitude ?? '');
    const point = !isNaN(lat) && !isNaN(lng)
      ? { latitude: lat, longitude: lng }
      : AUSTIN_CENTER;

    const eventStart = this.parseEventDate(event.start_date);
    const eventEnd = this.parseEventDate(event.end_date);

    return this.createAlert({
      id: `austin-special-${event.folderrsn}`,
      externalId: event.folderrsn,
      title: event.foldername,
      description: this.buildSpecialEventDescription(event),
      riskLevel,
      priority: this.riskLevelToPriority(riskLevel),
      category: 'event',
      temporalType: 'scheduled',
      location: {
        point,
        address: event.road_closure,
        city: 'Austin',
        state: 'TX',
      },
      timestamps: {
        issued: new Date().toISOString(),
        eventStart: eventStart?.toISOString(),
        eventEnd: eventEnd?.toISOString(),
      },
      metadata: {
        permitId: event.folderrsn,
        organization: event.event_applicant_organization,
        tier: event.tier_type,
        hasRoadClosure,
        roadClosure: event.road_closure,
        roadClosureType: event.type_of_road_closure,
        amplifiedSound: event.amplified_sound === 'Yes',
        alcoholServed: event.alcohol_served === 'Yes',
        setupDate: event.event_setup,
        teardownDate: event.event_teardown,
        source: 'special-events-permit',
      },
    });
  }

  /**
   * Map special event to risk level based on impact.
   */
  private mapSpecialEventToRisk(event: AustinSpecialEvent): RiskLevel {
    // Full road closure = higher risk
    if (event.type_of_road_closure?.includes('Full Road')) {
      return 'moderate';
    }

    // Any road closure
    if (event.road_closure) {
      return 'low';
    }

    // Large tier events
    if (event.tier_type === '3' || event.tier_type === '4') {
      return 'low';
    }

    return 'low';
  }

  /**
   * Parse event date string.
   * Handles formats like "September 27, 2025 10:00"
   */
  private parseEventDate(dateStr: string): Date | null {
    if (!dateStr) return null;

    try {
      // Try standard ISO format first
      const isoDate = new Date(dateStr);
      if (!isNaN(isoDate.getTime())) {
        return isoDate;
      }

      // Try "Month Day, Year HH:MM" format
      const match = dateStr.match(/(\w+)\s+(\d+),\s+(\d+)\s+(\d+):(\d+)/);
      if (match) {
        const [, month, day, year, hour, minute] = match;
        const monthIndex = new Date(`${month} 1, 2000`).getMonth();
        return new Date(
          parseInt(year),
          monthIndex,
          parseInt(day),
          parseInt(hour),
          parseInt(minute)
        );
      }

      return null;
    } catch {
      return null;
    }
  }

  /**
   * Build description for convention event.
   */
  private buildConventionDescription(event: AustinConventionEvent): string {
    const parts: string[] = [];

    parts.push(`Event: ${event.event_name}`);
    parts.push(`Venue: ${event.location}`);
    parts.push(`Dates: ${event.arrive_date} to ${event.depart_date}`);

    if (event.website) {
      parts.push(`Website: ${event.website}`);
    }

    return parts.join('\n');
  }

  /**
   * Build description for special event.
   */
  private buildSpecialEventDescription(event: AustinSpecialEvent): string {
    const parts: string[] = [];

    parts.push(`Event: ${event.foldername}`);

    if (event.event_applicant_organization) {
      parts.push(`Organization: ${event.event_applicant_organization}`);
    }

    parts.push(`Dates: ${event.start_date} to ${event.end_date}`);

    if (event.road_closure) {
      parts.push(`Road Closure: ${event.road_closure}`);
      if (event.type_of_road_closure) {
        parts.push(`Closure Type: ${event.type_of_road_closure}`);
      }
    }

    if (event.amplified_sound === 'Yes') {
      parts.push('Amplified Sound: Yes');
    }

    if (event.event_setup) {
      parts.push(`Setup: ${event.event_setup}`);
    }

    if (event.event_teardown) {
      parts.push(`Teardown: ${event.event_teardown}`);
    }

    return parts.join('\n');
  }

  /**
   * Create URL-safe slug from text.
   */
  private slugify(text: string): string {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .substring(0, 50);
  }

  /**
   * Deduplicate events by similar titles.
   */
  private deduplicateEvents(alerts: Alert[]): Alert[] {
    const seen = new Map<string, Alert>();

    for (const alert of alerts) {
      // Create a key based on normalized title and date
      const dateKey = alert.timestamps.eventStart?.split('T')[0] ?? '';
      const titleKey = alert.title.toLowerCase().replace(/[^a-z0-9]/g, '');
      const key = `${titleKey}-${dateKey}`;

      // Keep the one with more metadata (likely the permit with road closure info)
      const existing = seen.get(key);
      if (!existing) {
        seen.set(key, alert);
      } else {
        const existingMeta = Object.keys(existing.metadata ?? {}).length;
        const currentMeta = Object.keys(alert.metadata ?? {}).length;
        if (currentMeta > existingMeta) {
          seen.set(key, alert);
        }
      }
    }

    return Array.from(seen.values());
  }

  /**
   * Calculate distance between two points in meters.
   */
  private calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6371e3;
    const φ1 = (lat1 * Math.PI) / 180;
    const φ2 = (lat2 * Math.PI) / 180;
    const Δφ = ((lat2 - lat1) * Math.PI) / 180;
    const Δλ = ((lon2 - lon1) * Math.PI) / 180;

    const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
              Math.cos(φ1) * Math.cos(φ2) *
              Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return R * c;
  }
}
