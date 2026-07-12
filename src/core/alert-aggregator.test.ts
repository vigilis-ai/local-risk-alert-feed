import { describe, it, expect } from 'vitest';
import { AlertAggregator } from './alert-aggregator';
import type { Alert, AlertCategory, RiskLevel, AlertTemporalType } from '../types';

const NOW = Date.parse('2026-07-11T12:00:00Z');

let seq = 0;
function alert(
  category: AlertCategory,
  riskLevel: RiskLevel,
  ageHours: number,
  opts: { temporalType?: AlertTemporalType; pluginId?: string } = {},
): Alert {
  seq++;
  const issued = new Date(NOW - ageHours * 3_600_000).toISOString();
  return {
    id: `a${seq}`,
    title: `${category}/${riskLevel}/${ageHours}h`,
    description: '',
    riskLevel,
    priority: 1,
    category,
    temporalType: opts.temporalType ?? 'historical',
    location: { point: { latitude: 33.5, longitude: -112.2 } },
    timestamps: { issued },
    source: {
      pluginId: opts.pluginId ?? `${category}-src`,
      name: 'x',
      type: 'police',
    },
  } as Alert;
}

const agg = new AlertAggregator();

describe('triage selection — the crowding-out fix', () => {
  it('gives every category a share instead of letting one source take all slots', () => {
    // Reality at Tanger Outlets: a week of severe police calls (478) alongside
    // hundreds of fire/EMS incidents. Flat risk-ranking gave the guard 50/50
    // police and ZERO fire — an active fire next door never surfaced.
    const crime = Array.from({ length: 200 }, (_, i) => alert('crime', 'severe', i % 168));
    const fire = Array.from({ length: 200 }, (_, i) => alert('fire', 'high', i % 168));
    const traffic = Array.from({ length: 100 }, (_, i) => alert('traffic', 'moderate', i % 168));

    const out = agg.aggregate([crime, fire, traffic], { limit: 30, intent: 'triage', now: NOW });

    expect(out).toHaveLength(30);
    const cats = new Set(out.map((a) => a.category));
    expect(cats).toContain('crime');
    expect(cats).toContain('fire');
    expect(cats).toContain('traffic');
    // No single category may monopolise the answer.
    for (const c of cats) {
      const share = out.filter((a) => a.category === c).length;
      expect(share).toBeLessThan(out.length);
    }
  });

  it('still leads with the most serious thing', () => {
    const out = agg.aggregate(
      [[alert('crime', 'low', 0)], [alert('fire', 'extreme', 0)], [alert('traffic', 'moderate', 0)]],
      { limit: 3, intent: 'triage', now: NOW },
    );
    expect(out[0].riskLevel).toBe('extreme');
  });

  it('ranks a live incident above an equally-severe stale one', () => {
    const stale = alert('crime', 'severe', 144, { temporalType: 'historical' }); // 6 days old
    const live = alert('fire', 'severe', 0, { temporalType: 'real-time' }); // happening now

    const out = agg.aggregate([[stale], [live]], { limit: 2, intent: 'triage', now: NOW });
    expect(out[0].id).toBe(live.id);
  });

  it('breaks ties by recency WITHIN a severity band', () => {
    const weekOldHigh = alert('crime', 'high', 168);
    const freshHigh = alert('crime', 'high', 0);
    expect(agg.scoreForTriage(freshHigh, NOW)).toBeGreaterThan(agg.scoreForTriage(weekOldHigh, NOW));
  });

  it('NEVER lets recency cross a severity band — fresh roadwork must not outrank an old shooting', () => {
    // The bug this guards: with a multiplicative recency decay, a moderate
    // roadwork notice from this morning scored above the July 4 shooting, and
    // the guard's top-5 was roadwork. Severity is not negotiable.
    const oldShooting = alert('crime', 'extreme', 168); // a week ago
    const freshRoadwork = alert('traffic', 'moderate', 0); // right now

    expect(agg.scoreForTriage(oldShooting, NOW)).toBeGreaterThan(
      agg.scoreForTriage(freshRoadwork, NOW),
    );

    const out = agg.aggregate([[freshRoadwork], [oldShooting]], {
      limit: 2,
      intent: 'triage',
      now: NOW,
    });
    expect(out[0].id).toBe(oldShooting.id);
  });

  it('a live incident is bumped one band, but cannot leapfrog a genuinely worse one', () => {
    const liveHigh = alert('fire', 'high', 0, { temporalType: 'real-time' }); // → severe-equivalent
    const staleSevere = alert('crime', 'severe', 100);
    const staleExtreme = alert('crime', 'extreme', 100);

    // Bumped above an equal-severity stale one...
    expect(agg.scoreForTriage(liveHigh, NOW)).toBeGreaterThan(agg.scoreForTriage(staleSevere, NOW));
    // ...but not above something genuinely worse.
    expect(agg.scoreForTriage(liveHigh, NOW)).toBeLessThan(agg.scoreForTriage(staleExtreme, NOW));
  });

  it('does not truncate when everything fits', () => {
    const out = agg.aggregate([[alert('crime', 'low', 1)], [alert('fire', 'low', 1)]], {
      limit: 50,
      intent: 'triage',
      now: NOW,
    });
    expect(out).toHaveLength(2);
  });

  it('fills leftover slots from the best of the rest when a category runs dry', () => {
    // Only 1 fire alert exists; the other 9 slots must still be used.
    const crime = Array.from({ length: 20 }, (_, i) => alert('crime', 'high', i));
    const out = agg.aggregate([crime, [alert('fire', 'low', 1)]], {
      limit: 10,
      intent: 'triage',
      now: NOW,
    });
    expect(out).toHaveLength(10);
    expect(out.filter((a) => a.category === 'fire')).toHaveLength(1);
    expect(out.filter((a) => a.category === 'crime')).toHaveLength(9);
  });
});

describe('focused selection — the caller already narrowed it', () => {
  it('orders by recency, not severity — "show me the latest fire calls"', () => {
    const older = alert('fire', 'extreme', 100);
    const newer = alert('fire', 'low', 1);

    const out = agg.aggregate([[older, newer]], { limit: 10, intent: 'focused', now: NOW });
    // Severity is not the question; the newest comes first.
    expect(out[0].id).toBe(newer.id);
  });

  it('does not balance across categories — returns the fullest set in scope', () => {
    const fire = Array.from({ length: 20 }, (_, i) => alert('fire', 'high', i));
    const out = agg.aggregate([fire], { limit: 10, intent: 'focused', now: NOW });
    expect(out).toHaveLength(10);
    expect(out.every((a) => a.category === 'fire')).toBe(true);
  });

  it('enforces the category scope on ALERTS, not just on which plugins ran', () => {
    // The resolver only picks plugins; a multi-category plugin (Glendale PD
    // dispatches fire and medical calls too) still returns whatever it found.
    // Without filtering the alerts, "any fires nearby?" came back with a
    // thunderstorm watch in it.
    const weather = alert('weather', 'severe', 1);
    const fire = alert('fire', 'high', 2);
    const medical = alert('medical', 'high', 3);
    const crime = alert('crime', 'extreme', 4);

    const out = agg.aggregate([[weather, fire, medical, crime]], {
      limit: 50,
      categories: ['fire', 'medical'],
      intent: 'focused',
      now: NOW,
    });

    expect(out.map((a) => a.category).sort()).toEqual(['fire', 'medical']);
  });
});
