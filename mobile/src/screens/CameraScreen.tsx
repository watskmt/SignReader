/**
 * CameraScreen — Pi Monitor + スマホカメラ録画の両モードを持つ画面。
 *
 * - Pi Monitor: バックエンドを 3 秒ごとにポーリングし、Pi からの抽出結果を表示
 * - Record: スマホカメラで撮影 → 3 秒ごとにフレームを OCR へ送信
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  AppState,
  type AppStateStatus,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Camera, type CameraDevice } from 'react-native-vision-camera';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RouteProp } from '@react-navigation/native';
import { useIsFocused } from '@react-navigation/native';

import type { RootStackParamList } from '../App';
import {
  listSessions,
  getExtractions,
  createSession,
  processOCRAsync,
  type ExtractionResponse,
} from '../services/api';
import { useAppContext } from '../context/AppContext';
import cameraService from '../services/camera';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'Camera'>;
  route: RouteProp<RootStackParamList, 'Camera'>;
};

const POLL_INTERVAL_MS = 3000;
const CAPTURE_INTERVAL_MS = 3000;

export default function CameraScreen({ navigation }: Props): React.JSX.Element {
  const isFocused = useIsFocused();
  const cameraRef = useRef<Camera>(null);

  // ── Pi Monitor state ────────────────────────────────────────────────────────
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const activeSessionIdRef = useRef<string | null>(null);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [activeSessionTitle, setActiveSessionTitle] = useState<string>('');
  const [extractions, setExtractions] = useState<ExtractionResponse[]>([]);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<
    'connecting' | 'live' | 'idle' | 'error'
  >('connecting');

  // ── Record state ────────────────────────────────────────────────────────────
  const [isRecording, setIsRecording] = useState(false);
  const [cameraDevice, setCameraDevice] = useState<CameraDevice | undefined>(undefined);
  const [recordSessionId, setRecordSessionId] = useState<string | null>(null);
  const [recordSessionTitle, setRecordSessionTitle] = useState<string>('');
  const [recordError, setRecordError] = useState<string | null>(null);
  const captureIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const { addExtraction } = useAppContext();

  // ── Pi Monitor: fetch helpers ───────────────────────────────────────────────
  const fetchLatestSession = useCallback(async () => {
    try {
      const sessions = await listSessions(10);
      const active =
        sessions.find((s) => s.status === 'active') ?? sessions[0] ?? null;
      if (!active) {
        setConnectionStatus('idle');
        setActiveSessionId(null);
        activeSessionIdRef.current = null;
        return;
      }
      if (active.id !== activeSessionIdRef.current) {
        activeSessionIdRef.current = active.id;
        setActiveSessionId(active.id);
        setActiveSessionTitle(active.title);
        setExtractions([]);
      }
    } catch {
      setConnectionStatus('error');
    }
  }, []);

  const fetchExtractions = useCallback(
    async (sessionId: string) => {
      try {
        const fetched = await getExtractions(sessionId);
        setExtractions(fetched.filter((e) => !e.is_duplicate));
        setLastUpdated(new Date());
        setConnectionStatus('live');
        fetched.forEach((ext) =>
          addExtraction({
            id: ext.id,
            session_id: ext.session_id,
            content: ext.content,
            confidence: ext.confidence,
            bounding_box: ext.bounding_box,
            latitude: ext.latitude,
            longitude: ext.longitude,
            altitude: ext.altitude,
            timestamp: ext.timestamp,
            engine: ext.engine,
            is_duplicate: ext.is_duplicate,
          }),
        );
      } catch {
        setConnectionStatus('error');
      }
    },
    [addExtraction],
  );

  const poll = useCallback(async () => {
    await fetchLatestSession();
    const sessionId = activeSessionIdRef.current;
    if (sessionId) {
      await fetchExtractions(sessionId);
    }
  }, [fetchLatestSession, fetchExtractions]);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const startPolling = useCallback(() => {
    stopPolling();
    poll();
    pollRef.current = setInterval(poll, POLL_INTERVAL_MS);
  }, [poll, stopPolling]);

  useEffect(() => {
    if (!isFocused) {
      stopPolling();
      return;
    }
    startPolling();
    return stopPolling;
  }, [isFocused, startPolling, stopPolling]);

  useEffect(() => {
    const subscription = AppState.addEventListener(
      'change',
      (nextState: AppStateStatus) => {
        if (!isFocused) return;
        if (nextState === 'active') {
          startPolling();
        } else {
          stopPolling();
        }
      },
    );
    return () => subscription.remove();
  }, [isFocused, startPolling, stopPolling]);

  // ── Record: start / stop ────────────────────────────────────────────────────
  const handleStartRecord = useCallback(async () => {
    setRecordError(null);
    try {
      // ① パーミッション
      const permStatus = Camera.getCameraPermissionStatus();
      if (permStatus !== 'granted') {
        const result = await Camera.requestCameraPermission();
        if (result !== 'granted') {
          setRecordError(`権限なし (status=${permStatus})`);
          return;
        }
      }

      // ② デバイス取得
      const allDevices = Camera.getAvailableCameraDevices();
      const backCamera = allDevices.find((d) => d.position === 'back');
      if (!backCamera) {
        setRecordError(`カメラ未検出 (台数=${allDevices.length})`);
        return;
      }
      setCameraDevice(backCamera);

      // ③ セッション作成
      const title = `録画 ${new Date().toLocaleTimeString('ja-JP')}`;
      const session = await createSession({ title });
      setRecordSessionId(session.id);
      setRecordSessionTitle(title);
      setIsRecording(true);

      // ④ フレームキャプチャ開始
      captureIntervalRef.current = cameraService.startFrameCapture(
        cameraRef,
        CAPTURE_INTERVAL_MS,
        async (frame) => {
          let lat: number | undefined;
          let lon: number | undefined;
          try {
            const loc = await cameraService.getCurrentLocation();
            lat = loc.latitude;
            lon = loc.longitude;
          } catch {
            // GPS 取得失敗は無視
          }
          try {
            await processOCRAsync(frame, session.id, lat, lon);
          } catch {
            // OCR 送信失敗は無視して次のフレームへ
          }
        },
      );
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setRecordError(`エラー: ${msg}`);
      setCameraDevice(undefined);
    }
  }, []);

  const handleStopRecord = useCallback(() => {
    if (captureIntervalRef.current) {
      cameraService.stopFrameCapture(captureIntervalRef.current);
      captureIntervalRef.current = null;
    }
    setIsRecording(false);
    if (recordSessionId) {
      navigation.navigate('Results', {
        sessionId: recordSessionId,
        sessionTitle: recordSessionTitle,
      });
    }
    setRecordSessionId(null);
  }, [recordSessionId, recordSessionTitle, navigation]);

  // ── Pi Monitor: status UI ───────────────────────────────────────────────────
  const statusColor = {
    connecting: '#ff9800',
    live: '#4caf50',
    idle: '#888',
    error: '#e53935',
  }[connectionStatus];

  const statusLabel = {
    connecting: '接続中...',
    live: 'Pi からライブ受信中',
    idle: 'Pi からのセッションを待機中',
    error: '接続エラー',
  }[connectionStatus];

  return (
    <View style={styles.container}>
      {/* カメラプレビュー (録画中のみ) */}
      {isRecording && cameraDevice && (
        <Camera
          ref={cameraRef}
          style={styles.cameraPreview}
          device={cameraDevice}
          isActive={isFocused && isRecording}
          photo
        />
      )}

      {/* Pi Monitor ヘッダー */}
      <View style={styles.header}>
        <View style={styles.statusRow}>
          <View style={[styles.dot, { backgroundColor: statusColor }]} />
          <Text style={[styles.statusText, { color: statusColor }]}>
            {statusLabel}
          </Text>
        </View>
        {activeSessionTitle ? (
          <Text style={styles.sessionLabel} numberOfLines={1}>
            {activeSessionTitle}
          </Text>
        ) : null}
        {lastUpdated ? (
          <Text style={styles.updatedText}>
            最終更新: {lastUpdated.toLocaleTimeString('ja-JP')}
          </Text>
        ) : null}
      </View>

      {/* 抽出結果リスト */}
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
      >
        {connectionStatus === 'connecting' && extractions.length === 0 ? (
          <ActivityIndicator color="#4caf50" style={styles.loader} />
        ) : extractions.length === 0 ? (
          <View style={styles.emptyContainer}>
            <Text style={styles.emptyIcon}>📡</Text>
            <Text style={styles.emptyTitle}>
              {connectionStatus === 'idle'
                ? 'Pi の起動を待っています'
                : 'テキストを検出中...'}
            </Text>
            <Text style={styles.emptySubtitle}>
              Raspberry Pi Zero W のキャプチャクライアントが起動すると{'\n'}
              ここにリアルタイムで結果が表示されます
            </Text>
          </View>
        ) : (
          [...extractions]
            .sort(
              (a, b) =>
                new Date(b.timestamp).getTime() -
                new Date(a.timestamp).getTime(),
            )
            .map((ext) => (
              <View key={ext.id} style={styles.card}>
                <Text style={styles.cardText}>{ext.content}</Text>
                <View style={styles.cardMeta}>
                  <Text style={styles.confidence}>
                    {Math.round(ext.confidence * 100)}%
                  </Text>
                  <Text style={styles.timestamp}>
                    {new Date(ext.timestamp).toLocaleTimeString('ja-JP')}
                  </Text>
                </View>
              </View>
            ))
        )}
      </ScrollView>

      {/* Record エラー表示 */}
      {recordError ? (
        <View style={styles.errorBanner}>
          <Text style={styles.errorText}>{recordError}</Text>
        </View>
      ) : null}

      {/* フッター */}
      <View style={styles.footer}>
        {/* Record / Stop ボタン */}
        <TouchableOpacity
          style={[styles.recordButton, isRecording && styles.recordButtonActive]}
          onPress={isRecording ? handleStopRecord : handleStartRecord}
        >
          <View
            style={[styles.recordDot, isRecording && styles.recordDotStop]}
          />
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.sessionsButton}
          onPress={() => navigation.navigate('SessionList')}
        >
          <Text style={styles.sessionsButtonText}>セッション一覧</Text>
        </TouchableOpacity>

        {activeSessionId ? (
          <TouchableOpacity
            style={styles.resultsButton}
            onPress={() =>
              navigation.navigate('Results', {
                sessionId: activeSessionId,
                sessionTitle: activeSessionTitle,
              })
            }
          >
            <Text style={styles.resultsButtonText}>詳細</Text>
          </TouchableOpacity>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0f0f1a' },
  cameraPreview: { width: '100%', height: 220 },
  header: {
    backgroundColor: '#1a1a2e',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.08)',
  },
  statusRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 4 },
  dot: { width: 8, height: 8, borderRadius: 4, marginRight: 8 },
  statusText: { fontSize: 13, fontWeight: '600' },
  sessionLabel: {
    color: '#fff',
    fontSize: 15,
    fontWeight: 'bold',
    marginBottom: 2,
  },
  updatedText: { color: '#555', fontSize: 11 },
  scroll: { flex: 1 },
  scrollContent: { padding: 16, paddingBottom: 100 },
  loader: { marginTop: 60 },
  emptyContainer: {
    alignItems: 'center',
    marginTop: 60,
    paddingHorizontal: 32,
  },
  emptyIcon: { fontSize: 48, marginBottom: 16 },
  emptyTitle: {
    color: '#fff',
    fontSize: 18,
    fontWeight: 'bold',
    marginBottom: 10,
    textAlign: 'center',
  },
  emptySubtitle: {
    color: '#555',
    fontSize: 13,
    textAlign: 'center',
    lineHeight: 20,
  },
  card: {
    backgroundColor: '#1a1a2e',
    borderRadius: 10,
    padding: 14,
    marginBottom: 10,
  },
  cardText: { color: '#fff', fontSize: 15, marginBottom: 8, lineHeight: 22 },
  cardMeta: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  confidence: { color: '#4caf50', fontSize: 12, fontWeight: '600' },
  timestamp: { color: '#555', fontSize: 11 },
  footer: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    padding: 16,
    paddingBottom: Platform.OS === 'ios' ? 32 : 16,
    backgroundColor: '#0f0f1a',
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.08)',
  },
  recordButton: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: '#e53935',
    justifyContent: 'center',
    alignItems: 'center',
  },
  recordButtonActive: {
    backgroundColor: '#b71c1c',
  },
  recordDot: {
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: '#fff',
  },
  recordDotStop: {
    borderRadius: 3,
  },
  sessionsButton: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 10,
    backgroundColor: '#1a1a2e',
    alignItems: 'center',
  },
  sessionsButtonText: { color: '#fff', fontSize: 15, fontWeight: '600' },
  resultsButton: {
    paddingVertical: 14,
    paddingHorizontal: 18,
    borderRadius: 10,
    backgroundColor: '#e53935',
    alignItems: 'center',
  },
  resultsButtonText: { color: '#fff', fontSize: 15, fontWeight: '600' },
  errorBanner: {
    backgroundColor: 'rgba(229,57,53,0.15)',
    borderTopWidth: 1,
    borderTopColor: '#e53935',
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  errorText: { color: '#e53935', fontSize: 12 },
});
