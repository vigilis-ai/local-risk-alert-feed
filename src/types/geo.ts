/**
 * Represents a geographic point with latitude and longitude coordinates.
 */
export interface GeoPoint {
  latitude: number;
  longitude: number;
}

/**
 * Represents a geographic bounding box defined by southwest and northeast corners.
 */
export interface GeoBoundingBox {
  southwest: GeoPoint;
  northeast: GeoPoint;
}

/**
 * Represents a geographic circle defined by a center point and radius.
 */
export interface GeoCircle {
  center: GeoPoint;
  radiusMeters: number;
}

/**
 * Location information that can be attached to an alert.
 */
export interface AlertLocation {
  point: GeoPoint;
  radiusMeters?: number;
  address?: string;
  city?: string;
  state?: string;
  zipCode?: string;
}
