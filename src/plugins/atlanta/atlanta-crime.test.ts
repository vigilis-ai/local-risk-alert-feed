import { describe, it, expect } from 'vitest';
import { resolveAtlantaTimestamps } from './atlanta-crime.plugin';

const JUL_2 = Date.parse('2026-07-02T20:17:00Z');
const JUL_4 = Date.parse('2026-07-04T17:07:00Z');
const JUN_30 = Date.parse('2026-06-30T21:30:00Z');

describe('resolveAtlantaTimestamps', () => {
  it('anchors on when the crime occurred, not when it was reported', () => {
    const t = resolveAtlantaTimestamps({
      OccurredFromDate: JUL_2,
      OccurredToDate: JUL_2,
      ReportDate: JUN_30,
    });

    expect(t.occurredFrom).toBe(JUL_2);
    expect(t.reportedAt).toBe(JUN_30);
  });

  it('flags the ~4% of records APD reports before they occurred', () => {
    // Real row: occurred 2026-07-02T20:17, reported 2026-06-30T21:30.
    const inverted = resolveAtlantaTimestamps({ OccurredFromDate: JUL_2, ReportDate: JUN_30 });
    expect(inverted.reportedBeforeOccurrence).toBe(true);

    const normal = resolveAtlantaTimestamps({ OccurredFromDate: JUN_30, ReportDate: JUL_2 });
    expect(normal.reportedBeforeOccurrence).toBe(false);
  });

  it('keeps the alert inside a window that filters on OccurredFromDate', () => {
    // The window the plugin queries with.
    const start = Date.parse('2026-07-02T19:27:50Z');
    const end = Date.parse('2026-07-09T19:27:50Z');

    const t = resolveAtlantaTimestamps({ OccurredFromDate: JUL_4, ReportDate: JUN_30 });

    // `issued` is occurredFrom, so it can no longer fall outside the query window.
    expect(t.occurredFrom).toBeGreaterThanOrEqual(start);
    expect(t.occurredFrom).toBeLessThanOrEqual(end);
  });

  it('clamps an occurrence window that ends before it starts', () => {
    const t = resolveAtlantaTimestamps({ OccurredFromDate: JUL_4, OccurredToDate: JUL_2 });
    expect(t.occurredTo).toBe(JUL_4);
    expect(t.occurredTo).toBeGreaterThanOrEqual(t.occurredFrom);
  });

  it('preserves a genuine multi-day occurrence window', () => {
    const t = resolveAtlantaTimestamps({ OccurredFromDate: JUL_2, OccurredToDate: JUL_4 });
    expect(t.occurredFrom).toBe(JUL_2);
    expect(t.occurredTo).toBe(JUL_4);
  });

  it('falls back to the report date when occurrence is missing', () => {
    const t = resolveAtlantaTimestamps({ ReportDate: JUN_30 });
    expect(t.occurredFrom).toBe(JUN_30);
    expect(t.occurredTo).toBe(JUN_30);
    expect(t.reportedBeforeOccurrence).toBe(false);
  });

  it('falls back to now when the record carries no dates at all', () => {
    const now = Date.parse('2026-07-10T00:00:00Z');
    const t = resolveAtlantaTimestamps({}, now);
    expect(t.occurredFrom).toBe(now);
    expect(t.reportedAt).toBeUndefined();
  });
});
