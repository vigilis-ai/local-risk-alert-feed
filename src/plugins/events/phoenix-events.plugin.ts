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
 * Phoenix Events plugin configuration.
 */
export interface PhoenixEventsPluginConfig extends BasePluginConfig {
  /** Ticketmaster API key (required for Ticketmaster data) */
  ticketmasterApiKey?: string;
  /** Maximum events to fetch. Default: 100 */
  limit?: number;
  /** Enable Ticketmaster source. Default: true if API key provided */
  enableTicketmaster?: boolean;
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
 * Plugin that fetches event data from Ticketmaster.
 */
export class PhoenixEventsPlugin extends BasePlugin {
  readonly metadata: PluginMetadata = {
    id: 'phoenix-events',
    name: 'Phoenix Events',
    version: '2.0.0',
    description: 'Events from Ticketmaster Discovery API',
    coverage: {
      type: 'regional',
      center: PHOENIX_DOWNTOWN,
      radiusMeters: COVERAGE_RADIUS_METERS,
      description: 'Downtown Phoenix area',
    },
    supportedTemporalTypes: ['scheduled'],
    supportedCategories: ['event'],
    refreshIntervalMs: 30 * 60 * 1000, // 30 minutes
  };

  private eventsConfig: PhoenixEventsPluginConfig;

  constructor(config?: PhoenixEventsPluginConfig) {
    super(config);
    this.eventsConfig = {
      limit: 100,
      ...config,
      enableTicketmaster: config?.enableTicketmaster ?? !!config?.ticketmasterApiKey,
    };
  }

  async fetchAlerts(options: PluginFetchOptions): Promise<PluginFetchResult> {
    const cacheKey = this.generateCacheKey(options);
    const warnings: string[] = [];

    // Check if Ticketmaster is enabled
    if (!this.eventsConfig.enableTicketmaster || !this.eventsConfig.ticketmasterApiKey) {
      return {
        alerts: [],
        fromCache: false,
        cacheKey,
        warnings: ['Ticketmaster API key not configured'],
      };
    }

    try {
      const { data, fromCache } = await this.getCachedOrFetch(
        cacheKey,
        () => this.fetchTicketmasterEvents(options),
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
   * Fetch events from Ticketmaster Discovery API.
   */
  private async fetchTicketmasterEvents(options: PluginFetchOptions): Promise<Alert[]> {
    const { location, timeRange } = options;
    const apiKey = this.eventsConfig.ticketmasterApiKey!;

    // Ticketmaster requires format: YYYY-MM-DDTHH:mm:ssZ (no milliseconds)
    const formatDateTime = (iso: string) => {
      return new Date(iso).toISOString().replace(/\.\d{3}Z$/, 'Z');
    };

    const params = new URLSearchParams({
      apikey: apiKey,
      latlong: `${location.latitude},${location.longitude}`,
      radius: '25', // miles
      unit: 'miles',
      startDateTime: formatDateTime(timeRange.start),
      endDateTime: formatDateTime(timeRange.end),
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
      description: this.buildDescription(event, classification, venue),
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
   * Assess risk level for an event.
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
   * Build description for event.
   */
  private buildDescription(
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
}
