import { NativeModule, requireNativeModule } from 'expo';

export type TranscriptEvent = {
  text: string;
  isFinal: boolean;
};

export type SpeechStateEvent = {
  state: 'idle' | 'connecting' | 'listening' | 'error';
  message?: string;
};

export type AudioLevelEvent = {
  level: number;
  db: number;
  isAboveThreshold: boolean;
};

declare class LiveSpeechModule extends NativeModule<{
  onTranscript: (event: TranscriptEvent) => void;
  onState: (event: SpeechStateEvent) => void;
  onAudioLevel: (event: AudioLevelEvent) => void;
}> {
  start(apiKey: string, endpoint: string, model: string, minSoundDb: number): void;
  stop(): void;
}

export default requireNativeModule<LiveSpeechModule>('LiveSpeech');
