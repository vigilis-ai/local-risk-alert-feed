import type { PluginMetadata, PluginFetchOptions, PluginFetchResult, RiskLevel, AlertCategory } from '../../types';
import { BasePlugin, BasePluginConfig } from '../base-plugin';
import { fetchArcGisFeatures, envelopeForRadius, toArcGisTimestamp } from '../../utils';

/**
 * Glendale Police call for service from the GPD ArcGIS spatial layer.
 *
 * @see https://services1.arcgis.com/9fVTQQSiODPjLUTa/ArcGIS/rest/services/P1_CFS_REDACTED_PT_hosted/FeatureServer/47
 */
interface GlendalePoliceCall {
  OBJECTID: number;
  IncidentNumber: string;
  /**
   * Phoenix local wall-clock time stored as epoch-as-if-UTC — a 9pm call is
   * published as 20:58Z. Prefer `DateTime_Plus7` for the true instant.
   */
  IncidentDate: number;
  /** The same instant in real UTC (Arizona is UTC-7 year-round, no DST). */
  DateTime_Plus7?: number;
  IncidentTypeDescription: string;
  InitialIncidentTypeDescription?: string;
  IncidentTypeCode?: string;
  IncidentStatusDescription?: string;
  CallSource?: string;
  CurrentPriorityKey?: number;
  Location?: string;
  LocationName?: string;
  CrossStreet?: string;
  CityName?: string;
  ZipCode?: string;
  BeatName?: string;
  AreaName?: string;
  SectorName?: string;
  Latitude?: number;
  Longitude?: number;
  /** Unit response times, in the same local-as-UTC space as `IncidentDate`. */
  FirstUnitDispatchedTime?: number;
  FirstUnitEnrouteTime?: number;
  FirstUnitArrivedTime?: number;
  PrimaryUnitId?: string;
  AllDispositionDescriptions?: string;
  Council_District_GIS?: string;
  PATROL_DIVISION_GIS?: string;
}

/**
 * ArcGIS GeoJSON response.
 */
interface ArcGISGeoJSONResponse {
  type: 'FeatureCollection';
  features: Array<{
    type: 'Feature';
    properties: GlendalePoliceCall;
    geometry: {
      type: 'Point';
      coordinates: [number, number]; // [lng, lat]
    };
  }>;
}

/**
 * Glendale Police plugin configuration.
 */
export interface GlendalePolicePluginConfig extends BasePluginConfig {
  /**
   * Records requested per page. Default: 1000 (layer maxRecordCount is 16000).
   * @deprecated Prefer `pageSize`; `limit` is honoured as the page size for
   * backwards compatibility and no longer caps the overall result.
   */
  limit?: number;
  /** Records requested per page. Default: 1000. */
  pageSize?: number;
  /** Ceiling across all pages for one query. Default: 5000. */
  maxRecords?: number;
  /** Include low-priority calls (noise, parking). Default: true */
  includeLowPriority?: boolean;
}

/**
 * Glendale, AZ center coordinates (Tanger Outlets area).
 */
const GLENDALE_CENTER = {
  latitude: 33.5340,
  longitude: -112.2340,
};

/**
 * Coverage radius in meters (~20km covers Glendale city limits).
 */
const COVERAGE_RADIUS_METERS = 20_000;

/**
 * Arizona does not observe DST, so the layer's local-to-UTC offset is a constant
 * +7h. Used only as a fallback: `DateTime_Plus7` carries the true instant and is
 * populated on every record.
 */
const PHOENIX_UTC_OFFSET_MS = 7 * 60 * 60 * 1000;

/** The true UTC instant of a call, in epoch ms. */
export function utcInstantOf(call: { IncidentDate: number; DateTime_Plus7?: number }): number {
  return typeof call.DateTime_Plus7 === 'number' && Number.isFinite(call.DateTime_Plus7)
    ? call.DateTime_Plus7
    : call.IncidentDate + PHOENIX_UTC_OFFSET_MS;
}

/**
 * Translate the host's risk floor into a GPD priority ceiling, so the floor can
 * be pushed into the upstream query instead of fetching records we'd discard.
 *
 * GPD priority is a severity proxy (1 = life-threatening … 6 = routine).
 * Deliberately conservative: the ceiling must never exclude a call that could
 * classify at or above the floor, so it errs on fetching a little extra rather
 * than dropping a serious call. `undefined` = no ceiling (fetch everything).
 */
function priorityCeilingForRisk(minRiskLevel?: RiskLevel): number | undefined {
  switch (minRiskLevel) {
    // Only P1/P2 calls ever classify severe+ (shootings, robbery, assault, DV).
    case 'extreme':
    case 'severe':
      return 2;
    // `high` adds burglary/theft-of-vehicle, which GPD codes as P3.
    case 'high':
      return 3;
    default:
      return undefined;
  }
}

/** Risk levels, ascending. */
const RISK_ORDER: RiskLevel[] = ['low', 'moderate', 'high', 'severe', 'extreme'];

function maxRisk(a: RiskLevel, b: RiskLevel): RiskLevel {
  return RISK_ORDER.indexOf(a) >= RISK_ORDER.indexOf(b) ? a : b;
}

/**
 * GPD publishes `IncidentTypeDescription` as a call code joined to a description
 * — `901G-SHOOTING`, `417S-SHOTS FIRED`, `10-70 PUBLIC RELATIONS CONTACT`. The
 * code is the stable part, so classification keys on it.
 *
 * Matches, in order: the `10-xx` family (which embeds a dash), a numeric code
 * with an optional letter suffix, and the alphabetic self-initiated codes.
 */
const CALL_CODE_RE = /^\s*(10-\d{2,3}|\d{2,4}[A-Z]{0,2}|C\d[A-Z]?|FC|BC|KNT|TEST)\b[\s\-(]*/;

export interface ParsedCallType {
  /** Normalized call code, e.g. `901G`. Empty when the value carries no code. */
  code: string;
  /** The human-readable remainder, e.g. `SHOOTING`. */
  text: string;
}

export function parseCallCode(callType: string | undefined | null): ParsedCallType {
  const normalized = (callType ?? '').toUpperCase().replace(/\s+/g, ' ').trim();
  const match = CALL_CODE_RE.exec(normalized);
  if (!match) return { code: '', text: normalized };
  return { code: match[1], text: normalized.slice(match[0].length).trim() };
}

/**
 * Call code → category and risk, from the codes GPD actually emits.
 *
 * The previous table keyed on bare descriptions (`'SHOOTING'`), which never
 * matched a code-prefixed value, so every call fell through to substring
 * guessing: `417S-SHOTS FIRED` and `417G-SUBJECT WITH A GUN` scored `low` while
 * `459A-BURGLARY ALARM` scored `high` on the word "burglary".
 */
const CALL_CODE_MAP: Record<string, { category: AlertCategory; risk: RiskLevel }> = {
  // Weapons and gunfire
  '901G': { category: 'crime', risk: 'extreme' }, // SHOOTING
  '998': { category: 'crime', risk: 'extreme' },  // OFFICER INVOLVED SHOOTING
  '417S': { category: 'crime', risk: 'extreme' }, // SHOTS FIRED
  '417X': { category: 'crime', risk: 'extreme' }, // SHOT SPOTTER (gunfire detection)
  '417G': { category: 'crime', risk: 'extreme' }, // SUBJECT WITH A GUN
  '417K': { category: 'crime', risk: 'severe' },  // SUBJECT WITH A KNIFE
  '901C': { category: 'crime', risk: 'extreme' }, // CUTTING OR STABBING
  '245': { category: 'crime', risk: 'extreme' },  // ASSAULT WITH DEADLY WEAPON

  // Robbery and abduction
  '211': { category: 'crime', risk: 'extreme' },  // ARMED ROBBERY
  '211T': { category: 'crime', risk: 'severe' },  // PRO NET ACTIVATION (silent robbery alarm)
  '211A': { category: 'crime', risk: 'severe' },  // ARMED ROBBERY ALARM
  '210': { category: 'crime', risk: 'severe' },   // STRONG ARMED ROBBERY
  '491': { category: 'crime', risk: 'extreme' },  // KIDNAPPING

  // Violence against persons
  '240': { category: 'crime', risk: 'severe' },   // ASSAULT
  '239': { category: 'crime', risk: 'high' },     // FIGHT
  '415F': { category: 'crime', risk: 'severe' },  // DOMESTIC VIOLENCE/FAMILY FIGHT
  '261': { category: 'crime', risk: 'severe' },   // RAPE
  '310': { category: 'crime', risk: 'severe' },   // MOLESTING
  '312': { category: 'crime', risk: 'severe' },   // CHILD NEGLECT/ABUSE
  '236': { category: 'crime', risk: 'high' },     // THREAT
  '311': { category: 'crime', risk: 'moderate' }, // INDECENT EXPOSURE
  '921P': { category: 'crime', risk: 'moderate' },// PEEPING TOM

  // Medical / death
  '901H': { category: 'medical', risk: 'severe' },   // DEAD BODY
  '901X': { category: 'medical', risk: 'severe' },   // SUICIDE/ATTEMPT SUICIDE
  '901D': { category: 'medical', risk: 'severe' },   // DROWNING
  '901O': { category: 'medical', risk: 'high' },     // OVERDOSE
  '901': { category: 'medical', risk: 'moderate' },  // INJURED OR SICK PERSON

  // Fire
  '904': { category: 'fire', risk: 'high' }, // FIRE

  // Property crime
  '459': { category: 'crime', risk: 'high' },     // BURGLARY
  '459B': { category: 'crime', risk: 'high' },    // BURGLARY FROM BUSINESS
  '459R': { category: 'crime', risk: 'high' },    // BURGLARY FROM RESIDENCE
  '459X': { category: 'crime', risk: 'moderate' },// ATTEMPTED BURGLARY
  '459M': { category: 'crime', risk: 'moderate' },// BURGLARY OF METAL
  '459F': { category: 'crime', risk: 'moderate' },// BURGLARY FROM VEHICLE
  '487V': { category: 'crime', risk: 'high' },    // STOLEN VEHICLE
  '487': { category: 'crime', risk: 'moderate' }, // THEFT
  '487F': { category: 'crime', risk: 'moderate' },// THEFT FROM VEHICLE
  '487B': { category: 'crime', risk: 'low' },     // SHOPLIFTING
  '415B': { category: 'crime', risk: 'moderate' },// CRIMINAL DAMAGE
  '415G': { category: 'crime', risk: 'low' },     // GRAFFITI

  // Alarms — frequently false; must not outrank gunfire.
  '459A': { category: 'crime', risk: 'low' },     // BURGLARY ALARM SILENT/AUDIBLE
  '459P': { category: 'crime', risk: 'high' },    // PANIC ALARM

  // Disorder and suspicion
  '647': { category: 'crime', risk: 'moderate' },  // SUSPICIOUS PERSON/ACTIVITY
  '647V': { category: 'crime', risk: 'moderate' }, // SUSPICIOUS VEHICLE
  '415': { category: 'crime', risk: 'moderate' },  // SUBJECT DISTURBING
  '418T': { category: 'crime', risk: 'moderate' }, // TRESPASSING
  '927': { category: 'crime', risk: 'moderate' },  // UNKNOWN TROUBLE
  '918': { category: 'other', risk: 'moderate' },  // CRAZY/INSANE PERSON
  '417F': { category: 'other', risk: 'low' },      // FIREWORKS
  '415E': { category: 'other', risk: 'low' },      // LOUD MUSIC/NOISE DISTURBANCE
  '900': { category: 'other', risk: 'moderate' },  // CHECK WELFARE

  // Traffic
  '962': { category: 'traffic', risk: 'high' },     // ACCIDENT - INJURIES
  '962H': { category: 'traffic', risk: 'high' },    // HIT AND RUN - INJURIES
  '963H': { category: 'traffic', risk: 'severe' },  // HIT AND RUN - FATALITY
  '961': { category: 'traffic', risk: 'moderate' }, // ACCIDENT - NO INJURIES
  '961H': { category: 'traffic', risk: 'moderate' },// HIT AND RUN - NO INJURIES
  '390D': { category: 'traffic', risk: 'high' },    // DRUNK DRIVER
  '510R': { category: 'traffic', risk: 'high' },    // ROAD RAGE
  '510': { category: 'traffic', risk: 'moderate' }, // SPEEDING OR RACING VEHICLE
  '510D': { category: 'traffic', risk: 'moderate' },// DRAG RACING
  '585': { category: 'traffic', risk: 'moderate' }, // TRAFFIC HAZARD
  '586': { category: 'traffic', risk: 'low' },      // ILLEGAL PARKING
  '917': { category: 'traffic', risk: 'low' },      // ABANDONED VEHICLE
};

/**
 * Self-initiated, administrative, and clerical call codes. These are activity
 * records rather than hazards, and can be filtered out entirely.
 */
const LOW_PRIORITY_CODES = new Set([
  'C5', 'C6', 'C6M', 'C6I', 'FC', 'BC', 'KNT', 'TEST',
  '10-51', '10-52', '10-53', '10-70', '10-79', '10-84', '10-85', '10-86', '10-87',
  '1025', '1076', '1090', '1091',
  '319', '459A', '508', '586', '711', '907', '917', '928', '928I', '928N', '990',
]);

export function isLowPriorityCallType(callType: string | undefined | null): boolean {
  const { code, text } = parseCallCode(callType);
  if (code && LOW_PRIORITY_CODES.has(code)) return true;
  return !code && (text === 'PAPERWORK' || text.startsWith('CAT TEAM'));
}

/**
 * Classify a GPD call into a category and risk level.
 *
 * Falls back to substring matching for codes not yet in the map, then applies a
 * priority floor: GPD Priority 1 means life-threatening, so an unmapped P1 code
 * can never be reported as low risk.
 */
export function classifyCallType(
  callType: string | undefined | null,
  priorityKey?: number,
): { category: AlertCategory; risk: RiskLevel } {
  const { code, text } = parseCallCode(callType);

  let result = code ? CALL_CODE_MAP[code] : undefined;

  if (!result) {
    result = classifyByText(text || code);
  }

  // A Priority 1 call is dispatched as life-threatening. Never downgrade it.
  const risk = priorityKey === 1 ? maxRisk(result.risk, 'severe') : result.risk;
  return { category: result.category, risk };
}

function classifyByText(text: string): { category: AlertCategory; risk: RiskLevel } {
  const lower = text.toLowerCase();

  if (/shoot|homicide|stabbing|cutting|gun|weapon|kidnap/.test(lower)) {
    return { category: 'crime', risk: 'extreme' };
  }
  if (/assault|robbery|rape|abuse/.test(lower)) {
    return { category: 'crime', risk: 'severe' };
  }
  if (/dead body|suicide|drowning/.test(lower)) {
    return { category: 'medical', risk: 'severe' };
  }
  if (/overdose|injured|sick person/.test(lower)) {
    return { category: 'medical', risk: 'high' };
  }
  if (/fire(?!works)/.test(lower)) {
    return { category: 'fire', risk: 'high' };
  }
  // "alarm" first: a burglary alarm is not a burglary.
  if (/alarm/.test(lower)) {
    return { category: 'crime', risk: 'low' };
  }
  if (/burglary|stolen vehicle/.test(lower)) {
    return { category: 'crime', risk: 'high' };
  }
  if (/theft|fight|threat/.test(lower)) {
    return { category: 'crime', risk: 'moderate' };
  }
  if (/hit and run|drunk driver|accident/.test(lower)) {
    return { category: 'traffic', risk: 'moderate' };
  }
  if (/traffic|parking|vehicle|motorist/.test(lower)) {
    return { category: 'traffic', risk: 'low' };
  }
  if (/suspicious|disturb|dispute|trespass/.test(lower)) {
    return { category: 'crime', risk: 'moderate' };
  }
  return { category: 'crime', risk: 'low' };
}

/**
 * Plugin that fetches police calls for service from Glendale, AZ Police Department.
 *
 * Uses the Glendale PD public spatial calls-for-service layer (332K+ records, updated daily).
 * ArcGIS org: 9fVTQQSiODPjLUTa, Layer 47.
 *
 * @see https://services1.arcgis.com/9fVTQQSiODPjLUTa/ArcGIS/rest/services/P1_CFS_REDACTED_PT_hosted/FeatureServer/47
 */
export class GlendalePolicePlugin extends BasePlugin {
  readonly metadata: PluginMetadata = {
    id: 'glendale-police',
    name: 'Glendale Police Department',
    version: '1.1.0',
    description: 'Police calls for service from Glendale, AZ Police Department',
    coverage: {
      type: 'regional',
      center: GLENDALE_CENTER,
      radiusMeters: COVERAGE_RADIUS_METERS,
      description: 'Glendale, AZ and surrounding West Valley area',
    },
    temporal: {
      supportsPast: true,
      supportsFuture: false,
      dataLagMinutes: 1440, // ~24 hour delay
      freshnessDescription: '~24 hour delay',
    },
    supportedTemporalTypes: ['historical', 'real-time'],
    // GPD dispatches fire (904) and medical (901x) calls too.
    supportedCategories: ['crime', 'traffic', 'fire', 'medical', 'other'],
    refreshIntervalMs: 5 * 60 * 1000, // 5 minutes
    defaultRadiusMeters: 10_000,
  };

  private policeConfig: GlendalePolicePluginConfig;

  constructor(config?: GlendalePolicePluginConfig) {
    super(config);
    this.policeConfig = {
      // Relevance cap: one page of the most serious + recent calls. The query
      // orders by priority then recency, so 500 covers every P1/P2 plus recent
      // lower-priority calls — far more than the host's top-N ever shows — while
      // keeping the payload (and latency) an order of magnitude smaller than the
      // full firehose.
      pageSize: config?.pageSize ?? config?.limit ?? 500,
      maxRecords: 500,
      includeLowPriority: true,
      ...config,
    };
  }

  async fetchAlerts(options: PluginFetchOptions): Promise<PluginFetchResult> {
    const { location, timeRange, radiusMeters, categories } = options;
    const cacheKey = this.generateCacheKey(options);

    // Only pull what the host can actually use, in the order it will rank by.
    const budget = this.resolveFetchBudget(options, this.policeConfig.maxRecords!);

    try {
      // Cache the warnings alongside the alerts: a cache hit that dropped the
      // warning would report a truncated window as a complete one.
      const { data, fromCache } = await this.getCachedOrFetch(
        cacheKey,
        () => this.fetchCalls(location, timeRange, radiusMeters, categories, budget),
        this.config.cacheTtlMs
      );

      return {
        alerts: data.alerts,
        fromCache,
        cacheKey,
        warnings: data.warnings.length > 0 ? data.warnings : undefined,
      };
    } catch (error) {
      console.error('Glendale Police fetch error:', error);
      throw error;
    }
  }

  /**
   * Fetch calls for service from Glendale PD ArcGIS spatial layer.
   *
   * Fetches the most *relevant* calls, not the raw firehose. Glendale runs ~360
   * calls/day and ~60% of them are officer self-initiated activity (Priority 7:
   * traffic stops, field contacts) — never a "risk alert near a site". A 7-day
   * window near one site is ~2,000 records; returning all of them made every
   * caller pay to transfer and validate thousands of rows the host discards down
   * to its top ~50 by risk. So the query:
   *   - drops Priority 7 self-initiated activity server-side;
   *   - orders by CurrentPriorityKey (severity proxy) then recency, so the most
   *     serious + recent calls come first and a shooting is always on page one;
   *   - caps at `maxRecords` (default 500) — one page, every P1/P2 plus the most
   *     recent lower-priority calls, and flags truncation when more matched.
   * This cut a Tanger-Outlets 7-day query from ~2,466 rows / ~15s to ~500 / ~4s
   * while still surfacing the July 4 shooting as the top result.
   */
  private async fetchCalls(
    location: { latitude: number; longitude: number },
    timeRange: { start: string; end: string },
    radiusMeters: number,
    categories: AlertCategory[] | undefined,
    budget: { maxRecords: number; rank: 'severity' | 'recency'; minRiskLevel?: RiskLevel }
  ): Promise<{ alerts: ReturnType<GlendalePolicePlugin['transformCall']>[]; warnings: string[] }> {
    // Glendale PD public calls for service - spatial layer with point geometry
    const baseUrl = 'https://services1.arcgis.com/9fVTQQSiODPjLUTa/ArcGIS/rest/services/P1_CFS_REDACTED_PT_hosted/FeatureServer/47/query';

    const warnings: string[] = [];

    // `IncidentDate` holds local wall-clock as-if-UTC, so filtering it against a
    // real UTC instant is off by 7 hours. `DateTime_Plus7` is the true instant
    // (non-null across the layer), and TIMESTAMP literals keep the bounds exact —
    // a DATE literal truncates to midnight and drops everything from today.
    const start = toArcGisTimestamp(new Date(timeRange.start));
    const end = toArcGisTimestamp(new Date(timeRange.end));

    // `CurrentPriorityKey < 7` drops officer self-initiated activity (traffic
    // stops, field contacts) — the dominant volume and never a risk alert.
    const where = [
      `DateTime_Plus7 >= TIMESTAMP '${start}'`,
      `DateTime_Plus7 <= TIMESTAMP '${end}'`,
      'CurrentPriorityKey < 7',
    ];

    // The host's risk floor, pushed into the query: GPD priority is a severity
    // proxy, so a floor of `high`+ means we needn't fetch P3-P6 at all.
    const priorityCeiling = priorityCeilingForRisk(budget.minRiskLevel);
    if (priorityCeiling !== undefined) {
      where.push(`CurrentPriorityKey <= ${priorityCeiling}`);
    }

    const params = new URLSearchParams({
      where: where.join(' AND '),
      outFields: '*',
      f: 'geojson',
      outSR: '4326',
      // Fetch the slice the host will actually rank by. OBJECTID tie-breaks so
      // paging is stable either way.
      orderByFields:
        budget.rank === 'recency'
          ? 'DateTime_Plus7 DESC, OBJECTID ASC'
          : 'CurrentPriorityKey ASC, DateTime_Plus7 DESC, OBJECTID ASC',
      // Spatial filter sized to the caller's radius, not a fixed city-wide box.
      geometry: envelopeForRadius(location.latitude, location.longitude, radiusMeters),
      geometryType: 'esriGeometryEnvelope',
      spatialRel: 'esriSpatialRelIntersects',
      inSR: '4326',
    });

    const { features, truncated } = await fetchArcGisFeatures<ArcGISGeoJSONResponse['features'][number]>({
      baseUrl,
      params,
      pageSize: Math.min(this.policeConfig.pageSize!, budget.maxRecords),
      maxRecords: budget.maxRecords,
      fetchJson: (url) => this.fetchJson(url),
    });

    if (truncated) {
      const ordering =
        budget.rank === 'recency' ? 'most-recent' : 'highest-priority, most-recent';
      warnings.push(
        `Glendale PD had more than ${budget.maxRecords} calls for this window; ` +
          `showing the ${budget.maxRecords} ${ordering} ones. ` +
          `Others were not included — narrow the time range or radius for those.`
      );
    }

    const alerts = features
      .filter(f => {
        if (!f.geometry?.coordinates) return false;

        const [lng, lat] = f.geometry.coordinates;
        const distance = this.calculateDistance(location.latitude, location.longitude, lat, lng);

        if (distance > radiusMeters) return false;

        // Filter low priority if configured
        if (!this.policeConfig.includeLowPriority) {
          if (isLowPriorityCallType(f.properties.IncidentTypeDescription)) return false;
        }

        // Filter by categories if specified
        if (categories && categories.length > 0) {
          const { category } = classifyCallType(f.properties.IncidentTypeDescription, f.properties.CurrentPriorityKey);
          if (!categories.includes(category)) return false;
        }

        return true;
      })
      .map(f => this.transformCall(f.properties, f.geometry.coordinates));

    return { alerts, warnings };
  }

  /**
   * Transform a Glendale PD call to our Alert format.
   */
  private transformCall(
    call: GlendalePoliceCall,
    coordinates: [number, number]
  ) {
    const [longitude, latitude] = coordinates;
    const { category, risk } = classifyCallType(call.IncidentTypeDescription, call.CurrentPriorityKey);

    // `IncidentDate` is local wall-clock stored as epoch-as-if-UTC, so emitting
    // it directly shifted every call 7 hours earlier — a 9pm shooting published
    // as 1:58pm — which also mislabelled live events as `historical`.
    const occurredAtMs = utcInstantOf(call);
    const issued = new Date(occurredAtMs).toISOString();

    const isRecent = Date.now() - occurredAtMs < 24 * 60 * 60 * 1000;
    const temporalType = isRecent ? 'real-time' : 'historical';

    // Unit times share `IncidentDate`'s local-as-UTC space; shift them the same way.
    const offsetMs = occurredAtMs - call.IncidentDate;
    const shift = (value?: number) =>
      typeof value === 'number' && Number.isFinite(value)
        ? new Date(value + offsetMs).toISOString()
        : undefined;

    return this.createAlert({
      id: `glendale-police-${call.IncidentNumber}`,
      externalId: call.IncidentNumber,
      title: this.formatCallType(call.IncidentTypeDescription),
      description: this.buildDescription(call),
      riskLevel: risk,
      priority: this.riskLevelToPriority(risk),
      category,
      temporalType,
      location: {
        point: { latitude, longitude },
        address: call.Location,
        city: call.CityName ?? 'Glendale',
        state: 'AZ',
        zipCode: call.ZipCode,
      },
      timestamps: {
        issued,
        eventStart: issued,
      },
      metadata: {
        incidentNumber: call.IncidentNumber,
        callType: call.IncidentTypeDescription,
        initialCallType: call.InitialIncidentTypeDescription,
        priority: call.CurrentPriorityKey,
        callSource: call.CallSource,
        status: call.IncidentStatusDescription,
        locationName: call.LocationName,
        crossStreet: call.CrossStreet,
        beat: call.BeatName,
        area: call.AreaName,
        sector: call.SectorName,
        disposition: call.AllDispositionDescriptions,
        patrolDivision: call.PATROL_DIVISION_GIS,
        // Emergency response, previously dropped entirely.
        primaryUnit: call.PrimaryUnitId,
        dispatchedAt: shift(call.FirstUnitDispatchedTime),
        enrouteAt: shift(call.FirstUnitEnrouteTime),
        arrivedAt: shift(call.FirstUnitArrivedTime),
      },
    });
  }

  /**
   * Format call type for display, dropping the GPD code: `901G-SHOOTING` → `Shooting`.
   */
  private formatCallType(callType: string | undefined | null): string {
    const { code, text } = parseCallCode(callType);
    const label = text || code || 'Unknown';
    return label
      .split(/[\s_]+/)
      .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join(' ')
      .trim();
  }

  /**
   * Build description from call data.
   */
  private buildDescription(call: GlendalePoliceCall): string {
    const parts: string[] = [];

    parts.push(`Type: ${call.IncidentTypeDescription}`);

    if (call.InitialIncidentTypeDescription && call.InitialIncidentTypeDescription !== call.IncidentTypeDescription) {
      parts.push(`Initial Type: ${call.InitialIncidentTypeDescription}`);
    }

    if (call.Location) {
      parts.push(`Location: ${call.Location}${call.LocationName ? ` (${call.LocationName})` : ''}`);
    }

    if (call.CurrentPriorityKey) {
      parts.push(`Priority: ${call.CurrentPriorityKey}${call.CurrentPriorityKey === 1 ? ' (life-threatening)' : ''}`);
    }

    if (call.IncidentStatusDescription) {
      parts.push(`Status: ${call.IncidentStatusDescription}`);
    }

    // Response times tell a guard whether units are still on scene.
    if (call.FirstUnitArrivedTime) {
      const responseMs = call.FirstUnitArrivedTime - call.IncidentDate;
      if (responseMs >= 0) {
        parts.push(`First unit on scene: ${Math.round(responseMs / 60000)} min after call${call.PrimaryUnitId ? ` (${call.PrimaryUnitId})` : ''}`);
      }
    } else if (call.FirstUnitDispatchedTime) {
      parts.push('Units dispatched; no arrival recorded');
    }

    if (call.BeatName) {
      parts.push(`Beat: ${call.BeatName}`);
    }

    if (call.AllDispositionDescriptions) {
      parts.push(`Disposition: ${call.AllDispositionDescriptions}`);
    }

    return parts.join('\n');
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
