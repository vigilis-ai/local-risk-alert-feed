import { describe, it, expect } from 'vitest';
import {
  parseCallCode,
  classifyCallType,
  isLowPriorityCallType,
  utcInstantOf,
} from './glendale-police.plugin';

const RISK_ORDER = ['low', 'moderate', 'high', 'severe', 'extreme'];
const rank = (r: string) => RISK_ORDER.indexOf(r);

describe('parseCallCode', () => {
  it('splits the GPD code from the description', () => {
    expect(parseCallCode('901G-SHOOTING')).toEqual({ code: '901G', text: 'SHOOTING' });
    expect(parseCallCode('417S-SHOTS FIRED')).toEqual({ code: '417S', text: 'SHOTS FIRED' });
    expect(parseCallCode('487VX-ATTEMPTED STOLEN VEHICLE')).toEqual({
      code: '487VX',
      text: 'ATTEMPTED STOLEN VEHICLE',
    });
  });

  it('handles the 10-xx family whose code embeds a dash', () => {
    expect(parseCallCode('10-70 PUBLIC RELATIONS CONTACT')).toEqual({
      code: '10-70',
      text: 'PUBLIC RELATIONS CONTACT',
    });
    expect(parseCallCode('10-51 FELONY WARRANT OUTSTANDING').code).toBe('10-51');
  });

  it('handles the alphabetic self-initiated codes and stray separators', () => {
    expect(parseCallCode('C6 - TRAFFIC STOP')).toEqual({ code: 'C6', text: 'TRAFFIC STOP' });
    expect(parseCallCode('C6M- CODE 6 FOR SELF INITIATED BY MOT').code).toBe('C6M');
    expect(parseCallCode('C6I (TRAFFIC STOP COMMERCIAL VEHICLE ').code).toBe('C6I');
    expect(parseCallCode('FC-FIELD CONTACT')).toEqual({ code: 'FC', text: 'FIELD CONTACT' });
    expect(parseCallCode('415- SUBJECT DISTURBING')).toEqual({ code: '415', text: 'SUBJECT DISTURBING' });
    expect(parseCallCode('1091 - STRANDED MOTORIST')).toEqual({ code: '1091', text: 'STRANDED MOTORIST' });
  });

  it('yields no code for uncoded values', () => {
    expect(parseCallCode('CAT TEAM CONTACT')).toEqual({ code: '', text: 'CAT TEAM CONTACT' });
    expect(parseCallCode(undefined)).toEqual({ code: '', text: '' });
  });
});

describe('classifyCallType', () => {
  it('scores gunfire calls as extreme (the old table never matched these)', () => {
    expect(classifyCallType('901G-SHOOTING', 1).risk).toBe('extreme');
    expect(classifyCallType('417S-SHOTS FIRED', 2).risk).toBe('extreme');
    expect(classifyCallType('417G-SUBJECT WITH A GUN', 1).risk).toBe('extreme');
    expect(classifyCallType('417X-SHOT SPOTTER', 2).risk).toBe('extreme');
    expect(classifyCallType('998-OFFICER INVOLVED SHOOTING', 1).risk).toBe('extreme');
    expect(classifyCallType('901C-CUTTING OR STABBING', 1).risk).toBe('extreme');
  });

  it('no longer ranks a burglary alarm above shots fired', () => {
    const alarm = classifyCallType('459A-BURGLARY ALARM SILENT/AUDIBLE', 2);
    const shots = classifyCallType('417S-SHOTS FIRED', 2);
    expect(rank(alarm.risk)).toBeLessThan(rank(shots.risk));
    expect(alarm.risk).toBe('low');
  });

  it('keeps a real armed-robbery alarm well above a burglary alarm', () => {
    expect(rank(classifyCallType('211A-ARMED ROBBERY ALARM', 1).risk)).toBeGreaterThan(
      rank(classifyCallType('459A-BURGLARY ALARM SILENT/AUDIBLE', 2).risk),
    );
  });

  it('routes fire and medical calls out of the crime category', () => {
    expect(classifyCallType('904-FIRE', 2)).toEqual({ category: 'fire', risk: 'high' });
    expect(classifyCallType('901H-DEAD BODY', 2)).toEqual({ category: 'medical', risk: 'severe' });
    expect(classifyCallType('901O-OVERDOSE', 2).category).toBe('medical');
  });

  it('scores domestic violence as severe', () => {
    expect(classifyCallType('415F-DOMESTIC VIOLENCE/FAMILY FIGHT', 2).risk).toBe('severe');
  });

  it('scores routine property and traffic calls below violent ones', () => {
    expect(classifyCallType('487-THEFT', 2).risk).toBe('moderate');
    expect(classifyCallType('487B-SHOPLIFTING', 2).risk).toBe('low');
    expect(classifyCallType('961-ACCIDENT- NO INJURIES', 2).category).toBe('traffic');
    expect(rank(classifyCallType('487-THEFT', 2).risk)).toBeLessThan(
      rank(classifyCallType('240-ASSAULT', 2).risk),
    );
  });

  it('never reports an unmapped Priority 1 call as low risk', () => {
    // GPD dispatches P1 as life-threatening; a new code must not slip through as noise.
    expect(classifyCallType('999Z-BRAND NEW UNMAPPED CODE', 1).risk).toBe('severe');
    expect(classifyCallType('888-SOMETHING UNKNOWN', 1).risk).toBe('severe');
  });

  it('does not upgrade a mapped extreme call when priority is absent', () => {
    expect(classifyCallType('901G-SHOOTING', undefined).risk).toBe('extreme');
  });

  it('falls back to text when the code is unknown', () => {
    expect(classifyCallType('777-AGGRAVATED ASSAULT', 2).risk).toBe('severe');
    expect(classifyCallType('776-VEHICLE BURGLARY', 2).risk).toBe('high');
    // "alarm" must win over "burglary" in the fallback too.
    expect(classifyCallType('775-BURGLARY ALARM', 2).risk).toBe('low');
  });
});

describe('isLowPriorityCallType', () => {
  it('treats self-initiated and clerical codes as low priority', () => {
    expect(isLowPriorityCallType('C6 - TRAFFIC STOP')).toBe(true);
    expect(isLowPriorityCallType('FC-FIELD CONTACT')).toBe(true);
    expect(isLowPriorityCallType('10-70 PUBLIC RELATIONS CONTACT')).toBe(true);
    expect(isLowPriorityCallType('586-ILLEGAL PARKING')).toBe(true);
    expect(isLowPriorityCallType('CAT TEAM CONTACT')).toBe(true);
  });

  it('never filters out violent calls', () => {
    expect(isLowPriorityCallType('901G-SHOOTING')).toBe(false);
    expect(isLowPriorityCallType('417S-SHOTS FIRED')).toBe(false);
    expect(isLowPriorityCallType('211A-ARMED ROBBERY ALARM')).toBe(false);
  });
});

describe('utcInstantOf', () => {
  it('prefers DateTime_Plus7, the true UTC instant', () => {
    // The July 4 shooting: 20:58 Phoenix local == 03:58Z the next day.
    const instant = utcInstantOf({ IncidentDate: 1783198692000, DateTime_Plus7: 1783223892000 });
    expect(new Date(instant).toISOString()).toBe('2026-07-05T03:58:12.000Z');
  });

  it('falls back to the fixed Arizona offset when the field is missing', () => {
    const instant = utcInstantOf({ IncidentDate: 1783198692000 });
    expect(new Date(instant).toISOString()).toBe('2026-07-05T03:58:12.000Z');
  });
});
