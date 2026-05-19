/**
 * PiMonitorScreen — live view of extractions coming from the Raspberry Pi webcam.
 *
 * Polls the backend every 3 seconds for the most recent active session and its
 * extractions. No camera or recording logic — capture is handled by the Pi.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  type AppStateStatus,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RouteProp } from '@react-navigation/native';
import { useIsFocused } from '@react-navigation/native';

import type { RootStackParamList } from '../App';
import { listSessions, getExtractions, type ExtractionResponse } from '../services/api';
import { useAppContext } from '../context/AppContext';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'Camera'>;
  route: RouteProp<RootStackParamList, 'Camera'>;
};

const POLL_INTERVAL_MS = 3000;

export default function PiMonitorScreen({ navigation }: Props): React.JSX.Element {
  const isFocused = useIsFocused();
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // ref で常に最新の sessionId を保持し、poll の stale closure を防ぐ
  const activeSessionIdRef = useRef<string | null>(null);

  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [activeSessionTitle, setActiveSessionTitle] = useState<string>('');
  const [extractions, setExtractions] = useState<ExtractionResponse[]>([]);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<'connecting' | 'live' | 'idle' | 'error'>('connecting');

  const { addExtraction } = useAppContext();

  const fetchLatestSession = useCallback(async () => {
    try {
      const sessions = await listSessions(10);
      const active = sessions.find((s) => s.status === 'active') ?? sessions[0] ?? null;
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

  const fetchExtractions = useCallback(async (sessionId: string) => {
    try {
      const fetched = await getExtractions(sessionId);
      setExtractions(fetched.filter((e) => !e.is_duplicate));
      setLastUpdated(new Date());
      setConnectionStatus('live');
      fetched.forEach((ext) => addExtraction({
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
      }));
    } catch {
      setConnectionStatus('error');
    }
  }, [addExtraction]);

  // ref 経由で sessionId を読むので activeSessionId を deps に含めない
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

  // ナビゲーションフォーカスで開始/停止
  useEffect(() => {
    if (!isFocused) {
      stopPolling();
      return;
    }
    startPolling();
    return stopPolling;
  }, [isFocused, startPolling, stopPolling]);

  // バックグラウンド復帰時にポーリングを再開
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState: AppStateStatus) => {
      if (!isFocused) return;
      if (nextState === 'active') {
        startPolling();
      } else {
        stopPolling();
      }
    });
    return () => subscription.remove();
  }, [isFocused, startPolling, stopPolling]);

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
      {/* Header status bar */}
      <View style={styles.header}>
        <View style={styles.statusRow}>
          <View style={[styles.dot, { backgroundColor: statusColor }]} />
          <Text style={[styles.statusText, { color: statusColor }]}>{statusLabel}</Text>
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

      {/* Extractions list */}
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
                new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
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

      {/* Bottom controls */}
      <View style={styles.footer}>
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
            <Text style={styles.resultsButtonText}>詳細を見る</Text>
          </TouchableOpacity>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0f0f1a' },
  header: {
    backgroundColor: '#1a1a2e',
    paddingHorizontal: 16,
    paddingVertical: 12,
    paddingTop: Platform.OS === 'ios' ? 12 : 12,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.08)',
  },
  statusRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 4 },
  dot: { width: 8, height: 8, borderRadius: 4, marginRight: 8 },
  statusText: { fontSize: 13, fontWeight: '600' },
  sessionLabel: { color: '#fff', fontSize: 15, fontWeight: 'bold', marginBottom: 2 },
  updatedText: { color: '#555', fontSize: 11 },
  scroll: { flex: 1 },
  scrollContent: { padding: 16, paddingBottom: 100 },
  loader: { marginTop: 60 },
  emptyContainer: { alignItems: 'center', marginTop: 60, paddingHorizontal: 32 },
  emptyIcon: { fontSize: 48, marginBottom: 16 },
  emptyTitle: { color: '#fff', fontSize: 18, fontWeight: 'bold', marginBottom: 10, textAlign: 'center' },
  emptySubtitle: { color: '#555', fontSize: 13, textAlign: 'center', lineHeight: 20 },
  card: {
    backgroundColor: '#1a1a2e',
    borderRadius: 10,
    padding: 14,
    marginBottom: 10,
  },
  cardText: { color: '#fff', fontSize: 15, marginBottom: 8, lineHeight: 22 },
  cardMeta: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  confidence: { color: '#4caf50', fontSize: 12, fontWeight: '600' },
  timestamp: { color: '#555', fontSize: 11 },
  footer: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    gap: 12,
    padding: 16,
    paddingBottom: Platform.OS === 'ios' ? 32 : 16,
    backgroundColor: '#0f0f1a',
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.08)',
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
    flex: 1,
    paddingVertical: 14,
    borderRadius: 10,
    backgroundColor: '#e53935',
    alignItems: 'center',
  },
  resultsButtonText: { color: '#fff', fontSize: 15, fontWeight: '600' },
});
