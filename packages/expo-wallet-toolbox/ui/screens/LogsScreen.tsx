import React, { useState, useEffect, useCallback, useRef } from 'react'
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
  Platform
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { showToast } from '../components/ui/Toast'
import { useTheme, spacing, typography, radii, useWallet } from '@bsv/expo-wallet-toolbox'

/**
 * @expo/vector-icons' index barrel re-exports every icon set (AntDesign,
 * etc.), one of which reaches expo-font -> expo-asset -- untransformed ESM
 * that Jest cannot parse when eagerly pulled in via the `ui` package barrel.
 * Ionicons is loaded lazily, only when actually rendering, same pattern as
 * this package's other native-module-boundary fixes (expo-router, expo-blur).
 */
type IoniconsComponent = typeof import('@expo/vector-icons').Ionicons
let ioniconsComponent: IoniconsComponent | undefined
function loadIonicons(): IoniconsComponent {
  if (!ioniconsComponent) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    ioniconsComponent = require('@expo/vector-icons').Ionicons as IoniconsComponent
  }
  return ioniconsComponent
}

/**
 * expo-router is required lazily rather than imported at module scope: this
 * file is barrel-exported from the package's `ui` entry point, and a static
 * top-level `import` of expo-router pulls in its own untransformed JSX
 * source (Navigator.js etc.), which Jest cannot parse for any consumer of the
 * barrel, even one that never navigates. Same pattern as this package's other
 * lazy expo-router loads (WalletHomeScreen.tsx, VaultScreen.tsx, etc.).
 */
type ExpoRouterModule = typeof import('expo-router')
let expoRouterMod: ExpoRouterModule | undefined
function loadExpoRouter(): ExpoRouterModule {
  if (!expoRouterMod) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    expoRouterMod = require('expo-router') as ExpoRouterModule
  }
  return expoRouterMod
}

/**
 * @react-native-clipboard/clipboard reaches for its native TurboModule at
 * import time (`TurboModuleRegistry.getEnforcing`), which throws under Jest
 * (no native binary registered there) even though the module itself
 * transforms fine. Required lazily, only when a handler actually copies
 * something, so importing the `ui` barrel never touches the native module.
 */
type ClipboardModule = typeof import('@react-native-clipboard/clipboard').default
let clipboardModule: ClipboardModule | undefined
function loadClipboard(): ClipboardModule {
  if (!clipboardModule) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    clipboardModule = require('@react-native-clipboard/clipboard').default as ClipboardModule
  }
  return clipboardModule
}

interface LogEntry {
  id: string
  taskName: string
  timestamp: string
  output: string
}

export function LogsScreen() {
  const { colors } = useTheme()
  const insets = useSafeAreaInsets()
  const { router } = loadExpoRouter()
  const Ionicons = loadIonicons()
  const { runMonitorTask, getMonitorTaskNames, checkUtxoSpendability, releaseStuckReservations } = useWallet()

  const [taskNames, setTaskNames] = useState<string[]>([])
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [running, setRunning] = useState<string | null>(null)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const scrollRef = useRef<ScrollView>(null)

  useEffect(() => {
    setTaskNames(getMonitorTaskNames())
  }, [getMonitorTaskNames])

  const runTask = useCallback(
    async (name: string) => {
      setRunning(name)
      try {
        const output = await runMonitorTask(name)
        const entry: LogEntry = {
          id: `${Date.now()}_${name}`,
          taskName: name,
          timestamp: new Date().toISOString(),
          output: output || '(no output)'
        }
        setLogs(prev => [...prev, entry])
        setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 100)
      } catch (e: any) {
        const entry: LogEntry = {
          id: `${Date.now()}_${name}`,
          taskName: name,
          timestamp: new Date().toISOString(),
          output: `Error: ${e.message || 'unknown'}`
        }
        setLogs(prev => [...prev, entry])
      } finally {
        setRunning(null)
      }
    },
    [runMonitorTask]
  )

  const runUtxoCheck = useCallback(async () => {
    const name = 'CheckUTXOs'
    setRunning(name)
    try {
      const output = await checkUtxoSpendability()
      const entry: LogEntry = {
        id: `${Date.now()}_${name}`,
        taskName: name,
        timestamp: new Date().toISOString(),
        output: output || '(no output)'
      }
      setLogs(prev => [...prev, entry])
      setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 100)
    } catch (e: any) {
      const entry: LogEntry = {
        id: `${Date.now()}_${name}`,
        taskName: name,
        timestamp: new Date().toISOString(),
        output: `Error: ${e.message || 'unknown'}`
      }
      setLogs(prev => [...prev, entry])
    } finally {
      setRunning(null)
    }
  }, [checkUtxoSpendability])

  const runRelease = useCallback(async () => {
    const name = 'ReleaseStuck'
    setRunning(name)
    try {
      const output = await releaseStuckReservations()
      setLogs(prev => [
        ...prev,
        { id: `${Date.now()}_${name}`, taskName: name, timestamp: new Date().toISOString(), output: output || '(no output)' }
      ])
      setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 100)
    } catch (e: any) {
      setLogs(prev => [
        ...prev,
        { id: `${Date.now()}_${name}`, taskName: name, timestamp: new Date().toISOString(), output: `Error: ${e.message || 'unknown'}` }
      ])
    } finally {
      setRunning(null)
    }
  }, [releaseStuckReservations])

  const runAll = useCallback(async () => {
    for (const name of taskNames) {
      await runTask(name)
    }
  }, [taskNames, runTask])

  const copyEntry = useCallback((entry: LogEntry) => {
    loadClipboard().setString(`[${entry.timestamp}] ${entry.taskName}\n${entry.output}`)
    setCopiedId(entry.id)
    setTimeout(() => setCopiedId(null), 1500)
  }, [])

  const copyAll = useCallback(() => {
    const text = logs
      .map(e => `[${e.timestamp}] ${e.taskName}\n${e.output}`)
      .join('\n\n')
    loadClipboard().setString(text)
    showToast('Copied all logs', { type: 'success' })
  }, [logs])

  const clearLogs = useCallback(() => {
    setLogs([])
  }, [])

  return (
    <View style={[styles.container, { backgroundColor: colors.backgroundSecondary, paddingTop: insets.top }]}>
      {/* Header */}
      <View style={[styles.header, { borderBottomColor: colors.separator }]}>
        <TouchableOpacity onPress={() => router.back()} style={styles.headerBtn}>
          <Ionicons name="chevron-back" size={24} color={colors.textSecondary} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: colors.textPrimary }]}>Debugging</Text>
        <View style={styles.headerActions}>
          {logs.length > 0 && (
            <TouchableOpacity onPress={copyAll} style={styles.headerBtn}>
              <Ionicons name="copy-outline" size={20} color={colors.accent} />
            </TouchableOpacity>
          )}
          {logs.length > 0 && (
            <TouchableOpacity onPress={clearLogs} style={styles.headerBtn}>
              <Ionicons name="trash-outline" size={20} color={colors.textSecondary} />
            </TouchableOpacity>
          )}
        </View>
      </View>

      {/* Task buttons */}
      <View style={[styles.taskBar, { borderBottomColor: colors.separator }]}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.taskBarContent}>
          <TouchableOpacity
            onPress={runAll}
            disabled={!!running}
            style={[styles.taskPill, { backgroundColor: colors.accent, opacity: running ? 0.5 : 1 }]}
          >
            {running ? (
              <ActivityIndicator size="small" color={colors.background} />
            ) : (
              <Text style={[styles.taskPillText, { color: colors.background }]}>Run All</Text>
            )}
          </TouchableOpacity>
          {taskNames.map(name => (
            <TouchableOpacity
              key={name}
              onPress={() => runTask(name)}
              disabled={!!running}
              style={[
                styles.taskPill,
                {
                  backgroundColor: running === name ? colors.accent : colors.backgroundSecondary,
                  borderColor: colors.separator,
                  borderWidth: running === name ? 0 : StyleSheet.hairlineWidth,
                  opacity: running && running !== name ? 0.5 : 1
                }
              ]}
            >
              {running === name ? (
                <ActivityIndicator size="small" color={colors.background} />
              ) : (
                <Text
                  style={[styles.taskPillText, { color: running === name ? colors.background : colors.textPrimary }]}
                  numberOfLines={1}
                >
                  {name}
                </Text>
              )}
            </TouchableOpacity>
          ))}
          <TouchableOpacity
            onPress={runUtxoCheck}
            disabled={!!running}
            style={[
              styles.taskPill,
              {
                backgroundColor: running === 'CheckUTXOs' ? colors.accent : colors.backgroundSecondary,
                borderColor: colors.separator,
                borderWidth: running === 'CheckUTXOs' ? 0 : StyleSheet.hairlineWidth,
                opacity: running && running !== 'CheckUTXOs' ? 0.5 : 1
              }
            ]}
          >
            {running === 'CheckUTXOs' ? (
              <ActivityIndicator size="small" color={colors.background} />
            ) : (
              <Text
                style={[styles.taskPillText, { color: running === 'CheckUTXOs' ? colors.background : colors.textPrimary }]}
                numberOfLines={1}
              >
                CheckUTXOs
              </Text>
            )}
          </TouchableOpacity>
          <TouchableOpacity
            onPress={runRelease}
            disabled={!!running}
            style={[
              styles.taskPill,
              {
                backgroundColor: running === 'ReleaseStuck' ? colors.accent : colors.backgroundSecondary,
                borderColor: colors.separator,
                borderWidth: running === 'ReleaseStuck' ? 0 : StyleSheet.hairlineWidth,
                opacity: running && running !== 'ReleaseStuck' ? 0.5 : 1
              }
            ]}
          >
            {running === 'ReleaseStuck' ? (
              <ActivityIndicator size="small" color={colors.background} />
            ) : (
              <Text
                style={[styles.taskPillText, { color: running === 'ReleaseStuck' ? colors.background : colors.textPrimary }]}
                numberOfLines={1}
              >
                Release stuck
              </Text>
            )}
          </TouchableOpacity>
        </ScrollView>
      </View>

      {/* Log output */}
      <ScrollView
        ref={scrollRef}
        style={[styles.terminal, { backgroundColor: '#12161D' }]}
        contentContainerStyle={styles.terminalContent}
      >
        {logs.length === 0 && (
          <Text style={styles.emptyText}>Tap a task above to run it and see output here.</Text>
        )}
        {logs.map(entry => {
          const isCopied = copiedId === entry.id
          return (
            <TouchableOpacity
              key={entry.id}
              onPress={() => copyEntry(entry)}
              activeOpacity={0.7}
              style={[styles.logEntry, { borderBottomColor: 'rgba(255,255,255,0.08)' }]}
            >
              <View style={styles.logHeader}>
                <Text style={styles.logTaskName}>{entry.taskName}</Text>
                <Text style={styles.logTimestamp}>
                  {new Date(entry.timestamp).toLocaleTimeString()}
                </Text>
                <Ionicons
                  name={isCopied ? 'checkmark' : 'copy-outline'}
                  size={14}
                  color={isCopied ? '#34C77B' : 'rgba(235,240,248,0.38)'}
                  style={{ marginLeft: 6 }}
                />
              </View>
              <Text style={styles.logOutput} selectable>
                {entry.output}
              </Text>
            </TouchableOpacity>
          )
        })}
        <View style={{ height: insets.bottom + 20 }} />
      </ScrollView>
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth
  },
  headerBtn: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center'
  },
  headerTitle: {
    ...typography.headline,
    fontWeight: '600',
    flex: 1,
    textAlign: 'center'
  },
  headerActions: {
    flexDirection: 'row'
  },
  taskBar: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingVertical: spacing.sm
  },
  taskBarContent: {
    paddingHorizontal: spacing.md,
    gap: spacing.xs
  },
  taskPill: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs + 2,
    borderRadius: radii.sm,
    minWidth: 60,
    alignItems: 'center'
  },
  taskPillText: {
    ...typography.caption1,
    fontWeight: '600'
  },
  terminal: {
    flex: 1
  },
  terminalContent: {
    padding: spacing.md
  },
  emptyText: {
    color: 'rgba(235,240,248,0.38)',
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    fontSize: 13,
    textAlign: 'center',
    marginTop: spacing.xxl
  },
  logEntry: {
    marginBottom: spacing.md,
    paddingBottom: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth
  },
  logHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 4
  },
  logTaskName: {
    color: '#FF9F0A',
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    fontSize: 12,
    fontWeight: '700'
  },
  logTimestamp: {
    color: 'rgba(235,240,248,0.38)',
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    fontSize: 11,
    marginLeft: 'auto'
  },
  logOutput: {
    color: '#E4E8EF',
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    fontSize: 12,
    lineHeight: 18
  }
})
