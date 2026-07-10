import { describe, it, expect } from 'vitest';
import {
  classifyIncident,
  parseGenLocInfo,
  decodeUnits,
} from './phoenix-regional-active-incidents.plugin';

const RISK_ORDER = ['low', 'moderate', 'high', 'severe', 'extreme'];
const rank = (r: string) => RISK_ORDER.indexOf(r);

describe('parseGenLocInfo', () => {
  it('separates the address from the trailing city code', () => {
    // The reason this plugin exists: GLN is Glendale.
    expect(parseGenLocInfo('N 67TH AV/W BEARDSLEY RD ,GLN')).toEqual({
      address: 'N 67TH AV/W BEARDSLEY RD',
      city: 'Glendale',
      cityCode: 'GLN',
    });
    expect(parseGenLocInfo('N 48TH AV/W GLENROSA AV ,PHX').city).toBe('Phoenix');
    expect(parseGenLocInfo('I10 @ A143 EB TO NB ,TMP').city).toBe('Tempe');
  });

  it('passes an unrecognized code through rather than guessing', () => {
    expect(parseGenLocInfo('SOME RD ,XYZ')).toEqual({
      address: 'SOME RD',
      city: 'XYZ',
      cityCode: 'XYZ',
    });
  });

  it('handles a location with no city suffix', () => {
    expect(parseGenLocInfo('5200 N 43RD AV')).toEqual({ address: '5200 N 43RD AV' });
    expect(parseGenLocInfo(undefined)).toEqual({ address: '' });
  });
});

describe('decodeUnits', () => {
  it('decodes the non-breaking-space entities the feed embeds', () => {
    expect(decodeUnits('E15:&#160;Responding')).toBe('E15: Responding');
    expect(decodeUnits('E23:&#160;On&#160;Scene M272:&#160;Leaving&#160;For&#160;Hospital')).toBe(
      'E23: On Scene M272: Leaving For Hospital',
    );
  });

  it('decodes the non-breaking hyphen in unit names (real value: M&#8209;1501)', () => {
    expect(decodeUnits('E156:&#160;On&#160;Scene M&#8209;1501:&#160;Responding')).toBe(
      'E156: On Scene M-1501: Responding',
    );
  });

  it('decodes hex and named entities too', () => {
    expect(decodeUnits('E1&#x3A;&nbsp;Responding')).toBe('E1: Responding');
    expect(decodeUnits('A&amp;B')).toBe('A&B');
  });

  it('leaves an unknown named entity intact rather than mangling it', () => {
    expect(decodeUnits('E1 &bogus; X')).toBe('E1 &bogus; X');
  });

  it('is safe on empty input', () => {
    expect(decodeUnits(undefined)).toBe('');
    expect(decodeUnits('')).toBe('');
  });
});

describe('classifyIncident', () => {
  it('maps the numeric traffic natures the Valley dispatch shares with the police feeds', () => {
    expect(classifyIncident('961', '961', 'sc004-crash')).toEqual({ category: 'traffic', risk: 'moderate' });
    expect(classifyIncident('962', '962', 'sc004-crash')).toEqual({ category: 'traffic', risk: 'high' });
    expect(classifyIncident('963', '963', 'sc004-crash')).toEqual({ category: 'traffic', risk: 'severe' });
  });

  it('grades fires by what is burning', () => {
    expect(classifyIncident('STRUCT', 'STRUCTURE FIRE', 'sc006-fire').risk).toBe('extreme');
    expect(classifyIncident('ALLEY', 'ALLEY FIRE', 'sc006-fire')).toEqual({ category: 'fire', risk: 'moderate' });
    expect(classifyIncident('VEH', 'VEHICLE FIRE', 'sc006-fire').risk).toBe('high');
    expect(rank(classifyIncident('STRUCT', 'STRUCTURE FIRE', 'sc006-fire').risk)).toBeGreaterThan(
      rank(classifyIncident('ALLEY', 'ALLEY FIRE', 'sc006-fire').risk),
    );
  });

  it('treats explosions and collapses as extreme fire-service calls', () => {
    expect(classifyIncident('EXPL', 'EXPLOSION', 'sc006-fire')).toEqual({ category: 'fire', risk: 'extreme' });
    expect(classifyIncident('COLL', 'BUILDING COLLAPSE', '')).toEqual({ category: 'fire', risk: 'extreme' });
  });

  it('routes patient emergencies to medical at severe risk', () => {
    expect(classifyIncident('CARD', 'CARDIAC ARREST', '')).toEqual({ category: 'medical', risk: 'severe' });
    expect(classifyIncident('SHOT', 'SHOOTING VICTIM', '')).toEqual({ category: 'medical', risk: 'severe' });
    expect(classifyIncident('DROWN', 'DROWNING', '')).toEqual({ category: 'medical', risk: 'severe' });
  });

  it('treats hazmat and gas leaks as severe fire calls', () => {
    expect(classifyIncident('HAZ', 'HAZMAT SPILL', '')).toEqual({ category: 'fire', risk: 'severe' });
    expect(classifyIncident('GAS', 'GAS LEAK', '')).toEqual({ category: 'fire', risk: 'severe' });
  });

  it('falls back to the dashboard symbol when the nature text is uninformative', () => {
    expect(classifyIncident('X', 'X', 'sc006-fire').category).toBe('fire');
    expect(classifyIncident('X', 'X', 'sc004-crash').category).toBe('traffic');
  });

  it('never returns low for an unknown incident — units are actively committed', () => {
    const unknown = classifyIncident('SNAKE', 'SERVICE CALL', '');
    expect(unknown.risk).toBe('moderate');
    expect(rank(unknown.risk)).toBeGreaterThan(rank('low'));

    const blank = classifyIncident(undefined, undefined, undefined);
    expect(blank).toEqual({ category: 'other', risk: 'moderate' });
  });
});
