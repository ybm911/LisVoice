import { describe, expect, it } from '@jest/globals';
import { initialConfig, isNewerVersion, normalizeConnectionConfig } from './appConfig';

describe('appConfig', () => {
  it('normalizes malformed persisted config values', () => {
    const normalized = normalizeConnectionConfig({
      apiKey: '  sk-demo  ',
      endpoint: '  wss://example.com  ',
      model: '  qwen  ',
      haptics: true,
      themeMode: 'blue' as never,
      transcriptFontSize: 99,
      transcriptFontWeight: '900' as never,
      minSoundDb: -5,
    });

    expect(normalized).toMatchObject({
      apiKey: '  sk-demo  ',
      endpoint: 'wss://example.com',
      model: 'qwen',
      themeMode: 'system',
      transcriptFontWeight: '700',
      transcriptFontSize: 48,
      minSoundDb: -20,
      fullscreenListening: true,
    });
  });

  it('compares versions correctly', () => {
    expect(isNewerVersion('1.0.1', '1.0.0')).toBe(true);
    expect(isNewerVersion('1.0.0', '1.0.1')).toBe(false);
    expect(isNewerVersion('v1.2.0', '1.1.9')).toBe(true);
  });

  it('keeps the default config shape intact', () => {
    expect(initialConfig).toMatchObject({
      themeMode: 'system',
      haptics: true,
      transcriptFontWeight: '700',
      minSoundDb: -52,
      fullscreenListening: true,
    });
  });
});
