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
 * Glendale Events plugin configuration.
 */
export interface GlendaleEventsPluginConfig extends BasePluginConfig {
  /** Ticketmaster API key (required for Ticketmaster data) */
  ticketmasterApiKey?: string;
  /** Maximum events to fetch. Default: 100 */
  limit?: number;
  /** Enable Ticketmaster source. Default: true if API key provided */
  enableTicketmaster?: boolean;
}

/**
 * Tanger Outlets Phoenix coordinates (customer site).
 * 6800 N 95th Ave, Glendale, AZ 85305
 */
const TANGER_OUTLETS = {
  latitude: 33.5340,
  longitude: -112.2340,
};

/**
 * Coverage radius - 10km covers the Glendale Sports & Entertainment District
 * and surrounding area.
 */
const COVERAGE_RADIUS_METERS = 10_000;

/**
 * Key venues in the Glendale Sports & Entertainment District and surrounding area.
 */
const GLENDALE_VENUES: Record<string, { latitude: number; longitude: number; description: string }> = {
  // Customer site
  'Tanger Outlets Phoenix': {
    latitude: 33.5340,
    longitude: -112.2340,
    description: 'Tanger Outlets Phoenix - 6800 N 95th Ave, Glendale, AZ 85305',
  },
  // Major sports venue - directly adjacent
  'State Farm Stadium': {
    latitude: 33.5276,
    longitude: -112.2626,
    description: 'State Farm Stadium (Arizona Cardinals, Fiesta Bowl) - 1 Cardinals Dr, Glendale, AZ 85305',
  },
  // Arena venue - adjacent to State Farm Stadium
  'Desert Diamond Arena': {
    latitude: 33.5320,
    longitude: -112.2610,
    description: 'Desert Diamond Arena (concerts, events) - 9400 W Maryland Ave, Glendale, AZ 85305',
  },
  // Entertainment district - between Tanger and State Farm
  'Westgate Entertainment District': {
    latitude: 33.5310,
    longitude: -112.2580,
    description: 'Westgate Entertainment District - 6770 N Sunrise Blvd, Glendale, AZ 85305',
  },
  // Spring training - ~2 miles south
  'Camelback Ranch': {
    latitude: 33.5067,
    longitude: -112.2297,
    description: 'Camelback Ranch (Dodgers/White Sox Spring Training) - 10710 W Camelback Rd, Phoenix, AZ 85037',
  },
  // Nearby entertainment
  'Topgolf Glendale': {
    latitude: 33.5325,
    longitude: -112.2405,
    description: 'Topgolf Glendale - 9500 W Coyotes Blvd, Glendale, AZ 85305',
  },
};

/**
 * Plugin that fetches event data from Ticketmaster for the Glendale, AZ
 * Sports & Entertainment District area.
 *
 * Covers events at:
 * - State Farm Stadium (Arizona Cardinals, Fiesta Bowl, concerts)
 * - Desert Diamond Arena (concerts, shows, events)
 * - Westgate Entertainment District
 * - Camelback Ranch (MLB Spring Training)
 * - Tanger Outlets Phoenix (shopping events)
 *
 * Centered on Tanger Outlets Phoenix (customer site) at 6800 N 95th Ave.
 */
export class GlendaleEventsPlugin extends BasePlugin {
  readonly metadata: PluginMetadata = {
    id: 'glendale-events',
    name: 'Glendale Events',
    version: '1.0.0',
    description: 'Events from Ticketmaster for Glendale Sports & Entertainment District',
    coverage: {
      type: 'regional',
      center: TANGER_OUTLETS,
      radiusMeters: COVERAGE_RADIUS_METERS,
      description: 'Glendale, AZ Sports & Entertainment District (State Farm Stadium, Desert Diamond Arena, Westgate, Camelback Ranch)',
    },
    temporal: {
      supportsPast: false,
      supportsFuture: true,
      futureLookaheadMinutes: 43200, // 30 days
      freshnessDescription: 'Scheduled events up to 30 days ahead',
    },
    supportedTemporalTypes: ['scheduled'],
    supportedCategories: ['event'],
    refreshIntervalMs: 30 * 60 * 1000, // 30 minutes
    defaultRadiusMeters: 10_000,
  };

  private eventsConfig: GlendaleEventsPluginConfig;

  constructor(config?: GlendaleEventsPluginConfig) {
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
      console.error('Glendale Events fetch error:', error);
      throw error;
    }
  }

  /**
   * Fetch events from Ticketmaster Discovery API centered on Glendale entertainment district.
   */
  private async fetchTicketmasterEvents(options: PluginFetchOptions): Promise<Alert[]> {
    const { location, timeRange } = options;
    const apiKey = this.eventsConfig.ticketmasterApiKey!;

    const formatDateTime = (iso: string) => {
      return new Date(iso).toISOString().replace(/\.\d{3}Z$/, 'Z');
    };

    const params = new URLSearchParams({
      apikey: apiKey,
      latlong: `${location.latitude},${location.longitude}`,
      radius: '10', // miles - tighter focus on entertainment district
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

    // Determine location - use venue coordinates, then known venues, then Tanger Outlets default
    let latitude = TANGER_OUTLETS.latitude;
    let longitude = TANGER_OUTLETS.longitude;

    if (venue?.location) {
      latitude = parseFloat(venue.location.latitude);
      longitude = parseFloat(venue.location.longitude);
    } else if (venue?.name && GLENDALE_VENUES[venue.name]) {
      latitude = GLENDALE_VENUES[venue.name].latitude;
      longitude = GLENDALE_VENUES[venue.name].longitude;
    }

    const startDateTime =
      event.dates.start.dateTime ?? `${event.dates.start.localDate}T${event.dates.start.localTime ?? '00:00:00'}`;
    const endDateTime = event.dates.end?.dateTime;

    const riskLevel = this.assessEventRisk(event, venue?.name);

    return this.createAlert({
      id: `glendale-tm-${event.id}`,
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
        city: venue?.city?.name ?? 'Glendale',
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
        nearbyCustomerSite: 'Tanger Outlets Phoenix',
      },
    });
  }

  /**
   * Assess risk level for an event based on venue capacity and type.
   */
  private assessEventRisk(event: TicketmasterEvent, venueName?: string): RiskLevel {
    // State Farm Stadium events (63,400+ capacity) have major crowd/traffic impact
    if (venueName === 'State Farm Stadium') {
      return 'high';
    }

    // Desert Diamond Arena events (17,000+ capacity)
    if (venueName === 'Desert Diamond Arena') {
      return 'moderate';
    }

    // Camelback Ranch spring training (~12,000 capacity)
    if (venueName === 'Camelback Ranch') {
      return 'moderate';
    }

    // Sports events typically have high attendance
    const segment = event.classifications?.[0]?.segment?.name?.toLowerCase();
    if (segment === 'sports') {
      return 'moderate';
    }

    // Large music events
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

    // Add proximity note for key venues
    if (venue?.name && GLENDALE_VENUES[venue.name]) {
      parts.push(`Note: ${GLENDALE_VENUES[venue.name].description}`);
    }

    return parts.join('\n');
  }
}
