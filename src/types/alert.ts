import type { AlertLocation } from './geo';

/**
 * Risk levels from lowest to highest severity.
 */
export type RiskLevel = 'low' | 'moderate' | 'high' | 'severe' | 'extreme';

/**
 * Priority levels where 1 is the highest priority.
 */
export type AlertPriority = 1 | 2 | 3 | 4 | 5;

/**
 * Categories of alerts.
 */
export type AlertCategory =
  | 'crime'
  | 'fire'
  | 'medical'
  | 'weather'
  | 'traffic'
  | 'event'
  | 'civil-unrest'
  | 'other';

/**
 * Temporal classification of alerts.
 * - historical: Events that have already occurred
 * - scheduled: Events that are planned for the future
 * - real-time: Events happening now or in progress
 */
export type AlertTemporalType = 'historical' | 'scheduled' | 'real-time';

/**
 * Source type classification.
 */
export type AlertSourceType = 'police' | 'fire' | 'weather' | 'events' | 'traffic' | 'other';

/**
 * Timestamps associated with an alert.
 */
export interface AlertTimestamps {
  /** When the alert was created/issued */
  issued: string;
  /** When the event started or is scheduled to start */
  eventStart?: string;
  /** When the event ended or is scheduled to end */
  eventEnd?: string;
  /** When the alert expires and should no longer be displayed */
  expires?: string;
}

/**
 * Information about the source of an alert.
 */
export interface AlertSource {
  /** Unique identifier of the plugin that generated this alert */
  pluginId: string;
  /** Human-readable name of the source */
  name: string;
  /** External identifier from the original data source */
  externalId?: string;
  /** Type classification of the source */
  type: AlertSourceType;
}

/**
 * Represents a risk alert from any source.
 */
export interface Alert {
  /** Unique identifier for this alert */
  id: string;
  /** Short title/headline for the alert */
  title: string;
  /** Detailed description of the alert */
  description: string;
  /** Risk level assessment */
  riskLevel: RiskLevel;
  /** Priority ranking (1 = highest) */
  priority: AlertPriority;
  /** Category classification */
  category: AlertCategory;
  /** Temporal classification */
  temporalType: AlertTemporalType;
  /** Location information */
  location: AlertLocation;
  /** Relevant timestamps */
  timestamps: AlertTimestamps;
  /** Source information */
  source: AlertSource;
  /** URL for more information */
  url?: string;
  /** Additional metadata from the source */
  metadata?: Record<string, unknown>;
}

/**
 * Numeric mapping for risk levels (for sorting/comparison).
 */
export const RISK_LEVEL_VALUES: Record<RiskLevel, number> = {
  low: 1,
  moderate: 2,
  high: 3,
  severe: 4,
  extreme: 5,
};

/**
 * Ordered list of risk levels from lowest to highest.
 */
export const RISK_LEVELS: RiskLevel[] = ['low', 'moderate', 'high', 'severe', 'extreme'];

/**
 * All supported alert categories.
 */
export const ALERT_CATEGORIES: AlertCategory[] = [
  'crime',
  'fire',
  'medical',
  'weather',
  'traffic',
  'event',
  'civil-unrest',
  'other',
];

/**
 * All supported temporal types.
 */
export const ALERT_TEMPORAL_TYPES: AlertTemporalType[] = ['historical', 'scheduled', 'real-time'];
