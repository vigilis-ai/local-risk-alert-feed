import { describe, it, expect } from 'vitest';
import { parseFaaDurationMinutes } from './faa-airport-status.plugin';

describe('parseFaaDurationMinutes', () => {
  it('parses minutes only', () => {
    expect(parseFaaDurationMinutes('36 minutes')).toBe(36);
    expect(parseFaaDurationMinutes('1 minute')).toBe(1);
  });

  it('parses hours and minutes', () => {
    expect(parseFaaDurationMinutes('1 hour and 24 minutes')).toBe(84);
    expect(parseFaaDurationMinutes('2 hours and 12 minutes')).toBe(132);
    expect(parseFaaDurationMinutes('17 hours and 1 minute')).toBe(1021);
  });

  it('parses hours only', () => {
    expect(parseFaaDurationMinutes('3 hours')).toBe(180);
  });

  it('returns null for missing or unparseable input', () => {
    expect(parseFaaDurationMinutes(undefined)).toBeNull();
    expect(parseFaaDurationMinutes('')).toBeNull();
    expect(parseFaaDurationMinutes('unknown')).toBeNull();
  });
});
