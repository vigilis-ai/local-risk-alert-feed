import { describe, it, expect } from 'vitest';
import { createDefaultPlugins } from './defaults';
import { TRANSCOMPlugin } from './transcom';

describe('createDefaultPlugins', () => {
  it('builds the default list without throwing when no keys are present', () => {
    const prev = {
      tm: process.env.TICKETMASTER_API_KEY,
      air: process.env.AIRNOW_API_KEY,
      ga: process.env.GEORGIA_511_API_KEY,
      tc: process.env.TRANSCOM_FEED_URL,
    };
    delete process.env.TICKETMASTER_API_KEY;
    delete process.env.AIRNOW_API_KEY;
    delete process.env.GEORGIA_511_API_KEY;
    delete process.env.TRANSCOM_FEED_URL;

    const regs = createDefaultPlugins();
    expect(regs.length).toBeGreaterThan(15);
    // every entry is a registration with a plugin
    expect(regs.every((r) => !!r.plugin)).toBe(true);

    if (prev.tm) process.env.TICKETMASTER_API_KEY = prev.tm;
    if (prev.air) process.env.AIRNOW_API_KEY = prev.air;
    if (prev.ga) process.env.GEORGIA_511_API_KEY = prev.ga;
    if (prev.tc) process.env.TRANSCOM_FEED_URL = prev.tc;
  });

  it('always includes TRANSCOM, disabled until a feed URL is provided', () => {
    const regs = createDefaultPlugins();
    const transcom = regs.map((r) => r.plugin).find((p) => p.metadata.id === 'transcom') as
      | TRANSCOMPlugin
      | undefined;
    expect(transcom).toBeDefined();
    expect(transcom!.configured).toBe(false);
  });

  it('enables TRANSCOM when a feed URL is supplied', () => {
    const regs = createDefaultPlugins({ transcomFeedUrl: 'https://example.org/transcom' });
    const transcom = regs.map((r) => r.plugin).find((p) => p.metadata.id === 'transcom') as TRANSCOMPlugin;
    expect(transcom.configured).toBe(true);
  });

  it('omits key-required plugins when their key is absent and includes them when present', () => {
    const without = createDefaultPlugins({ georgia511ApiKey: undefined });
    expect(without.some((r) => r.plugin.metadata.id === 'atlanta-traffic')).toBe(false);

    const withKey = createDefaultPlugins({ georgia511ApiKey: 'test-key' });
    expect(withKey.some((r) => r.plugin.metadata.id === 'atlanta-traffic')).toBe(true);
  });
});
