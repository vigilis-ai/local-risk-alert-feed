import { describe, it, expect } from 'vitest';
import { PluginFetchResultSchema, parsePluginFetchResultLenient } from './index';

/**
 * One malformed optional field used to discard an entire plugin's response.
 *
 * `PluginFetchResultSchema` validates `z.array(AlertSchema)`, and zod fails the
 * whole array on the first bad element. `federation/client.ts` called `.parse()`
 * on it, so a provider sending `url: "county bulletin board"` did not lose its
 * link — it took every alert in that response down with it, as a thrown error,
 * with nothing shown to the guard.
 */

const alert = (overrides: Record<string, unknown> = {}) => ({
  id: 'a1',
  title: 'Structure fire',
  description: 'Reported structure fire',
  riskLevel: 'high',
  priority: 2,
  category: 'fire',
  temporalType: 'real-time',
  location: { point: { latitude: 29.76, longitude: -95.37 } },
  timestamps: { issued: '2026-08-17T10:00:00Z' },
  source: { pluginId: 'probe', name: 'Probe Feed', type: 'fire' },
  ...overrides,
});

describe('parsePluginFetchResultLenient', () => {
  it('keeps the good alerts when one carries a malformed url', () => {
    const batch = {
      alerts: [
        alert({ id: 'ok-1' }),
        alert({ id: 'ok-2' }),
        alert({ id: 'bad', url: 'county bulletin board' }),
        alert({ id: 'ok-3' }),
      ],
    };

    // The strict schema is why this mattered: all four are lost.
    expect(PluginFetchResultSchema.safeParse(batch).success).toBe(false);

    const result = parsePluginFetchResultLenient(batch);
    expect(result.alerts).toHaveLength(4);
    expect(result.alerts.map((a) => a.id)).toEqual(['ok-1', 'ok-2', 'bad', 'ok-3']);
  });

  it('drops only the malformed url, keeping the alert that carried it', () => {
    const result = parsePluginFetchResultLenient({
      alerts: [alert({ url: 'county bulletin board' })],
    });
    expect(result.alerts).toHaveLength(1);
    expect(result.alerts[0].url).toBeUndefined();
  });

  it('preserves a valid url untouched', () => {
    const result = parsePluginFetchResultLenient({
      alerts: [alert({ url: 'https://alerts.weather.gov/cap/example' })],
    });
    expect(result.alerts[0].url).toBe('https://alerts.weather.gov/cap/example');
  });

  it('degrades other malformed optionals rather than losing the alert', () => {
    const result = parsePluginFetchResultLenient({
      alerts: [
        alert({
          timestamps: { issued: '2026-08-17T10:00:00Z', eventEnd: 'sometime tomorrow' },
          location: { point: { latitude: 29.76, longitude: -95.37 }, radiusMeters: -5 },
        }),
      ],
    });
    expect(result.alerts).toHaveLength(1);
    expect(result.alerts[0].timestamps.eventEnd).toBeUndefined();
    expect(result.alerts[0].location.radiusMeters).toBeUndefined();
    // The required parts are untouched.
    expect(result.alerts[0].timestamps.issued).toBe('2026-08-17T10:00:00Z');
  });

  it('still drops an alert missing something it cannot be rendered without, alone', () => {
    const result = parsePluginFetchResultLenient({
      alerts: [alert({ id: 'ok' }), alert({ id: 'no-location', location: undefined })],
    });
    expect(result.alerts.map((a) => a.id)).toEqual(['ok']);
    expect(result.warnings?.some((w) => w.includes('1 alert dropped'))).toBe(true);
  });

  it('says nothing when every alert is fine', () => {
    const result = parsePluginFetchResultLenient({ alerts: [alert()] });
    expect(result.warnings).toBeUndefined();
  });

  it('keeps warnings the plugin itself reported', () => {
    const result = parsePluginFetchResultLenient({
      alerts: [alert({ id: 'bad', location: undefined })],
      warnings: ['upstream returned a partial window'],
    });
    expect(result.warnings).toEqual([
      'upstream returned a partial window',
      '1 alert dropped: did not satisfy the alert contract',
    ]);
  });
});
