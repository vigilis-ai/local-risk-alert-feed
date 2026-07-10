import type { PluginMetadata, PluginFetchOptions, PluginFetchResult, RiskLevel, AlertCategory } from '../../types';
import { BasePlugin, BasePluginConfig } from '../base-plugin';
import { fetchArcGisFeatures, envelopeForRadius } from '../../utils';

/**
 * A currently-active incident from the Phoenix Regional Dispatch Center.
 *
 * @see https://maps.phoenix.gov/phxfire/rest/services/Active_Incidents__Public/MapServer/0
 */
interface ActiveIncident {
  OBJECTID: number;
  Incident: string;
  /** Short nature code, e.g. `962`, `ALLEY`. */
  Nature?: string;
  /** Human-readable nature, e.g. `ALLEY FIRE`. Often equal to `Nature` for numeric codes. */
  NatureDesc?: string;
  /** Responding units and status, HTML-encoded: `E15:&#160;Responding`. */
  Units?: string;
  /** Radio channel, e.g. `A9`. */
  Channel?: string;
  /** Dashboard symbol, e.g. `sc006-fire`, `sc004-crash`. */
  SymbolCode?: string;
  /** Dispatch time, epoch ms. Genuine UTC (unlike the sibling history layers). */
  Date?: number;
  /** Address plus a city code suffix, e.g. `N 67TH AV/W BEARDSLEY RD ,GLN`. */
  GenLocInfo?: string;
}

interface ArcGISJsonResponse {
  features: Array<{
    attributes: ActiveIncident;
    geometry?: { x: number; y: number };
  }>;
}

export interface PhoenixRegionalActiveIncidentsPluginConfig extends BasePluginConfig {
  /** Records requested per page. Default: 1000. */
  pageSize?: number;
  /** Ceiling across all pages for one query. Default: 2000. */
  maxRecords?: number;
}

/** Phoenix metro center. */
const PHOENIX_CENTER = {
  latitude: 33.4484,
  longitude: -112.074,
};

/** The automatic-aid system spans the Valley; ~60km covers it. */
const COVERAGE_RADIUS_METERS = 60_000;

/**
 * City codes seen in `GenLocInfo`. Unknown codes pass through unchanged rather
 * than being guessed at.
 */
const CITY_CODES: Record<string, string> = {
  PHX: 'Phoenix',
  GLN: 'Glendale',
  TMP: 'Tempe',
  SUR: 'Surprise',
  PDV: 'Paradise Valley',
  LAV: 'Laveen',
  DSY: 'Daisy Mountain',
  MAR: 'Maricopa County',
};

/**
 * Numeric natures share the Valley dispatch code set with the police feeds:
 * 961 = accident no injuries, 962 = injuries, 963 = fatality.
 */
const NUMERIC_NATURE_MAP: Record<string, { category: AlertCategory; risk: RiskLevel }> = {
  '961': { category: 'traffic', risk: 'moderate' },
  '962': { category: 'traffic', risk: 'high' },
  '963': { category: 'traffic', risk: 'severe' },
};

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/**
 * Decode the HTML entities the feed embeds in `Units`.
 *
 * It uses more than `&#160;` (non-breaking space): unit names carry `&#8209;`
 * (non-breaking hyphen), e.g. `M&#8209;1501`. Decode numerically rather than
 * matching one entity at a time, then fold the typographic non-breaking forms
 * back to plain space and hyphen so the text is searchable.
 */
export function decodeUnits(units: string | undefined | null): string {
  return (units ?? '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => safeFromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => safeFromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (match, name) => NAMED_ENTITIES[name.toLowerCase()] ?? match)
    .replace(/ /g, ' ') // non-breaking space
    .replace(/[‐‑]/g, '-') // hyphen / non-breaking hyphen
    .replace(/\s+/g, ' ')
    .trim();
}

function safeFromCodePoint(code: number): string {
  return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
}

export interface ParsedLocation {
  address: string;
  /** Resolved city name, or the raw code when unrecognized. */
  city?: string;
  /** The raw suffix code, e.g. `GLN`. */
  cityCode?: string;
}

/** Split `N 67TH AV/W BEARDSLEY RD ,GLN` into an address and a city. */
export function parseGenLocInfo(genLocInfo: string | undefined | null): ParsedLocation {
  const raw = (genLocInfo ?? '').trim();
  const match = /^(.*?)\s*,\s*([A-Z]{2,4})$/.exec(raw);
  if (!match) return { address: raw };

  const [, address, code] = match;
  return { address: address.trim(), city: CITY_CODES[code] ?? code, cityCode: code };
}

/**
 * Classify an active incident.
 *
 * `SymbolCode` is the dashboard's own categorization and the most reliable
 * signal; `NatureDesc` refines severity. Both are heuristic — this feed ships no
 * severity field — so unknown incidents land on `moderate`, never `low`: an
 * incident is only in this layer while units are actively committed to it.
 */
export function classifyIncident(
  nature: string | undefined | null,
  natureDesc: string | undefined | null,
  symbolCode: string | undefined | null,
): { category: AlertCategory; risk: RiskLevel } {
  const code = (nature ?? '').trim().toUpperCase();
  if (NUMERIC_NATURE_MAP[code]) return NUMERIC_NATURE_MAP[code];

  const text = `${nature ?? ''} ${natureDesc ?? ''}`.toUpperCase();
  const symbol = (symbolCode ?? '').toLowerCase();

  // Life-threatening first, regardless of symbol. An explosion or a structural
  // collapse is a fire-service call; the rest are patient-centred.
  if (/EXPLOS|COLLAPSE/.test(text)) {
    return { category: 'fire', risk: 'extreme' };
  }
  if (/SHOOT|STAB|ENTRAPMENT|CARDIAC|ARREST|CPR|DROWN/.test(text)) {
    return { category: 'medical', risk: 'severe' };
  }
  if (/HAZMAT|GAS LEAK|CHEMICAL/.test(text)) {
    return { category: 'fire', risk: 'severe' };
  }

  if (symbol.includes('fire') || /FIRE/.test(text)) {
    if (/STRUCTURE|RESIDENTIAL|COMMERCIAL|HIGH RISE|APARTMENT/.test(text)) {
      return { category: 'fire', risk: 'extreme' };
    }
    if (/BRUSH|GRASS|ALLEY|DUMPSTER|TRASH|RUBBISH/.test(text)) {
      return { category: 'fire', risk: 'moderate' };
    }
    if (/VEHICLE|CAR/.test(text)) {
      return { category: 'fire', risk: 'high' };
    }
    return { category: 'fire', risk: 'high' };
  }

  if (symbol.includes('crash') || /CRASH|ACCIDENT|COLLISION/.test(text)) {
    return { category: 'traffic', risk: 'high' };
  }

  if (symbol.includes('medical') || symbol.includes('ems') || /MEDICAL|EMS|INJUR|SICK|OVERDOSE/.test(text)) {
    return { category: 'medical', risk: 'high' };
  }

  if (symbol.includes('rescue') || /RESCUE|EXTRICATION|WATER/.test(text)) {
    return { category: 'medical', risk: 'severe' };
  }

  if (symbol.includes('smoke') || /SMOKE|ALARM|INVESTIGATION|SERVICE|SNAKE/.test(text)) {
    return { category: 'other', risk: 'moderate' };
  }

  return { category: 'other', risk: 'moderate' };
}

/**
 * Live fire, EMS, and rescue incidents from the Phoenix Regional Dispatch Center.
 *
 * This is the only public feed that covers **Glendale Fire Department**. The
 * 30-day history layers are scoped to Phoenix (`CITY IN ('PHX','PDV','LAV')`)
 * and Maricopa County (`'MAR'`), and Glendale's own incident dataset —
 * `FIRE_UNIT_RELIABILITY_DASHBOARD_PT_Query` — stopped receiving records in
 * July 2025. This layer carries `GLN` alongside `PHX`, `TMP`, `SUR` and the
 * rest of the Valley automatic-aid system.
 *
 * It holds only incidents units are currently committed to (typically a handful
 * at a time), so it answers "what is happening near this site right now" and
 * cannot answer anything historical. `supportsPast` is false accordingly.
 *
 * @see https://maps.phoenix.gov/phxfire/rest/services/Active_Incidents__Public/MapServer/0
 */
export class PhoenixRegionalActiveIncidentsPlugin extends BasePlugin {
  readonly metadata: PluginMetadata = {
    id: 'phoenix-regional-active-incidents',
    name: 'Phoenix Regional Dispatch — Active Incidents',
    version: '1.0.0',
    description:
      'Live fire, EMS, and rescue incidents from the Phoenix Regional Dispatch Center, covering the Valley automatic-aid system including Glendale',
    coverage: {
      type: 'regional',
      center: PHOENIX_CENTER,
      radiusMeters: COVERAGE_RADIUS_METERS,
      description: 'Phoenix metro automatic-aid area (Phoenix, Glendale, Tempe, Surprise, and neighbours)',
    },
    temporal: {
      supportsPast: true,
      supportsFuture: false,
      dataLagMinutes: 0,
      freshnessDescription: 'live — incidents appear while units are committed',
    },
    supportedTemporalTypes: ['real-time'],
    supportedCategories: ['fire', 'medical', 'traffic', 'other'],
    refreshIntervalMs: 60 * 1000, // 1 minute — this is a live feed
    defaultRadiusMeters: 10_000,
  };

  private incidentConfig: PhoenixRegionalActiveIncidentsPluginConfig;

  constructor(config?: PhoenixRegionalActiveIncidentsPluginConfig) {
    super(config);
    this.incidentConfig = {
      pageSize: 1000,
      maxRecords: 2000,
      ...config,
    };
  }

  async fetchAlerts(options: PluginFetchOptions): Promise<PluginFetchResult> {
    const { location, radiusMeters, categories } = options;
    const cacheKey = this.generateCacheKey(options);

    try {
      const { data, fromCache } = await this.getCachedOrFetch(
        cacheKey,
        () => this.fetchIncidents(location, radiusMeters, categories),
        this.config.cacheTtlMs
      );

      return {
        alerts: data.alerts,
        fromCache,
        cacheKey,
        warnings: data.warnings.length > 0 ? data.warnings : undefined,
      };
    } catch (error) {
      console.error('Phoenix Regional Active Incidents fetch error:', error);
      throw error;
    }
  }

  /**
   * Fetch every active incident inside the query radius.
   *
   * Deliberately unfiltered by time: the layer only ever holds live incidents,
   * and an incident that began before the requested window may still have units
   * on scene. The aggregator applies the caller's time range afterwards.
   */
  private async fetchIncidents(
    location: { latitude: number; longitude: number },
    radiusMeters: number,
    categories?: AlertCategory[]
  ): Promise<{ alerts: ReturnType<PhoenixRegionalActiveIncidentsPlugin['transformIncident']>[]; warnings: string[] }> {
    const baseUrl = 'https://maps.phoenix.gov/phxfire/rest/services/Active_Incidents__Public/MapServer/0/query';

    const warnings: string[] = [];

    const params = new URLSearchParams({
      where: '1=1',
      outFields: '*',
      f: 'json',
      outSR: '4326',
      orderByFields: 'OBJECTID DESC',
      geometry: envelopeForRadius(location.latitude, location.longitude, radiusMeters),
      geometryType: 'esriGeometryEnvelope',
      spatialRel: 'esriSpatialRelIntersects',
      inSR: '4326',
    });

    const { features, truncated } = await fetchArcGisFeatures<ArcGISJsonResponse['features'][number]>({
      baseUrl,
      params,
      pageSize: this.incidentConfig.pageSize!,
      maxRecords: this.incidentConfig.maxRecords!,
      fetchJson: (url) => this.fetchJson(url),
    });

    if (truncated) {
      warnings.push(
        `Phoenix Regional Dispatch reported more than ${this.incidentConfig.maxRecords} active incidents near this location; ` +
          `only ${this.incidentConfig.maxRecords} were read.`
      );
    }

    const alerts = features
      .filter((f) => {
        if (!f.geometry || typeof f.geometry.x !== 'number' || typeof f.geometry.y !== 'number') return false;

        const distance = this.calculateDistance(location.latitude, location.longitude, f.geometry.y, f.geometry.x);
        if (distance > radiusMeters) return false;

        if (categories && categories.length > 0) {
          const { category } = classifyIncident(
            f.attributes.Nature,
            f.attributes.NatureDesc,
            f.attributes.SymbolCode
          );
          if (!categories.includes(category)) return false;
        }

        return true;
      })
      .map((f) => this.transformIncident(f.attributes, f.geometry!));

    return { alerts, warnings };
  }

  private transformIncident(incident: ActiveIncident, geometry: { x: number; y: number }) {
    const { category, risk } = classifyIncident(incident.Nature, incident.NatureDesc, incident.SymbolCode);
    const { address, city, cityCode } = parseGenLocInfo(incident.GenLocInfo);
    const units = decodeUnits(incident.Units);

    // `Date` is genuine UTC here, unlike the `REPORTED` field on the sibling
    // 30-day history layers, which stores local wall-clock as epoch-as-if-UTC.
    const dispatchedAt = typeof incident.Date === 'number' ? incident.Date : Date.now();
    const issued = new Date(dispatchedAt).toISOString();

    return this.createAlert({
      id: `phoenix-regional-active-${incident.Incident}`,
      externalId: incident.Incident,
      title: this.formatTitle(incident),
      description: this.buildDescription(incident, address, units),
      riskLevel: risk,
      priority: this.riskLevelToPriority(risk),
      category,
      temporalType: 'real-time',
      location: {
        point: { latitude: geometry.y, longitude: geometry.x },
        address: address || undefined,
        city: city ?? 'Phoenix',
        state: 'AZ',
      },
      timestamps: {
        issued,
        eventStart: issued,
        // No end: the incident is, by definition, still active.
      },
      metadata: {
        incidentNumber: incident.Incident,
        nature: incident.Nature,
        natureDescription: incident.NatureDesc,
        symbolCode: incident.SymbolCode,
        radioChannel: incident.Channel,
        cityCode,
        units: units || undefined,
        unitsOnScene: /On Scene/i.test(units),
      },
    });
  }

  private formatTitle(incident: ActiveIncident): string {
    const desc = (incident.NatureDesc ?? '').trim();
    const nature = (incident.Nature ?? '').trim();

    // Numeric natures repeat the code in NatureDesc ("962" / "962"); name them.
    const label =
      desc && desc !== nature
        ? desc
        : NUMERIC_NATURE_MAP[nature.toUpperCase()]
          ? 'Traffic Collision'
          : desc || nature || 'Active Incident';

    return label
      .split(/\s+/)
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join(' ');
  }

  private buildDescription(incident: ActiveIncident, address: string, units: string): string {
    const parts: string[] = ['Active incident — units currently committed.'];

    if (incident.NatureDesc) parts.push(`Type: ${incident.NatureDesc}`);
    if (address) parts.push(`Location: ${address}`);
    if (units) parts.push(`Units: ${units}`);
    if (incident.Channel) parts.push(`Radio channel: ${incident.Channel}`);

    return parts.join('\n');
  }

  /** Distance between two points in meters. */
  private calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6371e3;
    const φ1 = (lat1 * Math.PI) / 180;
    const φ2 = (lat2 * Math.PI) / 180;
    const Δφ = ((lat2 - lat1) * Math.PI) / 180;
    const Δλ = ((lon2 - lon1) * Math.PI) / 180;

    const a =
      Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
      Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return R * c;
  }
}
