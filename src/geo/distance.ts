import type { GeoPoint } from '../types';

/**
 * Earth's radius in meters (mean radius).
 */
export const EARTH_RADIUS_METERS = 6_371_008.8;

/**
 * Convert degrees to radians.
 */
export function toRadians(degrees: number): number {
  return degrees * (Math.PI / 180);
}

/**
 * Convert radians to degrees.
 */
export function toDegrees(radians: number): number {
  return radians * (180 / Math.PI);
}

/**
 * Calculate the Haversine distance between two geographic points.
 *
 * The Haversine formula calculates the great-circle distance between two points
 * on a sphere given their latitudes and longitudes.
 *
 * @param point1 - First geographic point
 * @param point2 - Second geographic point
 * @returns Distance in meters
 */
export function haversineDistance(point1: GeoPoint, point2: GeoPoint): number {
  const lat1 = toRadians(point1.latitude);
  const lat2 = toRadians(point2.latitude);
  const deltaLat = toRadians(point2.latitude - point1.latitude);
  const deltaLon = toRadians(point2.longitude - point1.longitude);

  const a =
    Math.sin(deltaLat / 2) * Math.sin(deltaLat / 2) +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) * Math.sin(deltaLon / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return EARTH_RADIUS_METERS * c;
}

/**
 * Calculate distance between two points (alias for haversineDistance).
 *
 * @param point1 - First geographic point
 * @param point2 - Second geographic point
 * @returns Distance in meters
 */
export function calculateDistance(point1: GeoPoint, point2: GeoPoint): number {
  return haversineDistance(point1, point2);
}

/**
 * Calculate the bearing (direction) from one point to another.
 *
 * @param from - Starting point
 * @param to - Ending point
 * @returns Bearing in degrees (0-360, where 0 is north)
 */
export function calculateBearing(from: GeoPoint, to: GeoPoint): number {
  const lat1 = toRadians(from.latitude);
  const lat2 = toRadians(to.latitude);
  const deltaLon = toRadians(to.longitude - from.longitude);

  const y = Math.sin(deltaLon) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(deltaLon);

  const bearing = toDegrees(Math.atan2(y, x));
  return (bearing + 360) % 360;
}

/**
 * Calculate a destination point given a start point, bearing, and distance.
 *
 * @param start - Starting point
 * @param bearingDegrees - Bearing in degrees (0-360)
 * @param distanceMeters - Distance in meters
 * @returns Destination point
 */
export function destinationPoint(
  start: GeoPoint,
  bearingDegrees: number,
  distanceMeters: number
): GeoPoint {
  const lat1 = toRadians(start.latitude);
  const lon1 = toRadians(start.longitude);
  const bearing = toRadians(bearingDegrees);
  const angularDistance = distanceMeters / EARTH_RADIUS_METERS;

  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(angularDistance) +
      Math.cos(lat1) * Math.sin(angularDistance) * Math.cos(bearing)
  );

  const lon2 =
    lon1 +
    Math.atan2(
      Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(lat1),
      Math.cos(angularDistance) - Math.sin(lat1) * Math.sin(lat2)
    );

  return {
    latitude: toDegrees(lat2),
    longitude: toDegrees(lon2),
  };
}
