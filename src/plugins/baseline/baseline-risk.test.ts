import { describe, it, expect } from 'vitest';
import { scoreCells, percentileToRisk } from './baseline-risk-plugin';

const severityOf = (c: string) =>
  c === 'ASSAULT' ? 'violent' : c === 'THEFT' ? 'property' : 'other';

describe('scoreCells', () => {
  it('classifies categories and weights violent crime higher', () => {
    const [cell] = scoreCells(
      [{ cellId: 'A', byCategory: { ASSAULT: 2, THEFT: 5, DRUG: 1 } }],
      { severityOf, universeSize: 1 }
    );
    expect(cell.violent).toBe(2);
    expect(cell.property).toBe(5);
    expect(cell.other).toBe(1);
    expect(cell.total).toBe(8);
    expect(cell.metric).toBe(2 * 3 + 5 + 1 * 0.5); // 11.5
  });

  it('ranks percentiles across the full universe (incl. zero-incident cells)', () => {
    // 2 cells with crime, universe of 100 -> the busier cell sits near the top.
    const scored = scoreCells(
      [
        { cellId: 'low', byCategory: { THEFT: 1 } }, // metric 1
        { cellId: 'high', byCategory: { ASSAULT: 50 } }, // metric 150
      ],
      { severityOf, universeSize: 100 }
    );
    const high = scored.find((c) => c.cellId === 'high')!;
    const low = scored.find((c) => c.cellId === 'low')!;
    // 'high' is above all 98 zero cells and the 'low' cell -> ~99th pct
    expect(high.percentile).toBeGreaterThanOrEqual(98);
    // 'low' is above the 98 zero cells but below 'high' -> ~98th pct
    expect(low.percentile).toBeGreaterThanOrEqual(97);
    expect(high.percentile).toBeGreaterThan(low.percentile);
  });
});

describe('percentileToRisk', () => {
  it('maps percentile to a relative tier', () => {
    expect(percentileToRisk(99)).toBe('extreme');
    expect(percentileToRisk(92)).toBe('severe');
    expect(percentileToRisk(80)).toBe('high');
    expect(percentileToRisk(60)).toBe('moderate');
    expect(percentileToRisk(20)).toBe('low');
  });
});
