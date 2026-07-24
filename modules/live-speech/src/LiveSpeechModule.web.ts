import { registerWebModule, NativeModule } from 'expo';

class LiveSpeechModule extends NativeModule<{}> {
  start(): void {
    throw new Error('实时语音识别仅支持 Android 开发客户端。');
  }

  stop(): void {}
}

export default registerWebModule(LiveSpeechModule, 'LiveSpeech');
