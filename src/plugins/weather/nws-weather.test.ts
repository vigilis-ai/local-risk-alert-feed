import { describe, it, expect } from 'vitest';
import { classifyNwsEvent } from './nws-weather.plugin';

describe('classifyNwsEvent', () => {
  it('routes fire-weather events to the fire category', () => {
    expect(classifyNwsEvent('Red Flag Warning')).toBe('fire');
    expect(classifyNwsEvent('Fire Weather Watch')).toBe('fire');
  });

  it('routes civil emergencies to civil-unrest', () => {
    expect(classifyNwsEvent('Civil Emergency Message')).toBe('civil-unrest');
    expect(classifyNwsEvent('Law Enforcement Warning')).toBe('civil-unrest');
    expect(classifyNwsEvent('Evacuation Immediate')).toBe('civil-unrest');
  });

  it('routes non-weather hazards to other', () => {
    expect(classifyNwsEvent('Hazardous Materials Warning')).toBe('other');
    expect(classifyNwsEvent('911 Telephone Outage Emergency')).toBe('other');
    expect(classifyNwsEvent('Radiological Hazard Warning')).toBe('other');
    expect(classifyNwsEvent('Child Abduction Emergency')).toBe('other');
  });

  it('keeps actual weather events as weather', () => {
    expect(classifyNwsEvent('Tornado Warning')).toBe('weather');
    expect(classifyNwsEvent('Winter Storm Warning')).toBe('weather');
    expect(classifyNwsEvent('Flood Watch')).toBe('weather');
    expect(classifyNwsEvent('Air Quality Alert')).toBe('weather');
  });
});
