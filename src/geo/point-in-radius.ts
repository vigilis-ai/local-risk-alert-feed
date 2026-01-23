import type { GeoPoint, GeoBoundingBox, GeoCircle } from '../types';
import { haversineDistance } from './distance';

/**
 * Check if a point is within a given radius of a center point.
 *
 * @param point - The point to check
 * @param center - The center point
 * @param radiusMeters - The radius in meters
 * @returns true if the point is within the radius
 */
export function isPointInRadius(point: GeoPoint, center: GeoPoint, radiusMeters: number): boolean {
  const distance = haversineDistance(point, center);
  return distance <= radiusMeters;
}

/**
 * Check if a point is within a GeoCircle.
 *
 * @param point - The point to check
 * @param circle - The circle definition
 * @returns true if the point is within the circle
 */
export function isPointInCircle(point: GeoPoint, circle: GeoCircle): boolean {
  return isPointInRadius(point, circle.center, circle.radiusMeters);
}

/**
 * Check if a point is within a bounding box.
 *
 * @param point - The point to check
 * @param box - The bounding box
 * @returns true if the point is within the bounding box
 */
export function isPointInBoundingBox(point: GeoPoint, box: GeoBoundingBox): boolean {
  const { southwest, northeast } = box;

  // Handle the case where the bounding box crosses the antimeridian
  if (southwest.longitude > northeast.longitude) {
    // Box crosses antimeridian
    return (
      point.latitude >= southwest.latitude &&
      point.latitude <= northeast.latitude &&
      (point.longitude >= southwest.longitude || point.longitude <= northeast.longitude)
    );
  }

  return (
    point.latitude >= southwest.latitude &&
    point.latitude <= northeast.latitude &&
    point.longitude >= southwest.longitude &&
    point.longitude <= northeast.longitude
  );
}

/**
 * Check if two circles overlap.
 *
 * @param circle1 - First circle
 * @param circle2 - Second circle
 * @returns true if the circles overlap
 */
export function doCirclesOverlap(circle1: GeoCircle, circle2: GeoCircle): boolean {
  const distance = haversineDistance(circle1.center, circle2.center);
  return distance <= circle1.radiusMeters + circle2.radiusMeters;
}

/**
 * Calculate a bounding box that contains a circle.
 * This is useful for quick filtering before doing precise distance calculations.
 *
 * @param center - Center point of the circle
 * @param radiusMeters - Radius in meters
 * @returns A bounding box that contains the circle
 */
export function getBoundingBoxForRadius(center: GeoPoint, radiusMeters: number): GeoBoundingBox {
  // Approximate degrees per meter at the given latitude
  const latDelta = radiusMeters / 111_320; // ~111.32km per degree latitude
  const lonDelta = radiusMeters / (111_320 * Math.cos((center.latitude * Math.PI) / 180));

  return {
    southwest: {
      latitude: Math.max(-90, center.latitude - latDelta),
      longitude: center.longitude - lonDelta,
    },
    northeast: {
      latitude: Math.min(90, center.latitude + latDelta),
      longitude: center.longitude + lonDelta,
    },
  };
}
