export const SETTINGS_KEY = 'ting-sheng.connection.v1';
export const DEFAULT_ENDPOINT = 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime';
export const DEFAULT_MODEL = 'qwen3-asr-flash-realtime';
export const DEFAULT_APP_VERSION = '1.0.1';

export type ThemeMode = 'system' | 'light' | 'dark';
export type TranscriptWeight = '500' | '700' | '800';

export type ConnectionConfig = {
  apiKey: string;
  endpoint: string;
  model: string;
  haptics: boolean;
  themeMode: ThemeMode;
  transcriptFontSize: number;
  transcriptFontWeight: TranscriptWeight;
  minSoundDb: number;
};

export const initialConfig: ConnectionConfig = {
  apiKey: '',
  endpoint: DEFAULT_ENDPOINT,
  model: DEFAULT_MODEL,
  haptics: true,
  themeMode: 'system',
  transcriptFontSize: 34,
  transcriptFontWeight: '700',
  minSoundDb: -52,
};

export function versionParts(version: string) {
  return version.replace(/^v/i, '').split('.').map((part) => Number.parseInt(part, 10) || 0);
}

export function isNewerVersion(latest: string, current: string) {
  const latestParts = versionParts(latest);
  const currentParts = versionParts(current);
  const length = Math.max(latestParts.length, currentParts.length);
  for (let index = 0; index < length; index += 1) {
    const latestPart = latestParts[index] ?? 0;
    const currentPart = currentParts[index] ?? 0;
    if (latestPart !== currentPart) return latestPart > currentPart;
  }
  return false;
}

export function normalizeConnectionConfig(input: Partial<ConnectionConfig> | null | undefined): ConnectionConfig {
  const source = input ?? {};
  const themeMode = source.themeMode === 'light' || source.themeMode === 'dark' ? source.themeMode : 'system';
  const transcriptFontWeight = source.transcriptFontWeight === '500' || source.transcriptFontWeight === '800'
    ? source.transcriptFontWeight
    : '700';
  const transcriptFontSize = typeof source.transcriptFontSize === 'number' && Number.isFinite(source.transcriptFontSize)
    ? source.transcriptFontSize
    : initialConfig.transcriptFontSize;
  const minSoundDb = typeof source.minSoundDb === 'number' && Number.isFinite(source.minSoundDb)
    ? source.minSoundDb
    : initialConfig.minSoundDb;

  return {
    apiKey: typeof source.apiKey === 'string' ? source.apiKey : '',
    endpoint: typeof source.endpoint === 'string' && source.endpoint.trim() ? source.endpoint.trim() : initialConfig.endpoint,
    model: typeof source.model === 'string' && source.model.trim() ? source.model.trim() : initialConfig.model,
    haptics: typeof source.haptics === 'boolean' ? source.haptics : initialConfig.haptics,
    themeMode,
    transcriptFontSize: Math.max(24, Math.min(48, Math.round(transcriptFontSize))),
    transcriptFontWeight,
    minSoundDb: Math.max(-70, Math.min(-20, Math.round(minSoundDb))),
  };
}
