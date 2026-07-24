import * as SecureStore from 'expo-secure-store';
import * as SystemUI from 'expo-system-ui';
import Constants from 'expo-constants';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  BackHandler,
  Linking,
  PermissionsAndroid,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  useColorScheme,
  Vibration,
  View,
} from 'react-native';
import LiveSpeech, {
  type AudioLevelEvent,
  type SpeechStateEvent,
  type TranscriptEvent,
} from './modules/live-speech/src/LiveSpeechModule';

const SETTINGS_KEY = 'ting-sheng.connection.v1';
const DEFAULT_ENDPOINT = 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime';
const DEFAULT_MODEL = 'qwen3-asr-flash-realtime';
const GITHUB_RELEASES_URL = 'https://api.github.com/repos/ybm911/LisVoice/releases/latest';
const CURRENT_VERSION = Constants.expoConfig?.version ?? '1.0.0';

type GitHubRelease = {
  tag_name: string;
  html_url: string;
  body?: string;
  assets: Array<{
    name: string;
    browser_download_url: string;
  }>;
};

type ThemeMode = 'system' | 'light' | 'dark';
type TranscriptWeight = '500' | '700' | '800';

function versionParts(version: string) {
  return version.replace(/^v/i, '').split('.').map((part) => Number.parseInt(part, 10) || 0);
}

function isNewerVersion(latest: string, current: string) {
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

type ConnectionConfig = {
  apiKey: string;
  endpoint: string;
  model: string;
  haptics: boolean;
  themeMode: ThemeMode;
  transcriptFontSize: number;
  transcriptFontWeight: TranscriptWeight;
  minSoundDb: number;
};

type Palette = {
  background: string;
  surface: string;
  surfaceMuted: string;
  text: string;
  textMuted: string;
  border: string;
  primary: string;
  primarySoft: string;
  danger: string;
  input: string;
  shadow: string;
};

const initialConfig: ConnectionConfig = {
  apiKey: '',
  endpoint: DEFAULT_ENDPOINT,
  model: DEFAULT_MODEL,
  haptics: true,
  themeMode: 'system',
  transcriptFontSize: 34,
  transcriptFontWeight: '700',
  minSoundDb: -52,
};

const lightPalette: Palette = {
  background: '#F1F5F8',
  surface: '#FFFFFF',
  surfaceMuted: '#E8EEF3',
  text: '#102A43',
  textMuted: '#5C7083',
  border: '#CAD5DF',
  primary: '#08745E',
  primarySoft: '#DDF2EC',
  danger: '#A64032',
  input: '#F7F9FB',
  shadow: 'rgba(16, 42, 67, 0.08)',
};

const darkPalette: Palette = {
  background: '#0D1419',
  surface: '#172129',
  surfaceMuted: '#22303A',
  text: '#F3F7FA',
  textMuted: '#AAB9C5',
  border: '#344650',
  primary: '#55C9A8',
  primarySoft: '#183A32',
  danger: '#D9695B',
  input: '#111B22',
  shadow: 'rgba(0, 0, 0, 0.28)',
};

function addedSuffix(previous: string, next: string) {
  let index = 0;
  const limit = Math.min(previous.length, next.length);
  while (index < limit && previous[index] === next[index]) index += 1;
  return next.slice(index);
}

function vibrateCharacters(text: string) {
  const characterCount = Array.from(text.trim()).length;
  if (!characterCount) return;

  const pattern = [0];
  for (let index = 0; index < Math.min(characterCount, 36); index += 1) {
    pattern.push(18, 48);
  }
  Vibration.vibrate(pattern, false);
}

type Choice<T extends string | number> = { label: string; value: T; hint?: string };

function ChoiceGroup<T extends string | number>({
  choices,
  value,
  onChange,
  palette,
}: {
  choices: Choice<T>[];
  value: T;
  onChange: (value: T) => void;
  palette: Palette;
}) {
  return (
    <View style={choiceStyles.row}>
      {choices.map((choice) => {
        const selected = choice.value === value;
        return (
          <Pressable
            accessibilityRole="radio"
            accessibilityState={{ checked: selected }}
            key={String(choice.value)}
            onPress={() => onChange(choice.value)}
            style={[
              choiceStyles.button,
              { backgroundColor: selected ? palette.primarySoft : palette.input, borderColor: selected ? palette.primary : palette.border },
            ]}
          >
            <Text style={[choiceStyles.label, { color: selected ? palette.primary : palette.text }]}>{choice.label}</Text>
            {choice.hint ? <Text style={[choiceStyles.hint, { color: palette.textMuted }]}>{choice.hint}</Text> : null}
          </Pressable>
        );
      })}
    </View>
  );
}

export default function App() {
  const systemColorScheme = useColorScheme();
  const [config, setConfig] = useState<ConnectionConfig>(initialConfig);
  const [draft, setDraft] = useState<ConnectionConfig>(initialConfig);
  const [isReady, setIsReady] = useState(false);
  const [showSettings, setShowSettings] = useState(true);
  const [speechState, setSpeechState] = useState<SpeechStateEvent['state']>('idle');
  const [statusMessage, setStatusMessage] = useState('请先填写百炼 API Key');
  const [confirmedText, setConfirmedText] = useState('');
  const [partialText, setPartialText] = useState('');
  const [audioLevel, setAudioLevel] = useState(0);
  const [audioDb, setAudioDb] = useState(-70);
  const [isAboveThreshold, setIsAboveThreshold] = useState(false);
  const [isCheckingUpdate, setIsCheckingUpdate] = useState(false);

  const partialRef = useRef('');
  const configRef = useRef(config);
  const listeningRef = useRef(false);
  const transcriptScrollRef = useRef<ScrollView>(null);

  const displayedConfig = showSettings ? draft : config;
  const isDark = displayedConfig.themeMode === 'dark'
    || (displayedConfig.themeMode === 'system' && systemColorScheme === 'dark');
  const palette = isDark ? darkPalette : lightPalette;
  const styles = useMemo(() => createStyles(palette), [palette]);

  useEffect(() => {
    SystemUI.setBackgroundColorAsync(palette.background).catch(() => undefined);
  }, [palette.background]);

  useEffect(() => {
    configRef.current = config;
  }, [config]);

  useEffect(() => {
    SecureStore.getItemAsync(SETTINGS_KEY)
      .then((value) => {
        if (value) {
          const stored = { ...initialConfig, ...JSON.parse(value) } as ConnectionConfig;
          setConfig(stored);
          setDraft(stored);
          setShowSettings(!stored.apiKey);
          setStatusMessage(stored.apiKey ? '准备就绪' : '请先填写百炼 API Key');
        }
      })
      .catch(() => setStatusMessage('无法读取本机设置，请重新填写'))
      .finally(() => setIsReady(true));
  }, []);

  const closeSettings = useCallback(() => {
    setDraft(config);
    setShowSettings(false);
  }, [config]);

  useEffect(() => {
    if (!showSettings) return undefined;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      closeSettings();
      return true;
    });
    return () => subscription.remove();
  }, [closeSettings, showSettings]);

  const handleTranscript = useCallback((event: TranscriptEvent) => {
    const oldPartial = partialRef.current;
    const newSound = addedSuffix(oldPartial, event.text);
    if (configRef.current.haptics) vibrateCharacters(newSound);

    if (event.isFinal) {
      partialRef.current = '';
      setPartialText('');
      setConfirmedText((current) => {
        const separator = current && !current.endsWith('\n') ? '\n' : '';
        return `${current}${separator}${event.text}`.slice(-5_000);
      });
    } else {
      partialRef.current = event.text;
      setPartialText(event.text);
    }
  }, []);

  useEffect(() => {
    const transcriptSubscription = LiveSpeech.addListener('onTranscript', handleTranscript);
    const stateSubscription = LiveSpeech.addListener('onState', (event: SpeechStateEvent) => {
      setSpeechState(event.state);
      listeningRef.current = event.state === 'listening' || event.state === 'connecting';
      const messages = {
        idle: '已暂停，可随时继续聆听',
        connecting: '正在连接实时识别服务…',
        listening: '正在聆听并实时显示文字',
        error: event.message || '识别服务暂时不可用',
      };
      setStatusMessage(messages[event.state]);
    });
    const levelSubscription = LiveSpeech.addListener('onAudioLevel', (event: AudioLevelEvent) => {
      setAudioLevel(event.level);
      setAudioDb(event.db);
      setIsAboveThreshold(event.isAboveThreshold);
    });

    return () => {
      transcriptSubscription.remove();
      stateSubscription.remove();
      levelSubscription.remove();
      LiveSpeech.stop();
    };
  }, [handleTranscript]);

  const saveSettings = async () => {
    const normalized = {
      ...draft,
      apiKey: draft.apiKey.trim(),
      endpoint: draft.endpoint.trim(),
      model: draft.model.trim(),
    };
    if (!normalized.apiKey || !normalized.endpoint || !normalized.model) {
      Alert.alert('还差一点', '请填写 API Key、服务端点和模型名称。');
      return;
    }
    await SecureStore.setItemAsync(SETTINGS_KEY, JSON.stringify(normalized));
    setConfig(normalized);
    setDraft(normalized);
    setShowSettings(false);
    setStatusMessage('准备就绪');
  };

  const openSettings = () => {
    if (listeningRef.current) LiveSpeech.stop();
    setDraft(config);
    setShowSettings(true);
  };

  const checkForUpdates = async () => {
    if (isCheckingUpdate) return;
    setIsCheckingUpdate(true);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12_000);
    try {
      const response = await fetch(GITHUB_RELEASES_URL, {
        headers: {
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        signal: controller.signal,
      });
      if (response.status === 404) {
        Alert.alert('暂时没有发布版本', 'GitHub Releases 中还没有可下载的 APK。');
        return;
      }
      if (!response.ok) throw new Error(`GitHub 返回 HTTP ${response.status}`);

      const release = await response.json() as GitHubRelease;
      const apk = release.assets.find((asset) => asset.name.toLowerCase().endsWith('.apk'));
      const latestVersion = release.tag_name.replace(/^v/i, '');
      if (!isNewerVersion(latestVersion, CURRENT_VERSION)) {
        Alert.alert('已经是最新版本', `当前版本：${CURRENT_VERSION}\n最新版本：${latestVersion}`);
        return;
      }

      Alert.alert(
        '发现新版本',
        `当前版本：${CURRENT_VERSION}\n最新版本：${latestVersion}\n\n是否前往下载？`,
        [
          { text: '稍后', style: 'cancel' },
          {
            text: '下载更新',
            onPress: () => Linking.openURL(apk?.browser_download_url ?? release.html_url),
          },
        ],
      );
    } catch (error) {
      const message = error instanceof Error && error.name === 'AbortError'
        ? '连接 GitHub 超时，请稍后重试。'
        : error instanceof Error ? error.message : '无法连接 GitHub。';
      Alert.alert('检查更新失败', message);
    } finally {
      clearTimeout(timeout);
      setIsCheckingUpdate(false);
    }
  };

  const startListening = async () => {
    if (!config.apiKey) {
      openSettings();
      return;
    }
    const permission = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO, {
      title: '允许“听声”使用麦克风',
      message: '听声需要用麦克风把身边说话内容实时显示成文字。',
      buttonPositive: '允许',
      buttonNegative: '暂不允许',
    });
    if (permission !== PermissionsAndroid.RESULTS.GRANTED) {
      setSpeechState('error');
      setStatusMessage('需要麦克风权限才能开始聆听');
      return;
    }

    setConfirmedText('');
    setPartialText('');
    partialRef.current = '';
    try {
      LiveSpeech.start(config.apiKey, config.endpoint, config.model, config.minSoundDb);
    } catch (error) {
      setSpeechState('error');
      setStatusMessage(error instanceof Error ? error.message : '无法启动实时识别');
    }
  };

  if (!isReady) {
    return (
      <View style={styles.loading}>
        <StatusBar style={isDark ? 'light' : 'dark'} />
        <Text style={styles.loadingText}>正在准备听声…</Text>
      </View>
    );
  }

  const isListening = speechState === 'listening' || speechState === 'connecting';
  const statusColor = speechState === 'error' ? palette.danger : isListening ? palette.primary : palette.textMuted;
  const meterColor = audioLevel > 0.72 ? '#E05243' : isAboveThreshold ? '#25A86B' : palette.border;
  const thresholdPosition = `${Math.max(0, Math.min(100, ((config.minSoundDb + 70) / 70) * 100))}%` as `${number}%`;
  const transcript = confirmedText || partialText;

  return (
    <View style={styles.screen}>
      <StatusBar style={isDark ? 'light' : 'dark'} />
      {showSettings ? (
        <ScrollView
          contentContainerStyle={styles.settingsContent}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.settingsHeader}>
            <Pressable accessibilityLabel="返回主界面" accessibilityRole="button" onPress={closeSettings} style={styles.backButton}>
              <Text style={styles.backButtonText}>‹ 返回</Text>
            </Pressable>
            <Text style={styles.settingsTitle}>设置</Text>
            <View style={styles.headerSpacer} />
          </View>

          <View style={styles.settingsCard}>
            <Text style={styles.sectionTitle}>显示</Text>
            <Text style={styles.label}>亮暗主题</Text>
            <ChoiceGroup
              choices={[
                { label: '跟随系统', value: 'system' },
                { label: '浅色', value: 'light' },
                { label: '深色', value: 'dark' },
              ]}
              onChange={(themeMode) => setDraft((current) => ({ ...current, themeMode }))}
              palette={palette}
              value={draft.themeMode}
            />

            <Text style={styles.label}>字幕大小</Text>
            <ChoiceGroup
              choices={[
                { label: '标准', value: 28, hint: '28' },
                { label: '大', value: 34, hint: '34' },
                { label: '特大', value: 40, hint: '40' },
              ]}
              onChange={(transcriptFontSize) => setDraft((current) => ({ ...current, transcriptFontSize }))}
              palette={palette}
              value={draft.transcriptFontSize}
            />

            <Text style={styles.label}>字幕粗细</Text>
            <ChoiceGroup
              choices={[
                { label: '常规', value: '500' },
                { label: '加粗', value: '700' },
                { label: '特粗', value: '800' },
              ]}
              onChange={(transcriptFontWeight) => setDraft((current) => ({ ...current, transcriptFontWeight }))}
              palette={palette}
              value={draft.transcriptFontWeight}
            />

            <View style={styles.previewBox}>
              <Text style={styles.previewCaption}>字幕预览</Text>
              <Text style={[styles.previewText, { fontSize: draft.transcriptFontSize, fontWeight: draft.transcriptFontWeight }]}>您好，今天感觉怎么样？</Text>
            </View>
          </View>

          <View style={styles.settingsCard}>
            <Text style={styles.sectionTitle}>声音识别</Text>
            <Text style={styles.helpText}>提高过滤强度可以减少安静环境中的误识别，但太高可能听不到轻声说话。</Text>
            <ChoiceGroup
              choices={[
                { label: '轻声优先', value: -60, hint: '最灵敏' },
                { label: '标准', value: -52, hint: '推荐' },
                { label: '环境降噪', value: -44, hint: '较安静' },
                { label: '强过滤', value: -36, hint: '嘈杂环境' },
              ]}
              onChange={(minSoundDb) => setDraft((current) => ({ ...current, minSoundDb }))}
              palette={palette}
              value={draft.minSoundDb}
            />

            <View style={styles.switchRow}>
              <View style={styles.switchCopy}>
                <Text style={styles.switchTitle}>逐字震动提示</Text>
                <Text style={styles.switchHint}>每出现一个新字，轻轻震动一次</Text>
              </View>
              <Switch
                accessibilityLabel="逐字震动提示"
                onValueChange={(haptics) => setDraft((current) => ({ ...current, haptics }))}
                trackColor={{ false: palette.border, true: palette.primary }}
                value={draft.haptics}
              />
            </View>
          </View>

          <View style={styles.settingsCard}>
            <Text style={styles.sectionTitle}>连接百炼</Text>
            <Text style={styles.helpText}>密钥只保存在这台手机的安全存储中。</Text>

            <Text style={styles.label}>百炼 API Key</Text>
            <TextInput
              accessibilityLabel="百炼 API Key"
              autoCapitalize="none"
              autoCorrect={false}
              onChangeText={(apiKey) => setDraft((current) => ({ ...current, apiKey }))}
              placeholder="粘贴 sk- 开头的密钥"
              placeholderTextColor={palette.textMuted}
              secureTextEntry
              style={styles.input}
              value={draft.apiKey}
            />

            <Text style={styles.label}>服务端点</Text>
            <TextInput
              accessibilityLabel="服务端点"
              autoCapitalize="none"
              autoCorrect={false}
              onChangeText={(endpoint) => setDraft((current) => ({ ...current, endpoint }))}
              placeholder={DEFAULT_ENDPOINT}
              placeholderTextColor={palette.textMuted}
              style={styles.input}
              value={draft.endpoint}
            />

            <Text style={styles.label}>实时识别模型</Text>
            <TextInput
              accessibilityLabel="实时识别模型"
              autoCapitalize="none"
              autoCorrect={false}
              onChangeText={(model) => setDraft((current) => ({ ...current, model }))}
              style={styles.input}
              value={draft.model}
            />
          </View>

          <View style={styles.settingsCard}>
            <Text style={styles.sectionTitle}>软件更新</Text>
            <View style={styles.versionRow}>
              <View style={styles.switchCopy}>
                <Text style={styles.switchTitle}>当前版本</Text>
                <Text style={styles.versionText}>v{CURRENT_VERSION}</Text>
              </View>
              <Pressable
                accessibilityLabel="检查软件更新"
                accessibilityRole="button"
                disabled={isCheckingUpdate}
                onPress={checkForUpdates}
                style={({ pressed }) => [
                  styles.secondaryButton,
                  (pressed || isCheckingUpdate) && styles.secondaryButtonPressed,
                ]}
              >
                <Text style={styles.secondaryButtonText}>
                  {isCheckingUpdate ? '正在检查…' : '检查更新'}
                </Text>
              </Pressable>
            </View>
            <Text style={styles.helpText}>从 GitHub Releases 获取最新的 ARM 版 APK。</Text>
          </View>

          <Pressable accessibilityRole="button" onPress={saveSettings} style={styles.primaryButton}>
            <Text style={styles.primaryButtonText}>保存设置</Text>
          </Pressable>
        </ScrollView>
      ) : (
        <View style={styles.mainContent}>
          <View style={styles.header}>
            <View style={styles.headerCopy}>
              <Text style={styles.appName}>听声</Text>
              <Text style={styles.tagline}>把身边的声音，变成看得见的话</Text>
            </View>
            <Pressable accessibilityLabel="打开设置" accessibilityRole="button" onPress={openSettings} style={styles.settingsButton}>
              <Text style={styles.settingsButtonText}>设置</Text>
            </Pressable>
          </View>

          <View style={styles.statusCard}>
            <View style={[styles.statusDot, { backgroundColor: statusColor }]} />
            <Text selectable style={[styles.statusText, { color: statusColor }]}>{statusMessage}</Text>
          </View>

          <View style={styles.meterCard}>
            <View style={styles.meterHeader}>
              <Text style={styles.meterLabel}>环境音量</Text>
              <Text style={styles.meterValue}>{isListening ? `${Math.round(audioDb)} dB` : '未聆听'}</Text>
            </View>
            <View style={styles.meterTrack}>
              <View style={[styles.meterFill, { backgroundColor: meterColor, width: `${Math.max(2, audioLevel * 100)}%` as `${number}%` }]} />
              <View style={[styles.thresholdMarker, { left: thresholdPosition }]} />
            </View>
            <View style={styles.meterLegend}>
              <Text style={styles.meterHint}>安静</Text>
              <Text style={styles.meterHint}>红色表示声音较大</Text>
            </View>
          </View>

          <View style={styles.transcriptCard}>
            <ScrollView
              contentContainerStyle={[styles.transcriptScrollContent, !transcript && styles.transcriptEmptyContent]}
              onContentSizeChange={() => transcriptScrollRef.current?.scrollToEnd({ animated: true })}
              ref={transcriptScrollRef}
              showsVerticalScrollIndicator={false}
            >
              {transcript ? (
                <Text
                  selectable
                  style={[
                    styles.transcriptText,
                    {
                      fontSize: config.transcriptFontSize,
                      fontWeight: config.transcriptFontWeight,
                      lineHeight: Math.round(config.transcriptFontSize * 1.5),
                    },
                  ]}
                >
                  {confirmedText}{confirmedText && partialText ? '\n' : ''}
                  <Text style={styles.partialText}>{partialText}</Text>
                </Text>
              ) : (
                <View style={styles.emptyTranscript}>
                  <Text style={styles.emptyTitle}>{isListening ? '请开始说话' : '准备好后，按下开始聆听'}</Text>
                  <Text style={styles.emptyBody}>{isListening ? '识别到的话会在这里自动滚动显示。' : '请靠近说话的人，效果会更好。'}</Text>
                </View>
              )}
            </ScrollView>
          </View>

          <Pressable
            accessibilityLabel={isListening ? '暂停聆听' : '开始聆听'}
            accessibilityRole="button"
            onPress={isListening ? () => LiveSpeech.stop() : startListening}
            style={[styles.listenButton, isListening && styles.stopButton]}
          >
            <Text style={styles.listenButtonText}>{isListening ? '暂停聆听' : '开始聆听'}</Text>
          </Pressable>

          <Text style={styles.footerNote}>实时识别需要网络连接，请勿在危险场景中只依赖本应用。</Text>
        </View>
      )}
    </View>
  );
}

const choiceStyles = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  button: { borderCurve: 'continuous', borderRadius: 14, borderWidth: 1.5, flexGrow: 1, minHeight: 54, minWidth: '29%', paddingHorizontal: 12, paddingVertical: 9, justifyContent: 'center' },
  label: { fontSize: 16, fontWeight: '800', textAlign: 'center' },
  hint: { fontSize: 12, fontWeight: '600', marginTop: 2, textAlign: 'center' },
});

function createStyles(palette: Palette) {
  return StyleSheet.create({
    screen: { backgroundColor: palette.background, flex: 1 },
    loading: { alignItems: 'center', backgroundColor: palette.background, flex: 1, justifyContent: 'center' },
    loadingText: { color: palette.text, fontSize: 20, fontWeight: '700' },
    mainContent: { flex: 1, gap: 12, paddingBottom: 22, paddingHorizontal: 18, paddingTop: 48 },
    header: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
    headerCopy: { flex: 1, paddingRight: 12 },
    appName: { color: palette.text, fontSize: 36, fontWeight: '800', letterSpacing: 1 },
    tagline: { color: palette.textMuted, fontSize: 15, fontWeight: '600', marginTop: 1 },
    settingsButton: { alignItems: 'center', backgroundColor: palette.surfaceMuted, borderCurve: 'continuous', borderRadius: 16, justifyContent: 'center', minHeight: 48, minWidth: 62, paddingHorizontal: 12 },
    settingsButtonText: { color: palette.text, fontSize: 16, fontWeight: '800' },
    statusCard: { alignItems: 'center', backgroundColor: palette.surface, borderCurve: 'continuous', borderRadius: 15, boxShadow: `0 2px 8px ${palette.shadow}`, flexDirection: 'row', gap: 9, minHeight: 50, paddingHorizontal: 15 },
    statusDot: { borderRadius: 7, height: 12, width: 12 },
    statusText: { flex: 1, fontSize: 16, fontWeight: '700' },
    meterCard: { backgroundColor: palette.surface, borderCurve: 'continuous', borderRadius: 15, gap: 7, paddingHorizontal: 15, paddingVertical: 11 },
    meterHeader: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
    meterLabel: { color: palette.text, fontSize: 14, fontWeight: '800' },
    meterValue: { color: palette.textMuted, fontSize: 13, fontVariant: ['tabular-nums'], fontWeight: '700' },
    meterTrack: { backgroundColor: palette.surfaceMuted, borderRadius: 6, height: 10, overflow: 'hidden', position: 'relative' },
    meterFill: { borderRadius: 6, height: '100%' },
    thresholdMarker: { backgroundColor: palette.text, height: 14, opacity: 0.75, position: 'absolute', top: -2, width: 2 },
    meterLegend: { flexDirection: 'row', justifyContent: 'space-between' },
    meterHint: { color: palette.textMuted, fontSize: 11, fontWeight: '600' },
    transcriptCard: { backgroundColor: palette.surface, borderCurve: 'continuous', borderRadius: 22, boxShadow: `0 3px 12px ${palette.shadow}`, flex: 1, minHeight: 250, overflow: 'hidden' },
    transcriptScrollContent: { padding: 20 },
    transcriptEmptyContent: { flexGrow: 1 },
    transcriptText: { color: palette.text, letterSpacing: 0.3 },
    partialText: { color: palette.primary },
    emptyTranscript: { alignItems: 'center', flex: 1, justifyContent: 'center', paddingHorizontal: 16 },
    emptyTitle: { color: palette.text, fontSize: 23, fontWeight: '800', textAlign: 'center' },
    emptyBody: { color: palette.textMuted, fontSize: 16, lineHeight: 24, marginTop: 10, textAlign: 'center' },
    listenButton: { alignItems: 'center', backgroundColor: palette.primary, borderCurve: 'continuous', borderRadius: 21, justifyContent: 'center', marginTop: 8, minHeight: 72 },
    stopButton: { backgroundColor: palette.danger },
    listenButtonText: { color: '#FFFFFF', fontSize: 25, fontWeight: '800' },
    footerNote: { color: palette.textMuted, fontSize: 12, lineHeight: 17, paddingHorizontal: 8, textAlign: 'center' },
    settingsContent: { gap: 16, paddingBottom: 40, paddingHorizontal: 18, paddingTop: 48 },
    settingsHeader: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
    backButton: { justifyContent: 'center', minHeight: 46, minWidth: 78 },
    backButtonText: { color: palette.primary, fontSize: 18, fontWeight: '800' },
    settingsTitle: { color: palette.text, fontSize: 24, fontWeight: '800' },
    headerSpacer: { width: 78 },
    settingsCard: { backgroundColor: palette.surface, borderCurve: 'continuous', borderRadius: 22, boxShadow: `0 2px 10px ${palette.shadow}`, gap: 12, padding: 18 },
    sectionTitle: { color: palette.text, fontSize: 25, fontWeight: '800' },
    helpText: { color: palette.textMuted, fontSize: 14, lineHeight: 21 },
    label: { color: palette.text, fontSize: 16, fontWeight: '800', marginTop: 3 },
    input: { backgroundColor: palette.input, borderColor: palette.border, borderCurve: 'continuous', borderRadius: 13, borderWidth: 1, color: palette.text, fontSize: 16, minHeight: 52, paddingHorizontal: 14 },
    previewBox: { backgroundColor: palette.input, borderCurve: 'continuous', borderRadius: 15, gap: 7, marginTop: 2, padding: 15 },
    previewCaption: { color: palette.textMuted, fontSize: 12, fontWeight: '700' },
    previewText: { color: palette.text, lineHeight: 54 },
    switchRow: { alignItems: 'center', backgroundColor: palette.input, borderCurve: 'continuous', borderRadius: 15, flexDirection: 'row', justifyContent: 'space-between', padding: 14 },
    switchCopy: { flex: 1, paddingRight: 10 },
    switchTitle: { color: palette.text, fontSize: 16, fontWeight: '800' },
    switchHint: { color: palette.textMuted, fontSize: 13, lineHeight: 19, marginTop: 2 },
    versionRow: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
    versionText: { color: palette.textMuted, fontSize: 15, fontWeight: '700', marginTop: 3 },
    secondaryButton: { alignItems: 'center', backgroundColor: palette.surfaceMuted, borderColor: palette.border, borderCurve: 'continuous', borderRadius: 14, borderWidth: 1, justifyContent: 'center', minHeight: 48, minWidth: 116, paddingHorizontal: 14 },
    secondaryButtonPressed: { opacity: 0.6 },
    secondaryButtonText: { color: palette.primary, fontSize: 16, fontWeight: '800' },
    primaryButton: { alignItems: 'center', backgroundColor: palette.primary, borderCurve: 'continuous', borderRadius: 17, justifyContent: 'center', minHeight: 62 },
    primaryButtonText: { color: '#FFFFFF', fontSize: 20, fontWeight: '800' },
  });
}
