import type { Alert, RiskLevel, GeoPoint, TimeRange, QueryIntent } from '../types';
import { RISK_LEVEL_VALUES } from '../types';
import { haversineDistance } from '../geo';

/**
 * Options for aggregating alerts.
 */
export interface AggregateOptions {
  /** Minimum risk level to include */
  minRiskLevel?: RiskLevel;
  /** Maximum number of alerts to return */
  limit?: number;
  /** Time range to filter by */
  timeRange?: TimeRange;
  /** Center location for distance calculations */
  location?: GeoPoint;
  /** Radius in meters for location filtering */
  radiusMeters?: number;
  /** How to rank + select. Defaults to `triage`. See {@link QueryIntent}. */
  intent?: QueryIntent;
  /** "Now", for recency scoring. Injectable for tests. */
  now?: number;
}

/**
 * An alert still unfolding is treated as one band more urgent. A fire with units
 * on scene right now outranks a settled incident of the same nominal severity —
 * but it does NOT leapfrog a genuinely worse one.
 */
const REAL_TIME_BAND_BOOST = 1;

/**
 * Severity band dominates; recency only orders *within* a band.
 *
 * A multiplicative recency decay was tried and is wrong for this domain: with
 * any decay steep enough to make "live" matter, a fresh **roadwork** notice
 * outranks a **shooting** from six days ago. For a guard, severity is not
 * negotiable — a shooting near their post last week is material no matter how
 * much roadwork happened since. So risk is the primary key, liveness nudges by
 * one band, and time is the tie-breaker.
 *
 * The multiplier is larger than any epoch-ms timestamp, so the band can never be
 * crossed by recency alone.
 */
const BAND_MULTIPLIER = 1e13;

/**
 * Sort order for alerts.
 */
export type AlertSortOrder =
  | 'priority-asc'
  | 'priority-desc'
  | 'risk-asc'
  | 'risk-desc'
  | 'time-asc'
  | 'time-desc'
  | 'distance-asc'
  | 'distance-desc';

/**
 * Aggregates, filters, deduplicates, and sorts alerts from multiple sources.
 */
export class AlertAggregator {
  /**
   * Aggregate alerts from multiple sources.
   *
   * Combines alerts, removes duplicates, filters by criteria, and sorts.
   *
   * @param alertSets - Arrays of alerts from different plugins
   * @param options - Aggregation options
   * @returns Aggregated and filtered alerts
   */
  aggregate(alertSets: Alert[][], options: AggregateOptions = {}): Alert[] {
    // Flatten all alerts
    let alerts = alertSets.flat();

    // Deduplicate
    alerts = this.deduplicate(alerts);

    // Filter by risk level
    if (options.minRiskLevel) {
      alerts = this.filterByRiskLevel(alerts, options.minRiskLevel);
    }

    // Filter by time range
    if (options.timeRange) {
      alerts = this.filterByTimeRange(alerts, options.timeRange);
    }

    // Filter by location radius
    if (options.location && options.radiusMeters) {
      alerts = this.filterByRadius(alerts, options.location, options.radiusMeters);
    }

    const limit = options.limit;
    const intent = options.intent ?? 'triage';
    const now = options.now ?? Date.now();

    if (intent === 'focused') {
      // The caller already narrowed the question ("show me fire calls"), so
      // severity is not the sort key — they want the latest, fullest set in
      // scope. No cross-category balancing: they chose the categories.
      alerts = this.sort(alerts, ['time-desc']);
      return limit && alerts.length > limit ? alerts.slice(0, limit) : alerts;
    }

    // Triage: "what matters most near me, right now."
    return this.selectForTriage(alerts, limit, now);
  }

  /**
   * Score an alert for triage: how much a guard should care, right now.
   *
   * Severity band first (a shooting always outranks roadwork, however fresh the
   * roadwork), an in-progress incident counts one band higher, and time breaks
   * ties inside a band so the newest of equally-bad things leads.
   */
  scoreForTriage(alert: Alert, now: number = Date.now()): number {
    const risk = RISK_LEVEL_VALUES[alert.riskLevel] ?? 1;
    const band = risk + (alert.temporalType === 'real-time' ? REAL_TIME_BAND_BOOST : 0);

    const issued = new Date(alert.timestamps.issued).getTime();
    // Unparseable/absent → treat as oldest, never as "now".
    const when = Number.isFinite(issued) ? Math.min(issued, now) : 0;

    return band * BAND_MULTIPLIER + when;
  }

  /**
   * Pick the final set for a triage query, giving each **category** a fair
   * share rather than letting the highest-scoring source take every slot.
   *
   * Why: a busy police feed legitimately produces dozens of severe alerts in a
   * week. Ranked on a single flat list they fill all N slots, and the guard
   * never sees the active fire, the heat warning, or the road closure — even
   * though those are exactly what "what's happening near me" means. Round-robin
   * across categories (each internally ordered by score) guarantees every kind
   * of risk present is represented, while still leading with the worst of each.
   * Leftover slots go to whatever scores highest overall, so a genuinely
   * crime-dominated area still surfaces mostly crime.
   */
  private selectForTriage(alerts: Alert[], limit: number | undefined, now: number): Alert[] {
    const scored = alerts
      .map((alert) => ({ alert, score: this.scoreForTriage(alert, now) }))
      .sort((a, b) => b.score - a.score);

    if (!limit || scored.length <= limit) {
      return scored.map((s) => s.alert);
    }

    // Bucket by category, each already in descending score order.
    const buckets = new Map<string, Alert[]>();
    for (const { alert } of scored) {
      const bucket = buckets.get(alert.category);
      if (bucket) bucket.push(alert);
      else buckets.set(alert.category, [alert]);
    }

    const picked: Alert[] = [];
    const taken = new Set<string>();
    const queues = [...buckets.values()];

    // Round-robin one from each category until full or every bucket is drained.
    let progressed = true;
    while (picked.length < limit && progressed) {
      progressed = false;
      for (const queue of queues) {
        if (picked.length >= limit) break;
        const next = queue.shift();
        if (!next) continue;
        picked.push(next);
        taken.add(next.id);
        progressed = true;
      }
    }

    // Any slots left (a category ran dry) go to the best of the rest.
    if (picked.length < limit) {
      for (const { alert } of scored) {
        if (picked.length >= limit) break;
        if (!taken.has(alert.id)) {
          picked.push(alert);
          taken.add(alert.id);
        }
      }
    }

    // Present the chosen set worst-first, so the top of the list is the top risk.
    return picked.sort((a, b) => this.scoreForTriage(b, now) - this.scoreForTriage(a, now));
  }

  /**
   * Remove duplicate alerts based on ID and source.
   *
   * If two alerts have the same ID or the same external ID from the same source,
   * keep the one with the most recent issued timestamp.
   */
  deduplicate(alerts: Alert[]): Alert[] {
    // Use two maps: one for lookup and one for tracking unique alerts
    const seenByPrimaryKey = new Map<string, Alert>();
    const seenBySecondaryKey = new Map<string, string>(); // secondary key -> primary key

    for (const alert of alerts) {
      // Primary dedup key: alert ID
      const primaryKey = alert.id;

      // Secondary dedup key: source external ID (if available)
      const secondaryKey = alert.source.externalId
        ? `${alert.source.pluginId}:${alert.source.externalId}`
        : null;

      // Check if we've seen this secondary key before
      if (secondaryKey) {
        const existingPrimaryKey = seenBySecondaryKey.get(secondaryKey);
        if (existingPrimaryKey) {
          const existing = seenByPrimaryKey.get(existingPrimaryKey);
          if (existing && new Date(alert.timestamps.issued) > new Date(existing.timestamps.issued)) {
            // Replace with newer alert
            seenByPrimaryKey.delete(existingPrimaryKey);
            seenByPrimaryKey.set(primaryKey, alert);
            seenBySecondaryKey.set(secondaryKey, primaryKey);
          }
          continue;
        }
      }

      // Check primary key
      const existingPrimary = seenByPrimaryKey.get(primaryKey);
      if (existingPrimary) {
        // Keep the more recent one
        if (new Date(alert.timestamps.issued) > new Date(existingPrimary.timestamps.issued)) {
          seenByPrimaryKey.set(primaryKey, alert);
        }
        continue;
      }

      // New alert - store it
      seenByPrimaryKey.set(primaryKey, alert);
      if (secondaryKey) {
        seenBySecondaryKey.set(secondaryKey, primaryKey);
      }
    }

    return Array.from(seenByPrimaryKey.values());
  }

  /**
   * Filter alerts by minimum risk level.
   */
  filterByRiskLevel(alerts: Alert[], minLevel: RiskLevel): Alert[] {
    const minValue = RISK_LEVEL_VALUES[minLevel];
    return alerts.filter((alert) => RISK_LEVEL_VALUES[alert.riskLevel] >= minValue);
  }

  /**
   * Filter alerts by time range.
   *
   * Includes alerts where:
   * - The issued timestamp falls within the range, OR
   * - The event start/end times overlap with the range
   */
  filterByTimeRange(alerts: Alert[], range: TimeRange): Alert[] {
    const rangeStart = new Date(range.start).getTime();
    const rangeEnd = new Date(range.end).getTime();

    return alerts.filter((alert) => {
      // Check if issued time is in range
      const issuedTime = new Date(alert.timestamps.issued).getTime();
      if (issuedTime >= rangeStart && issuedTime <= rangeEnd) {
        return true;
      }

      // Check if event times overlap
      const eventStart = alert.timestamps.eventStart
        ? new Date(alert.timestamps.eventStart).getTime()
        : null;
      const eventEnd = alert.timestamps.eventEnd
        ? new Date(alert.timestamps.eventEnd).getTime()
        : null;

      if (eventStart !== null && eventEnd !== null) {
        // Event has both start and end - check for overlap
        return eventStart <= rangeEnd && eventEnd >= rangeStart;
      }

      if (eventStart !== null) {
        // Only start time - check if it's in range
        return eventStart >= rangeStart && eventStart <= rangeEnd;
      }

      return false;
    });
  }

  /**
   * Filter alerts by distance from a center point.
   */
  filterByRadius(alerts: Alert[], center: GeoPoint, radiusMeters: number): Alert[] {
    return alerts.filter((alert) => {
      const distance = haversineDistance(center, alert.location.point);
      return distance <= radiusMeters;
    });
  }

  /**
   * Sort alerts by one or more criteria.
   *
   * Later criteria are used as tiebreakers.
   */
  sort(alerts: Alert[], orders: AlertSortOrder[]): Alert[] {
    return [...alerts].sort((a, b) => {
      for (const order of orders) {
        const comparison = this.compare(a, b, order);
        if (comparison !== 0) return comparison;
      }
      return 0;
    });
  }

  /**
   * Compare two alerts based on a sort order.
   */
  private compare(a: Alert, b: Alert, order: AlertSortOrder): number {
    switch (order) {
      case 'priority-asc':
        return a.priority - b.priority;
      case 'priority-desc':
        return b.priority - a.priority;
      case 'risk-asc':
        return RISK_LEVEL_VALUES[a.riskLevel] - RISK_LEVEL_VALUES[b.riskLevel];
      case 'risk-desc':
        return RISK_LEVEL_VALUES[b.riskLevel] - RISK_LEVEL_VALUES[a.riskLevel];
      case 'time-asc':
        return new Date(a.timestamps.issued).getTime() - new Date(b.timestamps.issued).getTime();
      case 'time-desc':
        return new Date(b.timestamps.issued).getTime() - new Date(a.timestamps.issued).getTime();
      case 'distance-asc':
      case 'distance-desc':
        // Distance sorting requires a reference point, not supported in basic compare
        return 0;
    }
  }

  /**
   * Sort alerts by distance from a center point.
   */
  sortByDistance(alerts: Alert[], center: GeoPoint, ascending = true): Alert[] {
    return [...alerts].sort((a, b) => {
      const distA = haversineDistance(center, a.location.point);
      const distB = haversineDistance(center, b.location.point);
      return ascending ? distA - distB : distB - distA;
    });
  }

  /**
   * Group alerts by category.
   */
  groupByCategory(alerts: Alert[]): Map<string, Alert[]> {
    const groups = new Map<string, Alert[]>();

    for (const alert of alerts) {
      const existing = groups.get(alert.category) ?? [];
      existing.push(alert);
      groups.set(alert.category, existing);
    }

    return groups;
  }

  /**
   * Group alerts by source plugin.
   */
  groupBySource(alerts: Alert[]): Map<string, Alert[]> {
    const groups = new Map<string, Alert[]>();

    for (const alert of alerts) {
      const existing = groups.get(alert.source.pluginId) ?? [];
      existing.push(alert);
      groups.set(alert.source.pluginId, existing);
    }

    return groups;
  }
}
