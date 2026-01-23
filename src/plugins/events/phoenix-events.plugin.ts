import type { PluginMetadata, PluginFetchOptions, PluginFetchResult, RiskLevel, Alert } from '../../types';
import { BasePlugin, BasePluginConfig } from '../base-plugin';

/**
 * Ticketmaster event structure (simplified).
 */
interface TicketmasterEvent {
  id: string;
  name: string;
  type: string;
  url: string;
  dates: {
    start: {
      localDate: string;
      localTime?: string;
      dateTime?: string;
    };
    end?: {
      localDate?: string;
      localTime?: string;
      dateTime?: string;
    };
    status?: {
      code: string;
    };
  };
  classifications?: Array<{
    segment?: { name: string };
    genre?: { name: string };
    subGenre?: { name: string };
  }>;
  _embedded?: {
    venues?: Array<{
      name: string;
      address?: { line1: string };
      city?: { name: string };
      state?: { stateCode: string };
      postalCode?: string;
      location?: {
        latitude: string;
        longitude: string;
      };
    }>;
  };
}

interface TicketmasterResponse {
  _embedded?: {
    events?: TicketmasterEvent[];
  };
  page?: {
    totalElements: number;
  };
}

/**
 * Phoenix Special Events permit structure.
 */
interface PhoenixSpecialEvent {
  event_name?: string;
  event_type?: string;
  event_location?: string;
  start_date?: string;
  end_date?: string;
  start_time?: string;
  end_time?: string;
  description?: string;
  street_closure?: string;
  permit_number?: string;
  latitude?: string;
  longitude?: string;
}

/**
 * Phoenix Events plugin configuration.
 */
export interface PhoenixEventsPluginConfig extends BasePluginConfig {
  /** Ticketmaster API key (required for Ticketmaster data) */
  ticketmasterApiKey?: string;
  /** Socrata app token for Phoenix Open Data (optional) */
  socrataAppToken?: string;
  /** Maximum events to fetch from each source. Default: 100 */
  limit?: number;
  /** Enable Ticketmaster source. Default: true if API key provided */
  enableTicketmaster?: boolean;
  /** Enable Phoenix permits source. Default: true */
  enablePhoenixPermits?: boolean;
}

/**
 * Phoenix downtown center coordinates.
 */
const PHOENIX_DOWNTOWN = {
  latitude: 33.4484,
  longitude: -112.074,
};

/**
 * Coverage radius - 10km for downtown Phoenix events.
 */
const COVERAGE_RADIUS_METERS = 10_000;

/**
 * Major Phoenix venues with coordinates.
 */
const PHOENIX_VENUES: Record<string, { latitude: number; longitude: number }> = {
  'Chase Field': { latitude: 33.4455, longitude: -112.0667 },
  'Footprint Center': { latitude: 33.4459, longitude: -112.0712 },
  'State Farm Stadium': { latitude: 33.5276, longitude: -112.2626 },
  'Arizona State University': { latitude: 33.4242, longitude: -111.9281 },
  'Phoenix Convention Center': { latitude: 33.4419, longitude: -112.0711 },
  'Comerica Theatre': { latitude: 33.4461, longitude: -112.0710 },
  'Celebrity Theatre': { latitude: 33.4870, longitude: -112.0744 },
  'Van Buren': { latitude: 33.4542, longitude: -112.0747 },
  'Crescent Ballroom': { latitude: 33.4509, longitude: -112.0714 },
};

/**
 * Event types that may cause civil unrest concerns.
 */
const CIVIL_UNREST_KEYWORDS = [
  'protest',
  'march',
  'rally',
  'demonstration',
  'strike',
  'political',
];

/**
 * Plugin that fetches event data from Ticketmaster and Phoenix city permits.
 *
 * Aggregates from:
 * - Ticketmaster Discovery API for concerts, sports, theater
 * - Phoenix Open Data for special event permits (street closures, parades)
 */
export class PhoenixEventsPlugin extends BasePlugin {
  readonly metadata: PluginMetadata = {
    id: 'phoenix-events',
    name: 'Phoenix Events',
    version: '1.0.0',
    description: 'Events from Ticketmaster and Phoenix city permits',
    coverage: {
      type: 'regional',
      center: PHOENIX_DOWNTOWN,
      radiusMeters: COVERAGE_RADIUS_METERS,
      description: 'Downtown Phoenix area',
    },
    supportedTemporalTypes: ['scheduled'],
    supportedCategories: ['event', 'civil-unrest'],
    refreshIntervalMs: 30 * 60 * 1000, // 30 minutes
  };

  private eventsConfig: PhoenixEventsPluginConfig;

  constructor(config?: PhoenixEventsPluginConfig) {
    super(config);
    this.eventsConfig = {
      limit: 100,
      enablePhoenixPermits: true,
      ...config,
      enableTicketmaster: config?.enableTicketmaster ?? !!config?.ticketmasterApiKey,
    };
  }

  async fetchAlerts(options: PluginFetchOptions): Promise<PluginFetchResult> {
    const cacheKey = this.generateCacheKey(options);
    const warnings: string[] = [];

    try {
      const { data, fromCache } = await this.getCachedOrFetch(
        cacheKey,
        () => this.fetchAllEvents(options, warnings),
        this.config.cacheTtlMs
      );

      // Filter by categories if specified
      let alerts = data;
      if (options.categories && options.categories.length > 0) {
        alerts = alerts.filter((alert) => options.categories!.includes(alert.category));
      }

      return {
        alerts,
        fromCache,
        cacheKey,
        warnings: warnings.length > 0 ? warnings : undefined,
      };
    } catch (error) {
      console.error('Phoenix Events fetch error:', error);
      throw error;
    }
  }

  /**
   * Fetch events from all enabled sources.
   */
  private async fetchAllEvents(
    options: PluginFetchOptions,
    warnings: string[]
  ): Promise<Alert[]> {
    const allAlerts: Alert[] = [];

    // Fetch from Ticketmaster
    if (this.eventsConfig.enableTicketmaster && this.eventsConfig.ticketmasterApiKey) {
      try {
        const tmAlerts = await this.fetchTicketmasterEvents(options);
        allAlerts.push(...tmAlerts);
      } catch (error) {
        warnings.push(
          `Ticketmaster fetch failed: ${error instanceof Error ? error.message : 'Unknown error'}`
        );
      }
    }

    // Fetch from Phoenix permits
    if (this.eventsConfig.enablePhoenixPermits) {
      try {
        const permitAlerts = await this.fetchPhoenixPermitEvents(options);
        allAlerts.push(...permitAlerts);
      } catch (error) {
        warnings.push(
          `Phoenix permits fetch failed: ${error instanceof Error ? error.message : 'Unknown error'}`
        );
      }
    }

    // Deduplicate events by venue + date
    return this.deduplicateEvents(allAlerts);
  }

  /**
   * Fetch events from Ticketmaster Discovery API.
   */
  private async fetchTicketmasterEvents(options: PluginFetchOptions): Promise<Alert[]> {
    const { location, timeRange } = options;
    const apiKey = this.eventsConfig.ticketmasterApiKey!;

    const params = new URLSearchParams({
      apikey: apiKey,
      latlong: `${location.latitude},${location.longitude}`,
      radius: '25', // miles
      unit: 'miles',
      startDateTime: new Date(timeRange.start).toISOString().replace('.000', ''),
      endDateTime: new Date(timeRange.end).toISOString().replace('.000', ''),
      size: String(this.eventsConfig.limit),
      sort: 'date,asc',
    });

    const url = `https://app.ticketmaster.com/discovery/v2/events.json?${params}`;

    const response = await this.fetchJson<TicketmasterResponse>(url);

    if (!response._embedded?.events) {
      return [];
    }

    return response._embedded.events.map((event) => this.transformTicketmasterEvent(event));
  }

  /**
   * Transform a Ticketmaster event to our Alert format.
   */
  private transformTicketmasterEvent(event: TicketmasterEvent): Alert {
    const venue = event._embedded?.venues?.[0];
    const classification = event.classifications?.[0];

    // Determine location
    let latitude = PHOENIX_DOWNTOWN.latitude;
    let longitude = PHOENIX_DOWNTOWN.longitude;

    if (venue?.location) {
      latitude = parseFloat(venue.location.latitude);
      longitude = parseFloat(venue.location.longitude);
    } else if (venue?.name && PHOENIX_VENUES[venue.name]) {
      latitude = PHOENIX_VENUES[venue.name].latitude;
      longitude = PHOENIX_VENUES[venue.name].longitude;
    }

    // Build timestamps
    const startDateTime =
      event.dates.start.dateTime ?? `${event.dates.start.localDate}T${event.dates.start.localTime ?? '00:00:00'}`;
    const endDateTime = event.dates.end?.dateTime;

    // Determine risk level based on event type/venue
    const riskLevel = this.assessEventRisk(event, venue?.name);

    return this.createAlert({
      id: `tm-${event.id}`,
      externalId: event.id,
      title: event.name,
      description: this.buildTicketmasterDescription(event, classification, venue),
      riskLevel,
      priority: this.riskLevelToPriority(riskLevel),
      category: 'event',
      temporalType: 'scheduled',
      location: {
        point: { latitude, longitude },
        address: venue?.address?.line1,
        city: venue?.city?.name ?? 'Phoenix',
        state: venue?.state?.stateCode ?? 'AZ',
        zipCode: venue?.postalCode,
      },
      timestamps: {
        issued: new Date().toISOString(),
        eventStart: startDateTime,
        eventEnd: endDateTime,
      },
      url: event.url,
      metadata: {
        source: 'ticketmaster',
        venue: venue?.name,
        segment: classification?.segment?.name,
        genre: classification?.genre?.name,
        status: event.dates.status?.code,
      },
    });
  }

  /**
   * Fetch events from Phoenix Open Data special events permits.
   */
  private async fetchPhoenixPermitEvents(options: PluginFetchOptions): Promise<Alert[]> {
    const { timeRange } = options;

    // Phoenix special events dataset (if available)
    // Note: This endpoint may need to be updated based on actual Phoenix Open Data availability
    const baseUrl = 'https://www.phoenixopendata.com/resource/yqvh-8bti.json';

    const params = new URLSearchParams({
      $limit: String(this.eventsConfig.limit),
      $order: 'start_date ASC',
    });

    // Filter by date range
    const startDate = timeRange.start.split('T')[0];
    const endDate = timeRange.end.split('T')[0];
    params.set('$where', `start_date >= '${startDate}' AND start_date <= '${endDate}'`);

    if (this.eventsConfig.socrataAppToken) {
      params.set('$$app_token', this.eventsConfig.socrataAppToken);
    }

    const url = `${baseUrl}?${params}`;

    try {
      const events = await this.fetchJson<PhoenixSpecialEvent[]>(url);
      return events.map((event) => this.transformPhoenixPermitEvent(event));
    } catch (error) {
      // Phoenix permits endpoint might not always be available
      console.warn('Phoenix permits fetch failed, continuing with other sources:', error);
      return [];
    }
  }

  /**
   * Transform a Phoenix permit event to our Alert format.
   */
  private transformPhoenixPermitEvent(event: PhoenixSpecialEvent): Alert {
    // Parse location
    const latitude = event.latitude ? parseFloat(event.latitude) : PHOENIX_DOWNTOWN.latitude;
    const longitude = event.longitude ? parseFloat(event.longitude) : PHOENIX_DOWNTOWN.longitude;

    // Build timestamps
    const startDate = event.start_date ?? new Date().toISOString().split('T')[0];
    const startTime = event.start_time ?? '00:00:00';
    const startDateTime = `${startDate}T${startTime}`;

    let endDateTime: string | undefined;
    if (event.end_date) {
      const endTime = event.end_time ?? '23:59:59';
      endDateTime = `${event.end_date}T${endTime}`;
    }

    // Determine category and risk
    const { category, riskLevel } = this.assessPermitEventRisk(event);

    return this.createAlert({
      id: `phoenix-permit-${event.permit_number ?? Date.now()}`,
      externalId: event.permit_number,
      title: event.event_name ?? 'Special Event',
      description: this.buildPermitDescription(event),
      riskLevel,
      priority: this.riskLevelToPriority(riskLevel),
      category,
      temporalType: 'scheduled',
      location: {
        point: { latitude, longitude },
        address: event.event_location,
        city: 'Phoenix',
        state: 'AZ',
      },
      timestamps: {
        issued: new Date().toISOString(),
        eventStart: startDateTime,
        eventEnd: endDateTime,
      },
      metadata: {
        source: 'phoenix-permits',
        eventType: event.event_type,
        streetClosure: event.street_closure,
        permitNumber: event.permit_number,
      },
    });
  }

  /**
   * Assess risk level for a Ticketmaster event.
   */
  private assessEventRisk(event: TicketmasterEvent, venueName?: string): RiskLevel {
    // Large venue events have higher crowd impact
    const largeVenues = ['Chase Field', 'Footprint Center', 'State Farm Stadium'];
    if (venueName && largeVenues.includes(venueName)) {
      return 'moderate';
    }

    // Sports events typically have high attendance
    const segment = event.classifications?.[0]?.segment?.name?.toLowerCase();
    if (segment === 'sports') {
      return 'moderate';
    }

    // Music events can vary
    if (segment === 'music') {
      return 'low';
    }

    return 'low';
  }

  /**
   * Assess risk and category for a permit event.
   */
  private assessPermitEventRisk(
    event: PhoenixSpecialEvent
  ): { category: Alert['category']; riskLevel: RiskLevel } {
    const name = (event.event_name ?? '').toLowerCase();
    const type = (event.event_type ?? '').toLowerCase();
    const description = (event.description ?? '').toLowerCase();
    const combined = `${name} ${type} ${description}`;

    // Check for civil unrest indicators
    for (const keyword of CIVIL_UNREST_KEYWORDS) {
      if (combined.includes(keyword)) {
        return { category: 'civil-unrest', riskLevel: 'moderate' };
      }
    }

    // Check for street closures
    if (event.street_closure && event.street_closure.toLowerCase() !== 'no') {
      return { category: 'event', riskLevel: 'moderate' };
    }

    // Default
    return { category: 'event', riskLevel: 'low' };
  }

  /**
   * Build description for Ticketmaster event.
   */
  private buildTicketmasterDescription(
    event: TicketmasterEvent,
    classification?: { segment?: { name: string }; genre?: { name: string } },
    venue?: { name: string }
  ): string {
    const parts: string[] = [];

    if (classification?.segment?.name) {
      parts.push(`Type: ${classification.segment.name}`);
    }

    if (classification?.genre?.name) {
      parts.push(`Genre: ${classification.genre.name}`);
    }

    if (venue?.name) {
      parts.push(`Venue: ${venue.name}`);
    }

    if (event.dates.start.localDate) {
      const time = event.dates.start.localTime ?? '';
      parts.push(`Date: ${event.dates.start.localDate} ${time}`.trim());
    }

    return parts.join('\n');
  }

  /**
   * Build description for permit event.
   */
  private buildPermitDescription(event: PhoenixSpecialEvent): string {
    const parts: string[] = [];

    if (event.event_type) {
      parts.push(`Type: ${event.event_type}`);
    }

    if (event.event_location) {
      parts.push(`Location: ${event.event_location}`);
    }

    if (event.description) {
      parts.push(`\n${event.description}`);
    }

    if (event.street_closure && event.street_closure.toLowerCase() !== 'no') {
      parts.push(`\nStreet Closure: ${event.street_closure}`);
    }

    return parts.join('\n');
  }

  /**
   * Deduplicate events that might appear in both sources.
   */
  private deduplicateEvents(alerts: Alert[]): Alert[] {
    const seen = new Map<string, Alert>();

    for (const alert of alerts) {
      // Create dedup key from venue + date
      const venue =
        (alert.metadata?.venue as string) ?? alert.location.address ?? 'unknown';
      const date = alert.timestamps.eventStart?.split('T')[0] ?? '';
      const key = `${venue.toLowerCase()}-${date}`;

      const existing = seen.get(key);
      if (!existing) {
        seen.set(key, alert);
      } else {
        // Prefer Ticketmaster data (usually more complete)
        if (
          alert.metadata?.source === 'ticketmaster' &&
          existing.metadata?.source !== 'ticketmaster'
        ) {
          seen.set(key, alert);
        }
      }
    }

    return Array.from(seen.values());
  }
}
