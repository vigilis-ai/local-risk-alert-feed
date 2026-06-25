import { describe, it, expect } from 'vitest';
import { mapWorkZoneRisk } from './nj-workzones.plugin';

describe('mapWorkZoneRisk', () => {
  it('uses vehicle_impact when it indicates closures', () => {
    expect(mapWorkZoneRisk('', 'all-lanes-closed')).toBe('severe');
    expect(mapWorkZoneRisk('', 'some-lanes-closed')).toBe('moderate');
    expect(mapWorkZoneRisk('', 'alternating-one-way')).toBe('moderate');
  });

  it('falls back to description text (NJ feed reports impact uniformly)', () => {
    expect(mapWorkZoneRisk('Road closed in both directions', 'all-lanes-open')).toBe('severe');
    expect(mapWorkZoneRisk('1 left lane closed of 3', 'all-lanes-open')).toBe('moderate');
    expect(mapWorkZoneRisk('Right shoulder closed for utility work', 'all-lanes-open')).toBe('low');
  });

  it('defaults to low for general roadwork with no closure', () => {
    expect(mapWorkZoneRisk('Surface work, all lanes open', 'all-lanes-open')).toBe('low');
    expect(mapWorkZoneRisk(undefined, undefined)).toBe('low');
  });
});
