import type { Alert, RiskLevel, GeoPoint, TimeRange } from '../types';
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
}

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

    // Sort by priority (primary) and time (secondary)
    alerts = this.sort(alerts, ['priority-asc', 'time-desc']);

    // Apply limit
    if (options.limit && alerts.length > options.limit) {
      alerts = alerts.slice(0, options.limit);
    }

    return alerts;
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
