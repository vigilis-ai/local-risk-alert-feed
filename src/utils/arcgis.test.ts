import { describe, it, expect } from 'vitest';
import { ArcGisQueryError, fetchArcGisFeatures, envelopeForRadius, toArcGisTimestamp } from './arcgis';

/** Builds a fake ArcGIS layer of `total` features that honours offset/count. */
function makeLayer(total: number, opts: { flag?: boolean } = {}) {
  const { flag = true } = opts;
  const calls: Array<{ offset: number; count: number }> = [];

  const fetchJson = async <T>(url: string): Promise<T> => {
    const params = new URL(url).searchParams;
    const offset = Number(params.get('resultOffset'));
    const count = Number(params.get('resultRecordCount'));
    calls.push({ offset, count });

    const features = Array.from(
      { length: Math.max(0, Math.min(count, total - offset)) },
      (_, i) => ({ id: offset + i }),
    );
    const exceeded = offset + features.length < total;
    return (flag
      ? { features, properties: { exceededTransferLimit: exceeded } }
      : { features }) as T;
  };

  return { fetchJson, calls };
}

const baseParams = () => new URLSearchParams({ where: '1=1', orderByFields: 'D DESC' });

describe('fetchArcGisFeatures', () => {
  it('pages past the first request to collect the whole result set', async () => {
    const { fetchJson, calls } = makeLayer(2148);

    const result = await fetchArcGisFeatures<{ id: number }>({
      baseUrl: 'https://example.test/query',
      params: baseParams(),
      pageSize: 1000,
      maxRecords: 5000,
      fetchJson,
    });

    expect(result.features).toHaveLength(2148);
    expect(result.truncated).toBe(false);
    expect(result.pagesFetched).toBe(3);
    expect(calls.map((c) => c.offset)).toEqual([0, 1000, 2000]);
    // The oldest record survives — this is the July 4 shooting case.
    expect(result.features.at(-1)).toEqual({ id: 2147 });
  });

  it('reports truncation when maxRecords stops the walk early', async () => {
    const { fetchJson } = makeLayer(5000);

    const result = await fetchArcGisFeatures<{ id: number }>({
      baseUrl: 'https://example.test/query',
      params: baseParams(),
      pageSize: 500,
      maxRecords: 1000,
      fetchJson,
    });

    expect(result.features).toHaveLength(1000);
    expect(result.truncated).toBe(true);
  });

  it('does not report truncation when the cap lands exactly on the last record', async () => {
    const { fetchJson } = makeLayer(1000);

    const result = await fetchArcGisFeatures<{ id: number }>({
      baseUrl: 'https://example.test/query',
      params: baseParams(),
      pageSize: 500,
      maxRecords: 1000,
      fetchJson,
    });

    expect(result.features).toHaveLength(1000);
    expect(result.truncated).toBe(false);
  });

  it('never requests more than maxRecords in total', async () => {
    const { fetchJson, calls } = makeLayer(10_000);

    await fetchArcGisFeatures({
      baseUrl: 'https://example.test/query',
      params: baseParams(),
      pageSize: 400,
      maxRecords: 900,
      fetchJson,
    });

    expect(calls.map((c) => c.count)).toEqual([400, 400, 100]);
  });

  it('falls back to a short-page check when the layer omits exceededTransferLimit', async () => {
    const { fetchJson } = makeLayer(1500, { flag: false });

    const result = await fetchArcGisFeatures({
      baseUrl: 'https://example.test/query',
      params: baseParams(),
      pageSize: 1000,
      maxRecords: 5000,
      fetchJson,
    });

    expect(result.features).toHaveLength(1500);
    expect(result.truncated).toBe(false);
  });

  it('bounds an unterminating layer with maxPages', async () => {
    // Always claims more remains but returns nothing — must not spin forever.
    const fetchJson = async <T>(): Promise<T> =>
      ({ features: [], properties: { exceededTransferLimit: true } }) as T;

    const result = await fetchArcGisFeatures({
      baseUrl: 'https://example.test/query',
      params: baseParams(),
      pageSize: 100,
      maxRecords: 5000,
      maxPages: 3,
      fetchJson,
    });

    expect(result.pagesFetched).toBe(3);
    expect(result.truncated).toBe(true);
  });
});

describe('envelopeForRadius', () => {
  const parse = (s: string) => s.split(',').map(Number);

  it('circumscribes the requested radius rather than a fixed city-wide box', () => {
    const [xmin, ymin, xmax, ymax] = parse(envelopeForRadius(33.534, -112.234, 5000));

    // ~0.0449 deg lat for 5km, plus the 1% margin.
    expect(ymax - 33.534).toBeGreaterThan(0.044);
    expect(ymax - 33.534).toBeLessThan(0.047);
    // Longitude degrees are shorter at this latitude, so the lon delta is larger.
    expect(xmax - -112.234).toBeGreaterThan(ymax - 33.534);
    expect(-112.234 - xmin).toBeCloseTo(xmax - -112.234, 6);
    expect(33.534 - ymin).toBeCloseTo(ymax - 33.534, 6);
  });

  it('grows with the radius', () => {
    const small = parse(envelopeForRadius(33.534, -112.234, 2000));
    const large = parse(envelopeForRadius(33.534, -112.234, 20_000));
    expect(large[3] - large[1]).toBeGreaterThan(small[3] - small[1]);
  });

  it('contains the Tanger Outlets shooting for a 10km query', () => {
    const [xmin, ymin, xmax, ymax] = parse(envelopeForRadius(33.534, -112.234, 10_000));
    const lat = 33.5338672537129;
    const lon = -112.262177450292;
    expect(lon).toBeGreaterThan(xmin);
    expect(lon).toBeLessThan(xmax);
    expect(lat).toBeGreaterThan(ymin);
    expect(lat).toBeLessThan(ymax);
  });

  it('degrades safely near the poles instead of dividing by ~0', () => {
    const [xmin, , xmax] = parse(envelopeForRadius(90, 0, 5000));
    expect(Number.isFinite(xmin)).toBe(true);
    expect(xmax).toBeLessThanOrEqual(180);
  });
});

describe('toArcGisTimestamp', () => {
  it('emits a second-precision literal body, not a date-truncated one', () => {
    expect(toArcGisTimestamp(new Date('2026-07-05T03:58:12.000Z'))).toBe('2026-07-05 03:58:12');
  });

  it('keeps the time component so today is not excluded', () => {
    expect(toArcGisTimestamp(new Date('2026-07-09T20:00:00.000Z'))).toBe('2026-07-09 20:00:00');
  });
});

describe('fetchArcGisFeatures — upstream failures', () => {
  const base = { baseUrl: 'https://x/query', params: new URLSearchParams({ orderByFields: 'd DESC' }), pageSize: 1000, maxRecords: 5000 };

  it('throws on an ArcGIS error body served with HTTP 200', async () => {
    // A bad query returns { error: {...} } and no `features` key, with a 200 status.
    const fetchJson = async <T,>(): Promise<T> =>
      ({ error: { code: 400, message: '', details: ["'Invalid field: BOGUS' parameter is invalid"] } }) as T;

    await expect(fetchArcGisFeatures({ ...base, fetchJson })).rejects.toThrow(ArcGisQueryError);
    // Previously this resolved to { features: [], truncated: false } — an upstream
    // outage was reported to the caller as "no incidents near this site".
    await expect(fetchArcGisFeatures({ ...base, fetchJson })).rejects.toThrow(/Invalid field: BOGUS/);
  });

  it('throws when a page omits the features array entirely', async () => {
    const fetchJson = async <T,>(): Promise<T> => ({}) as T;
    await expect(fetchArcGisFeatures({ ...base, fetchJson })).rejects.toThrow(/no `features` array/);
  });

  it('still resolves normally for a genuinely empty result set', async () => {
    const fetchJson = async <T,>(): Promise<T> => ({ features: [] }) as T;
    const out = await fetchArcGisFeatures({ ...base, fetchJson });
    expect(out).toMatchObject({ features: [], truncated: false, pagesFetched: 1 });
  });
});
