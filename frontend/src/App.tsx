import { useEffect, useMemo, useRef, useState } from 'react';
import { ThemeStudio } from './components/ThemeStudio';
import { WorkspaceShell } from './components/WorkspaceShell';
import { createBridge } from './bridge/createBridge';
import {
  MODE_LABELS,
  normalizeModeSwitchResult,
  pickStartupNotice,
  readLastSwitchOutcome,
} from './bridge/modeSwitch';
import type { FusionMode, LastSwitchOutcome, ModeSwitchResult } from './bridge/modeSwitch';

/**
 * 启动自检：让 Fusion 成为 Dream Skin 的唯一入口。
 *
 * 边界：
 * - 只发起一次宿主调用；宿主侧的 ensure-dream-skin-mode.ps1 才是真正的决策者；
 * - 宿主在「Code-Codex 正在运行」或「有其他 Codex 会话」时返回 blocked 且不做任何改动，
 *   这里只把它的原话展示出来，绝不在前端做任何进程判断；
 * - 浏览器开发环境没有该宿主命令时静默跳过，不影响主题页使用；
 * - 自检抛错时必须给出可感知的 warning，禁止静默吞掉（U3）。
 */
function readEnsureDreamSkinMode(): (() => Promise<unknown>) | null {
  const entry = window.__codexFusionEnsureDreamSkinMode__;
  return typeof entry === 'function' ? entry : null;
}

type Notice = { text: string; tone: 'success' | 'neutral' | 'warning' };

/** 从 ensure / 切换结果推断当前模式；无法判断时返回 unknown。 */
function inferModeFromResult(result: ModeSwitchResult | null): FusionMode | 'unknown' {
  if (!result) return 'unknown';
  if (result.mode === 'dream-skin' || result.mode === 'code-codex') {
    return result.mode;
  }
  if (result.outcome === 'success' || result.outcome === 'already-active') {
    if (result.action.includes('dream-skin')) return 'dream-skin';
    if (result.action.includes('code-codex')) return 'code-codex';
  }
  return 'unknown';
}

export default function App() {
  const [view, setView] = useState<'theme' | 'workspace'>('theme');
  const [startupNotice, setStartupNotice] = useState<Notice | null>(null);
  const [activeMode, setActiveMode] = useState<FusionMode | 'unknown'>('unknown');
  const bridge = useMemo(() => createBridge(), []);
  const ensured = useRef(false);

  useEffect(() => {
    if (ensured.current) {
      return;
    }
    ensured.current = true;
    let cancelled = false;
    void (async () => {
      // 先看上一次切换有没有跑完。切换过程中被关掉窗口的情况必须让用户知道，
      // 否则那两次点击看起来就像什么都没发生。
      let last: LastSwitchOutcome | null = null;
      try {
        last = await readLastSwitchOutcome();
      } catch {
        last = null;
      }

      let ensureResult: ModeSwitchResult | null = null;
      let ensureFailureNotice: Notice | null = null;
      const ensure = readEnsureDreamSkinMode();
      if (ensure) {
        try {
          ensureResult = normalizeModeSwitchResult(await ensure());
        } catch (cause) {
          // U3：自检失败必须可见，同时不阻断主题页与工作区。
          const detail = cause instanceof Error && cause.message
            ? cause.message
            : typeof cause === 'string' && cause
              ? cause
              : '宿主未返回可用结果';
          ensureFailureNotice = {
            text: `Dream Skin 启动自检未能完成：${detail}。主题页与工作区仍可继续使用，可稍后重试切换或刷新。`,
            tone: 'warning',
          };
          ensureResult = null;
        }
      }

      if (cancelled) {
        return;
      }
      const inferred = inferModeFromResult(ensureResult);
      if (inferred !== 'unknown') {
        setActiveMode(inferred);
      } else if (ensureResult || last?.result) {
        // ensure 未给出明确 mode 时，成功/已就绪默认视为 Dream Skin 入口态
        if (ensureResult && (ensureResult.outcome === 'success' || ensureResult.outcome === 'already-active')) {
          setActiveMode('dream-skin');
        }
      }
      setStartupNotice(ensureFailureNotice ?? pickStartupNotice(last, ensureResult));
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (view === 'workspace') {
    return (
      <WorkspaceShell
        bridge={bridge}
        onOpenThemeStudio={() => setView('theme')}
        modeLabel={activeMode === 'unknown' ? null : MODE_LABELS[activeMode]}
      />
    );
  }
  return (
    <ThemeStudio
      onOpenWorkspace={() => setView('workspace')}
      startupNotice={startupNotice}
      activeMode={activeMode}
      onActiveModeChange={setActiveMode}
    />
  );
}
