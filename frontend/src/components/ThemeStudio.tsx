import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  CircleDot,
  CloudRain,
  FolderTree,
  ImagePlus,
  Palette,
  RefreshCw,
  Search,
  Snowflake,
  Sparkles,
  Trash2,
  Upload,
  WandSparkles,
  Waves,
  ZoomIn,
} from 'lucide-react';
import { useDialogSubmit } from '../hooks/useDialogSubmit';
import { ErrorNotice } from './ErrorNotice';
import { Modal } from './Modal';
import {
  MODE_LABELS,
  describeModeSwitchResult,
  executeModeSwitch,
  modeSwitchConfirmation,
  normalizeModeSwitchResult,
} from '../bridge/modeSwitch';
import type { FusionMode, ModeSwitchResult } from '../bridge/modeSwitch';

interface ThemeRecord {
  id: string;
  name: string;
  image: string;
  hasImage: boolean;
  imageSize: string;
  imageDims: string;
  appearance: string;
  created: string;
  hasTagline: boolean;
  isActive: boolean;
}

interface ThemePayload {
  themes: ThemeRecord[];
  active: string;
  skinConnected: boolean;
  codexStatus: string;
  codexMessage: string;
}

interface CreateResult {
  ok: boolean;
  id?: string;
  error?: string;
}

type EffectType = 'none' | 'rain' | 'particles' | 'snow' | 'gradient-shift' | 'kenburns';

interface EffectRecord {
  id: string;
  name: string;
  type: string;
  description?: string;
  params?: Record<string, unknown>;
}

interface EffectPayload {
  ok?: boolean;
  effect?: string;
  name?: string | null;
  config?: Record<string, unknown>;
  effects?: EffectRecord[];
  error?: string;
}

interface RestartResult {
  ok: boolean;
  message?: string;
  error?: string;
}

const QUICK_EFFECTS: Array<{ type: EffectType; label: string; hint: string; icon: typeof CloudRain }> = [
  { type: 'none', label: '关闭效果', hint: '取消全部动态', icon: CircleDot },
  { type: 'rain', label: '雨幕', hint: '细雨扫过', icon: CloudRain },
  { type: 'particles', label: '粒子', hint: '光点漂浮', icon: CircleDot },
  { type: 'snow', label: '飘雪', hint: '轻雪下落', icon: Snowflake },
  { type: 'gradient-shift', label: '渐变流动', hint: '色带游走', icon: Waves },
  { type: 'kenburns', label: '镜头推进', hint: '缓慢变焦', icon: ZoomIn },
];

/** 快捷效果对应 Dream Skin 真实预设，保证预览与 Codex 注入一致。 */
const QUICK_EFFECT_CONFIG: Record<Exclude<EffectType, 'none'>, Record<string, unknown>> = {
  rain: { preset: 'rain-heavy', intensity: 8.5, speed: 8, opacity: 0.72, splash: true, glassDrops: true, mist: true },
  particles: { preset: 'particles-float', count: 110, speed: 0.85, opacity: 0.82, sizeMin: 1.6, sizeMax: 5.2, glow: true, drift: 0.7 },
  snow: { preset: 'snow-light', count: 70, speed: 0.88, opacity: 0.68, sizeMin: 1.1, sizeMax: 5.2, wind: 0.22, swing: 0.48 },
  'gradient-shift': {},
  kenburns: {},
};

const EFFECT_PREVIEW_PAGE = 'http://127.0.0.1:17890/dream-skin/effect-preview.html';

/** 雨幕芯片内彼此独立的细雨丝，避免整层纹理平移。 */
const RAIN_SWATCH_DROPS = Array.from({ length: 18 }, (_, index) => {
  const left = 4 + ((index * 17) % 92);
  const delay = -((index % 9) * 0.18);
  const duration = 0.55 + (index % 5) * 0.12;
  const height = 10 + (index % 4) * 3;
  const opacity = 0.35 + (index % 5) * 0.1;
  const drift = ((index % 5) - 2) * 3;
  return { id: index, left, delay, duration, height, opacity, drift };
});

/** 粒子芯片独立光点。 */
const PARTICLE_SWATCH_BITS = Array.from({ length: 10 }, (_, index) => ({
  id: index,
  left: 8 + ((index * 23) % 84),
  top: 18 + ((index * 29) % 58),
  size: 2 + (index % 3),
  delay: -((index % 7) * 0.35),
  duration: 2.8 + (index % 5) * 0.45,
  hue: 38 + (index % 6) * 28,
}));

/** 飘雪芯片独立雪点。 */
const SNOW_SWATCH_BITS = Array.from({ length: 12 }, (_, index) => ({
  id: index,
  left: 6 + ((index * 19) % 88),
  size: 1.5 + (index % 3),
  delay: -((index % 8) * 0.4),
  duration: 3.2 + (index % 5) * 0.55,
  drift: ((index % 5) - 2) * 5,
}));

const THEME_ORIGIN = 'http://127.0.0.1:17890';

/** 判断未知 JSON 是否为主题列表响应。入参：未知值；返回：通过字段检查的主题数据；边界：格式不符时返回 false。 */
function isThemePayload(value: unknown): value is ThemePayload {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<ThemePayload>;
  return Array.isArray(candidate.themes) && typeof candidate.active === 'string';
}

/** 把未知错误转换成用户可读文本。入参：异常值；返回：错误消息；边界：非 Error 值使用通用提示。 */
function errorMessage(cause: unknown): string {
  const raw = cause instanceof Error ? cause.message : String(cause ?? '');
  if (!raw || raw === '[object Object]') return '操作失败，请稍后重试';
  if (/CDP|调试端口|未连接/.test(raw)) {
    return 'Codex 未启用调试端口。请点击「连接并启用动态效果」后重试';
  }
  if (/主题服务|ECONNREFUSED|fetch|网络/.test(raw)) {
    return '暂时连不上 Dream Skin 主题服务，请确认服务已启动';
  }
  return raw;
}

/** 将主题编号转换为本机预览地址。入参：主题编号；返回：受控预览 URL。 */
function previewUrl(id: string): string {
  return `${THEME_ORIGIN}/api/preview/${encodeURIComponent(id)}`;
}

/** 判断字符串是否为内置动态效果类型。入参：未知字符串；返回：类型守卫结果；边界：未知效果返回 false。 */
function isEffectType(value: unknown): value is EffectType {
  return QUICK_EFFECTS.some((item) => item.type === value);
}

/** 判断未知 JSON 是否为效果列表。入参：未知值；返回：有效效果记录数组；边界：缺字段时返回 false。 */
function isEffectPayload(value: unknown): value is EffectPayload {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as EffectPayload;
  return Array.isArray(candidate.effects) && candidate.effects.every((item) => item && typeof item.id === 'string' && typeof item.name === 'string' && typeof item.type === 'string');
}

/** 将服务端效果类型映射为安全的预览样式名。入参：服务端效果类型；返回：受控样式名；边界：未知类型返回 none。 */
function previewEffectClass(value: string): string {
  const allowed = new Set(['rain', 'particles', 'snow', 'gradient-shift', 'kenburns', 'fog', 'matrix', 'stars', 'road']);
  return allowed.has(value) ? value : 'none';
}

/** 将图片文件读取为接口所需的 Base64 内容。入参：图片文件；返回：不带 MIME 前缀的 Base64；边界：读取失败时拒绝。 */
function readImageAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== 'string') {
        reject(new Error('图片读取结果无效'));
        return;
      }
      const commaIndex = reader.result.indexOf(',');
      resolve(commaIndex >= 0 ? reader.result.slice(commaIndex + 1) : reader.result);
    };
    reader.onerror = () => reject(new Error('图片读取失败'));
    reader.readAsDataURL(file);
  });
}

/** 从文件名生成可读主题名。入参：文件名；返回：去掉扩展名后的名称；边界：空名回退默认文案。 */
function themeNameFromFile(fileName: string): string {
  const base = fileName.replace(/\.[^.]+$/, '').trim();
  return base || '我的新主题';
}

/** 把连接状态转成用户可理解的说明。入参：是否已连接、是否已有活动主题、原始消息；返回：状态文案。 */
function statusCopy(skinConnected: boolean, hasActiveTheme: boolean, codexMessage: string): string {
  if (skinConnected) return '已连接 · 壁纸与动态效果可实时预览并应用到 Codex';
  if (/调试端口|running_no_cdp|未启用调试/.test(codexMessage)) {
    return '未连接 · Codex 在跑但没有调试端口（多半是点了官方图标）。点右侧按钮重启后才能注入皮肤';
  }
  if (/未运行|not_running/.test(codexMessage)) {
    return '未连接 · Codex 未运行。点右侧按钮启动带皮肤的会话';
  }
  if (hasActiveTheme) return '壁纸已保存到本地 · 动态效果仍需先连接 Codex';
  if (codexMessage.includes('无法连接')) return '主题服务暂时不可用，可点「重试刷新」或重启 Fusion';
  return codexMessage || '正在准备主题服务…';
}

export interface ThemeStudioProps {
  /** 请求宿主切换运行模式（切换前会关闭当前模式自己管理的 Codex 会话，可回滚）；未提供时由适配器读取宿主注入层。 */
  onRequestModeSwitch?: (target: FusionMode) => Promise<ModeSwitchResult>;
  /** 切换到 Code-Codex 工作区（文件树 / 编辑器）；未提供时隐藏入口。 */
  onOpenWorkspace?: () => void;
  /** 启动自检结果（宿主决定，前端只展示）；未提供时不显示。 */
  startupNotice?: { text: string; tone: 'success' | 'neutral' | 'warning' } | null;
  /** 当前运行模式（由 App 从 ensure / 切换结果提升）；未知时顶栏双按钮均可切换。 */
  activeMode?: FusionMode | 'unknown';
  /** 模式变化时回写 App，供工作区状态栏只读展示。 */
  onActiveModeChange?: (mode: FusionMode | 'unknown') => void;
}

export function ThemeStudio({
  onRequestModeSwitch,
  onOpenWorkspace,
  startupNotice,
  activeMode = 'unknown',
  onActiveModeChange,
}: ThemeStudioProps) {
  const [themes, setThemes] = useState<ThemeRecord[]>([]);
  const [activeTheme, setActiveTheme] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [skinConnected, setSkinConnected] = useState(false);
  const [codexMessage, setCodexMessage] = useState('正在读取主题服务…');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [themeName, setThemeName] = useState('我的新主题');
  const [themeQuery, setThemeQuery] = useState('');
  const [currentEffect, setCurrentEffect] = useState<EffectType>('none');
  const [effectName, setEffectName] = useState<string | null>(null);
  const [previewEffectType, setPreviewEffectType] = useState('none');
  const [previewEffectConfig, setPreviewEffectConfig] = useState<Record<string, unknown>>({});
  const [effects, setEffects] = useState<EffectRecord[]>([]);
  const [effectBusy, setEffectBusy] = useState(false);
  const [restartBusy, setRestartBusy] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<ThemeRecord | null>(null);
  const [pendingSwitch, setPendingSwitch] = useState<FusionMode | null>(null);
  const [switchBusy, setSwitchBusy] = useState(false);
  const [codeCodexWarning, setCodeCodexWarning] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const dragDepthRef = useRef(0);
  const effectPreviewRef = useRef<HTMLIFrameElement | null>(null);
  const effectPreviewReadyRef = useRef(false);

  const selectedTheme = useMemo(
    () => themes.find((theme) => theme.id === selectedId) ?? themes[0] ?? null,
    [selectedId, themes],
  );

  const filteredThemes = useMemo(() => {
    const query = themeQuery.trim().toLowerCase();
    const sorted = [...themes].sort((left, right) => Number(right.isActive) - Number(left.isActive));
    if (!query) return sorted;
    return sorted.filter((theme) => theme.name.toLowerCase().includes(query) || theme.image.toLowerCase().includes(query));
  }, [themeQuery, themes]);

  /** 请求 Dream Skin 主题 API，生产环境优先走 Tauri 本地代理。入参：方法、路径和可选 JSON；返回：未知 JSON；边界：无宿主代理时回退浏览器请求。 */
  const requestThemeApi = useCallback(async (method: 'GET' | 'POST', path: string, body?: Record<string, unknown>): Promise<unknown> => {
    if (window.__codexFusionThemeRequest__) {
      return window.__codexFusionThemeRequest__(method, path, body);
    }
    const response = await fetch(`${THEME_ORIGIN}${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) throw new Error(`主题服务 HTTP ${response.status}`);
    return response.json();
  }, []);

  /** 加载主题列表和 Codex 连接状态。入参：无；返回：异步完成；边界：失败时保留旧列表并展示错误。 */
  const loadThemes = useCallback(async () => {
    setBusy('load');
    setError(null);
    try {
      const value = await requestThemeApi('GET', '/api/themes');
      if (!isThemePayload(value)) throw new Error('主题服务响应格式不完整');
      setThemes(value.themes);
      setActiveTheme(value.active);
      setSelectedId((current) => (value.themes.some((theme) => theme.id === current) ? current : value.themes[0]?.id ?? ''));
      setSkinConnected(value.skinConnected);
      setCodexMessage(value.codexMessage);
    } catch (cause) {
      setError(errorMessage(cause));
      setCodexMessage('无法连接 Dream Skin 主题服务');
    } finally {
      setBusy(null);
    }
  }, [requestThemeApi]);

  useEffect(() => {
    void loadThemes();
  }, [loadThemes]);


  useEffect(() => {
    void (async () => {
      try {
        const [currentValue, listValue] = await Promise.all([
          requestThemeApi('GET', '/api/effect/current'),
          requestThemeApi('GET', '/api/effects'),
        ]);
        if (currentValue && typeof currentValue === 'object') {
          const current = currentValue as EffectPayload;
          if (isEffectType(current.effect)) setCurrentEffect(current.effect);
          if (typeof current.effect === 'string') setPreviewEffectType(previewEffectClass(current.effect));
          setEffectName(typeof current.name === 'string' ? current.name : null);
          setPreviewEffectConfig(current.config && typeof current.config === 'object' ? current.config : {});
        }
        if (isEffectPayload(listValue)) setEffects(listValue.effects ?? []);
      } catch {
        // 动态效果接口不可用时保留静止状态，不影响主题库使用
      }
    })();
  }, [requestThemeApi]);

  /** 把壁纸与效果同步到 Dream Skin 真实引擎预览 iframe。入参：壁纸 URL、效果类型与配置；返回：无。 */
  const pushEffectPreview = useCallback((imageUrl: string, effect: string, config: Record<string, unknown>) => {
    const frame = effectPreviewRef.current?.contentWindow;
    if (!frame || !effectPreviewReadyRef.current) return;
    frame.postMessage({ source: 'dream-skin-effect-preview-host', type: 'setWallpaper', url: imageUrl }, '*');
    frame.postMessage({ source: 'dream-skin-effect-preview-host', type: 'setEffect', effect, config }, '*');
  }, []);

  /** 应用内置动态效果。入参：效果类型；返回：异步完成；边界：本地预览先切换，Codex 注入失败时仍保留预览并展示错误。 */
  const applyEffect = useCallback(async (effect: EffectType) => {
    const config = effect === 'none' ? {} : QUICK_EFFECT_CONFIG[effect];
    setCurrentEffect(effect);
    setEffectName(null);
    setPreviewEffectType(previewEffectClass(effect));
    setPreviewEffectConfig(config);
    setEffectBusy(true);
    setError(null);
    try {
      const value = await requestThemeApi('POST', '/api/effect', { effect, config });
      const result = value as EffectPayload;
      if (result.ok !== true) throw new Error(result.error ?? '动态效果应用失败');
      setToast(effect === 'none'
        ? '已关闭动态效果'
        : `已切换动态效果：${QUICK_EFFECTS.find((item) => item.type === effect)?.label ?? effect}`);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setEffectBusy(false);
    }
  }, [requestThemeApi]);

  /** 应用效果库中的自定义效果。入参：效果记录；返回：异步完成；边界：本地预览先切换，Codex 注入失败时仍保留预览。 */
  const applyLibraryEffect = useCallback(async (effect: EffectRecord) => {
    const config = { ...(effect.params ?? {}), preset: effect.id };
    setEffectName(effect.name);
    setPreviewEffectType(previewEffectClass(effect.type));
    setPreviewEffectConfig(config);
    if (isEffectType(effect.type)) setCurrentEffect(effect.type);
    setEffectBusy(true);
    setError(null);
    try {
      const value = await requestThemeApi('POST', '/api/effects/apply', { id: effect.id });
      const result = value as EffectPayload;
      if (result.ok !== true) throw new Error(result.error ?? '自定义动态效果应用失败');
      setToast(`已应用效果：${effect.name}`);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setEffectBusy(false);
    }
  }, [requestThemeApi]);

  /** 通过 Dream Skin 的安全启动器重启 Codex 并重新应用活动主题。入参：无；返回：异步完成；边界：启动器超时或未提供调试端口时展示服务错误。 */
  const restartCodex = useCallback(async () => {
    setRestartBusy(true);
    setError(null);
    try {
      const value = await requestThemeApi('POST', '/api/restart-codex');
      const result = value as RestartResult;
      if (result.ok !== true) throw new Error(result.error ?? 'Codex 重启失败');
      setToast(result.message ?? '已连接并启用动态效果');
      await loadThemes();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setRestartBusy(false);
    }
  }, [loadThemes, requestThemeApi]);

  /**
   * Code-Codex 模式健康检查（只读）。入参：无；返回：异步完成；边界：
   * 宿主未注入时静默跳过；发现「会话在但 CDP 不可连」时展示兼容性警告。
   */
  const checkCodeCodexHealth = useCallback(async () => {
    const health = window.__codexFusionCodeCodexHealth__;
    if (typeof health !== 'function') {
      return;
    }
    try {
      const value = (await health()) as { sessionPresent?: boolean; available?: boolean; reason?: string | null } | null;
      if (value && value.sessionPresent === true && value.available !== true && value.reason) {
        setCodeCodexWarning(value.reason);
      }
    } catch {
      // 健康检查失败不影响主题页与工作区继续使用
    }
  }, []);

  // 启动时也做一次健康检查：若上次停在 Code-Codex 模式且 CDP 不可连，直接展示警告。
  useEffect(() => {
    void checkCodeCodexHealth();
  }, [checkCodeCodexHealth]);

  /**
   * 切换运行模式。入参：目标模式；返回：异步完成；边界：调用前 ThemeStudio 已完成一次确认。
   * 进程只由宿主侧脚本结束，前端只提交请求并按结果如实反馈。
   * U1：确认后走 executeModeSwitch / 注入回调，绝不再套一层 window.confirm。
   */
  const performModeSwitch = useCallback(async (target: FusionMode) => {
    setError(null);
    setSwitchBusy(true);
    try {
      const result = onRequestModeSwitch
        ? normalizeModeSwitchResult(await onRequestModeSwitch(target))
        : await executeModeSwitch(target);
      const { text, tone } = describeModeSwitchResult(result);
      if (tone === 'warning') {
        setError(text);
      } else {
        setToast(text);
      }
      if (result.outcome === 'success' || result.outcome === 'already-active' || result.outcome === 'partial') {
        if (result.mode === 'dream-skin' || result.mode === 'code-codex') {
          onActiveModeChange?.(result.mode);
        } else {
          onActiveModeChange?.(target);
        }
      }
      if (result.outcome === 'success' || result.outcome === 'partial') {
        await loadThemes();
        // 切到 Code-Codex 后做一次功能级健康检查：进程起得来不等于 CDP 注入可用，
        // 新版 Codex 的 Chromium 会忽略默认 profile 的调试端口，必须如实告知。
        setCodeCodexWarning(null);
        if (target === 'code-codex') {
          await checkCodeCodexHealth();
        }
      }
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSwitchBusy(false);
      setPendingSwitch(null);
    }
  }, [loadThemes, onRequestModeSwitch, checkCodeCodexHealth, onActiveModeChange]);

  /** 打开模式切换确认对话框。入参：目标模式；返回：无；边界：切换进行中忽略重复点击。 */
  const openModeSwitch = useCallback((target: FusionMode) => {
    if (switchBusy) return;
    setError(null);
    setPendingSwitch(target);
  }, [switchBusy]);

  /** 应用选中的主题并刷新活动状态。入参：主题记录；返回：异步完成；边界：服务拒绝时保留当前选择。 */
  const applyTheme = useCallback(async (theme: ThemeRecord) => {
    setBusy(`apply:${theme.id}`);
    setError(null);
    try {
      const value = await requestThemeApi('POST', '/api/themes/apply', { id: theme.id });
      const result = value as CreateResult;
      if (result.ok !== true) throw new Error(result.error ?? '主题应用失败');
      setToast(`已应用到 Codex：${theme.name}`);
      await loadThemes();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(null);
    }
  }, [loadThemes, requestThemeApi]);

  /** 删除主题库中的主题。入参：主题记录；返回：异步完成；边界：当前使用中的主题会被服务端拒绝。 */
  const deleteTheme = useCallback(async (theme: ThemeRecord) => {
    setBusy(`delete:${theme.id}`);
    setError(null);
    try {
      const value = await requestThemeApi('POST', '/api/themes/delete', { id: theme.id });
      const result = value as CreateResult;
      if (result.ok !== true) throw new Error(result.error ?? '主题删除失败');
      setPendingDelete(null);
      setToast(`已删除主题：${theme.name}`);
      await loadThemes();
    } catch (cause) {
      // 交由 useDialogSubmit 在删除对话框内统一展示，避免页面底部重复报错
      throw cause instanceof Error ? cause : new Error(errorMessage(cause));
    } finally {
      setBusy(null);
    }
  }, [loadThemes, requestThemeApi]);

  /** 用图片文件创建主题。入参：图片文件与可选名称；返回：异步完成；边界：仅接受图片。 */
  const createThemeFromFile = useCallback(async (file: File, preferredName?: string) => {
    if (!file.type.startsWith('image/')) {
      setError('请选择 PNG、JPG 或 WebP 图片');
      return;
    }
    const nextName = (preferredName ?? themeName).trim() || themeNameFromFile(file.name);
    setThemeName(nextName);
    setBusy('create');
    setError(null);
    try {
      const imageData = await readImageAsBase64(file);
      const value = await requestThemeApi('POST', '/api/themes/create', {
        name: nextName,
        imageData,
        imageType: file.type,
      });
      const result = value as CreateResult;
      if (result.ok !== true) throw new Error(result.error ?? '主题创建失败');
      setToast('新主题已保存');
      await loadThemes();
      if (result.id) setSelectedId(result.id);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(null);
    }
  }, [loadThemes, requestThemeApi, themeName]);

  /** 读取文件选择器中的图片并创建主题。入参：文件选择事件；返回：异步完成。 */
  const handleFileChange = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    await createThemeFromFile(file);
  }, [createThemeFromFile]);

  /** 处理拖拽进入创建区。入参：拖拽事件；返回：无；边界：仅在包含文件时激活。 */
  const handleDragEnter = useCallback((event: React.DragEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    dragDepthRef.current += 1;
    if (event.dataTransfer.types.includes('Files')) setDragActive(true);
  }, []);

  /** 处理拖拽离开创建区。入参：拖拽事件；返回：无。 */
  const handleDragLeave = useCallback((event: React.DragEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDragActive(false);
  }, []);

  /** 允许放置图片文件。入参：拖拽事件；返回：无。 */
  const handleDragOver = useCallback((event: React.DragEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
  }, []);

  /** 放置图片后创建主题。入参：拖拽事件；返回：异步完成；边界：无图片时提示错误。 */
  const handleDrop = useCallback(async (event: React.DragEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    dragDepthRef.current = 0;
    setDragActive(false);
    const file = Array.from(event.dataTransfer.files).find((item) => item.type.startsWith('image/'));
    if (!file) {
      setError('请拖入 PNG、JPG 或 WebP 图片');
      return;
    }
    await createThemeFromFile(file, themeNameFromFile(file.name));
  }, [createThemeFromFile]);

  const deleteSubmit = useDialogSubmit(async () => {
    if (!pendingDelete) return;
    await deleteTheme(pendingDelete);
  });

  useEffect(() => {
    if (!toast) return undefined;
    const timer = window.setTimeout(() => setToast(null), 2400);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { source?: string; type?: string } | null;
      if (!data || data.source !== 'dream-skin-effect-preview' || data.type !== 'ready') return;
      effectPreviewReadyRef.current = true;
      if (!selectedTheme) return;
      pushEffectPreview(previewUrl(selectedTheme.id), previewEffectType, previewEffectConfig);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [previewEffectConfig, previewEffectType, pushEffectPreview, selectedTheme]);

  useEffect(() => {
    if (!selectedTheme || !effectPreviewReadyRef.current) return;
    pushEffectPreview(previewUrl(selectedTheme.id), previewEffectType, previewEffectConfig);
  }, [previewEffectConfig, previewEffectType, pushEffectPreview, selectedTheme]);

  const currentEffectLabel = effectName ?? QUICK_EFFECTS.find((item) => item.type === currentEffect)?.label ?? '关闭效果';
  const effectIsOff = previewEffectType === 'none' && !effectName;

  return (
    <main className="theme-studio">
      <div className="theme-tech-glow" aria-hidden="true" />
      <div className="theme-tech-grid" aria-hidden="true" />

      <header className="theme-topbar">
        <div className="theme-brand">
          <div className="theme-brand-mark" aria-hidden="true"><Sparkles size={20} /></div>
          <div>
            <h1>Dream Skin</h1>
            <p>壁纸与主题设计工作台</p>
          </div>
        </div>
        {/* U4：顶栏统一 Mode + CDP 状态芯片 */}
        <div
          className={`theme-mode-chip ${activeMode === 'unknown' ? 'unknown' : 'known'} ${skinConnected ? 'cdp-ok' : 'cdp-off'}`}
          role="status"
          aria-live="polite"
          title={codeCodexWarning ?? statusCopy(skinConnected, Boolean(activeTheme), codexMessage)}
        >
          <span className="theme-connection-dot" aria-hidden="true" />
          <span>
            {activeMode === 'dream-skin' ? 'Dream Skin' : activeMode === 'code-codex' ? 'Code-Codex' : '模式未确认'}
            {' · '}
            {switchBusy ? '切换中…' : skinConnected ? 'CDP 已连接' : codeCodexWarning ? 'CDP 异常' : 'CDP 未连接'}
          </span>
        </div>
        {onOpenWorkspace ? (
          <button
            className="btn theme-workspace-button"
            type="button"
            onClick={onOpenWorkspace}
            disabled={switchBusy}
            title="打开 Code-Codex 工作区（文件树与编辑器）"
          >
            <FolderTree size={15} /> 工作区
          </button>
        ) : null}
        {/* V3：当前模式作态指示，另一侧为「切换到…」主操作 */}
        <button
          className={`btn theme-mode-btn ${activeMode === 'dream-skin' ? 'is-current' : 'primary'}`}
          type="button"
          onClick={() => openModeSwitch('dream-skin')}
          disabled={switchBusy || activeMode === 'dream-skin'}
          aria-current={activeMode === 'dream-skin' ? 'true' : undefined}
          title={activeMode === 'dream-skin' ? '当前为 Dream Skin 模式' : '切换回 Dream Skin 模式（会先关闭 Code-Codex，再恢复壁纸与动态效果）'}
        >
          <WandSparkles size={15} /> {activeMode === 'dream-skin' ? 'Dream Skin · 当前' : '切回 Dream Skin'}
        </button>
        <button
          className={`btn theme-mode-btn ${activeMode === 'code-codex' ? 'is-current' : 'primary'}`}
          type="button"
          onClick={() => openModeSwitch('code-codex')}
          disabled={switchBusy || activeMode === 'code-codex'}
          aria-current={activeMode === 'code-codex' ? 'true' : undefined}
          title={activeMode === 'code-codex' ? '当前为 Code-Codex 模式' : '切换到 Code-Codex 模式（会先关闭 Dream Skin 管理的 Codex 会话，失败会自动恢复）'}
        >
          <Palette size={15} /> {activeMode === 'code-codex' ? 'Code-Codex · 当前' : '切换到 Code-Codex'}
        </button>
        <button className="icon-btn" type="button" onClick={() => void loadThemes()} disabled={busy !== null || restartBusy || switchBusy} title="刷新主题">
          <RefreshCw size={16} className={busy === 'load' ? 'spin' : ''} />
        </button>
      </header>

      <section className="theme-layout">
        <aside className="theme-library" aria-label="主题库">
          <div className="theme-section-heading">
            <div>
              <span className="eyebrow">主题库</span>
              <h2>我的壁纸</h2>
            </div>
            <span className="theme-count">{themes.length}</span>
          </div>

          <label className="theme-search" htmlFor="theme-search">
            <Search size={14} aria-hidden="true" />
            <input
              id="theme-search"
              value={themeQuery}
              onChange={(event) => setThemeQuery(event.target.value)}
              placeholder="搜索主题名称"
              autoComplete="off"
            />
          </label>

          <div className="theme-list">
            {filteredThemes.map((theme) => (
              <div className={`theme-list-item ${selectedTheme?.id === theme.id ? 'selected' : ''} ${theme.isActive ? 'active' : ''}`} key={theme.id}>
                <button className="theme-list-select" type="button" onClick={() => setSelectedId(theme.id)}>
                  <img src={previewUrl(theme.id)} alt="" className="theme-list-image" loading="lazy" />
                  <span className="theme-list-copy">
                    <strong>{theme.name}</strong>
                    <small>{theme.created} · {theme.imageSize}</small>
                  </span>
                </button>
                {theme.isActive ? (
                  <span className="theme-active-badge">使用中</span>
                ) : (
                  <button
                    className="theme-list-delete"
                    type="button"
                    title={`删除 ${theme.name}`}
                    aria-label={`删除 ${theme.name}`}
                    disabled={busy !== null}
                    onClick={() => setPendingDelete(theme)}
                  >
                    <Trash2 size={14} />
                  </button>
                )}
              </div>
            ))}
            {!filteredThemes.length && !error && (
              <p className="theme-empty">
                {busy === 'load' ? '正在加载主题…' : themes.length ? '没有匹配的主题' : '暂无可用主题，可上传壁纸创建'}
              </p>
            )}
          </div>

          <div
            className={`theme-create-panel ${dragActive ? 'drag-active' : ''}`}
            onDragEnter={handleDragEnter}
            onDragLeave={handleDragLeave}
            onDragOver={handleDragOver}
            onDrop={(event) => void handleDrop(event)}
          >
            <span className="eyebrow">新建</span>
            <label htmlFor="theme-name">主题名称</label>
            <input
              id="theme-name"
              className="text-input"
              value={themeName}
              onChange={(event) => setThemeName(event.target.value)}
              maxLength={80}
            />
            <button className="btn primary theme-create-button" type="button" onClick={() => fileInputRef.current?.click()} disabled={busy !== null}>
              <Upload size={15} /> 上传壁纸创建
            </button>
            <p className="theme-drop-hint">{dragActive ? '松开即可创建主题' : '也可把图片拖到这里'}</p>
            <input ref={fileInputRef} type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => void handleFileChange(event)} hidden />
          </div>
        </aside>

        <section className="theme-workspace" aria-label="主题预览">
          {selectedTheme ? (
            <>
              <div className="theme-preview-header">
                <div>
                  <span className="eyebrow">预览</span>
                  <h2>{selectedTheme.name}</h2>
                  <p>
                    {selectedTheme.hasTagline ? 'Dream Skin 主题' : '本地壁纸主题'} · {selectedTheme.appearance}
                    {selectedTheme.isActive ? ' · 当前使用中' : ''}
                  </p>
                </div>
                <button
                  className="btn primary"
                  type="button"
                  onClick={() => void applyTheme(selectedTheme)}
                  disabled={busy !== null || selectedTheme.isActive || switchBusy}
                >
                  <WandSparkles size={15} /> {selectedTheme.isActive ? '已在使用' : busy?.startsWith('apply:') ? '应用中…' : '应用到 Codex'}
                </button>
              </div>

              <div className={`theme-hero-preview effect-preview-${previewEffectType}`}>
                <span className="theme-frame-corner tl" aria-hidden="true" />
                <span className="theme-frame-corner tr" aria-hidden="true" />
                <span className="theme-frame-corner bl" aria-hidden="true" />
                <span className="theme-frame-corner br" aria-hidden="true" />
                <iframe
                  ref={effectPreviewRef}
                  className="theme-effect-engine-frame"
                  title={`${selectedTheme.name} 动态效果预览`}
                  src={EFFECT_PREVIEW_PAGE}
                  onLoad={() => {
                    // 某些环境下 ready 消息可能早于监听；onload 再补推一次
                    effectPreviewReadyRef.current = true;
                    pushEffectPreview(previewUrl(selectedTheme.id), previewEffectType, previewEffectConfig);
                  }}
                />
                <div className="theme-hero-overlay">
                  <span>{selectedTheme.name}</span>
                  <small>{selectedTheme.imageDims || '壁纸预览'} · {currentEffectLabel}</small>
                </div>
              </div>

              <div className="theme-inspector">
                <div className="inspector-heading"><Palette size={16} /><span>主题信息</span></div>
                <div className="inspector-grid">
                  <div><span>文件</span><strong>{selectedTheme.image}</strong></div>
                  <div><span>大小</span><strong>{selectedTheme.imageSize}</strong></div>
                  <div><span>创建日期</span><strong>{selectedTheme.created}</strong></div>
                  <div><span>活动主题</span><strong>{activeTheme || '未读取'}</strong></div>
                </div>
              </div>

              <section className="theme-effects" aria-label="动态效果">
                <div className="inspector-heading">
                  <Waves size={16} />
                  <span>动态效果</span>
                  <small>{effectIsOff ? '已关闭' : currentEffectLabel}</small>
                </div>
                <div className="theme-effect-grid">
                  {QUICK_EFFECTS.map(({ type, label, hint, icon: Icon }) => {
                    const selected = type === 'none' ? effectIsOff : currentEffect === type && !effectName;
                    return (
                      <button
                        key={type}
                        className={`theme-effect-chip ${selected ? 'selected' : ''} ${type === 'none' ? 'is-clear' : ''}`}
                        type="button"
                        onClick={() => void applyEffect(type)}
                        disabled={effectBusy || switchBusy || (type === 'none' && effectIsOff)}
                        aria-pressed={selected}
                      >
                        <span className={`theme-effect-swatch effect-swatch-${type}`} aria-hidden="true">
                          {type === 'rain' ? (
                            <span className="swatch-rain-field">
                              {RAIN_SWATCH_DROPS.map((drop) => (
                                <i
                                  key={drop.id}
                                  className="swatch-rain-drop"
                                  style={{
                                    left: `${drop.left}%`,
                                    height: `${drop.height}px`,
                                    opacity: drop.opacity,
                                    animationDuration: `${drop.duration}s`,
                                    animationDelay: `${drop.delay}s`,
                                    ['--rain-drift' as string]: `${drop.drift}px`,
                                  }}
                                />
                              ))}
                            </span>
                          ) : null}
                          {type === 'particles' ? (
                            <span className="swatch-particle-field">
                              {PARTICLE_SWATCH_BITS.map((bit) => (
                                <i
                                  key={bit.id}
                                  className="swatch-particle-bit"
                                  style={{
                                    left: `${bit.left}%`,
                                    top: `${bit.top}%`,
                                    width: `${bit.size}px`,
                                    height: `${bit.size}px`,
                                    animationDuration: `${bit.duration}s`,
                                    animationDelay: `${bit.delay}s`,
                                    background: `hsl(${bit.hue} 85% 72%)`,
                                    boxShadow: `0 0 8px hsl(${bit.hue} 90% 65%)`,
                                  }}
                                />
                              ))}
                            </span>
                          ) : null}
                          {type === 'snow' ? (
                            <span className="swatch-snow-field">
                              {SNOW_SWATCH_BITS.map((bit) => (
                                <i
                                  key={bit.id}
                                  className="swatch-snow-bit"
                                  style={{
                                    left: `${bit.left}%`,
                                    width: `${bit.size}px`,
                                    height: `${bit.size}px`,
                                    animationDuration: `${bit.duration}s`,
                                    animationDelay: `${bit.delay}s`,
                                    ['--snow-drift' as string]: `${bit.drift}px`,
                                  }}
                                />
                              ))}
                            </span>
                          ) : null}
                        </span>
                        <span className="theme-effect-meta">
                          <span className="theme-effect-label"><Icon size={13} /> {label}</span>
                          <small>{hint}</small>
                        </span>
                      </button>
                    );
                  })}
                </div>
                {effects.length > 0 ? (
                  <div className="theme-effect-library">
                    <span className="eyebrow">效果库</span>
                    {effects.map((effect) => (
                      <button
                        key={effect.id}
                        className={`theme-effect-library-item ${effectName === effect.name ? 'selected' : ''}`}
                        type="button"
                        onClick={() => void applyLibraryEffect(effect)}
                        disabled={effectBusy}
                      >
                        <span>{effect.name}</span>
                        <small>{effect.description || effect.type}</small>
                      </button>
                    ))}
                  </div>
                ) : null}
              </section>
            </>
          ) : (
            <div className="theme-empty-state">
              <ImagePlus size={32} />
              <h2>选择一个主题开始</h2>
              <p>从左侧选择壁纸，或上传图片创建主题。若要注入官方 Codex，请先确保下方状态为「已连接」。</p>
            </div>
          )}

          <div className={`theme-status ${skinConnected ? 'ok' : activeTheme ? 'configured' : 'warn'}`}>
            <span className="theme-status-dot" />
            <span>{statusCopy(skinConnected, Boolean(activeTheme), codexMessage)}</span>
            {!skinConnected ? (
              <button className="btn theme-restart-button" type="button" onClick={() => void restartCodex()} disabled={restartBusy || switchBusy}>
                {restartBusy ? '正在连接…' : '连接并启用动态效果'}
              </button>
            ) : null}
          </div>
          {/* U5/V2：错误可恢复 + 可复制；toast 仅用于成功短讯 */}
          {error ? (
            <ErrorNotice
              error={{ code: 'THEME', message: error }}
              onDismiss={() => setError(null)}
              actions={[
                { label: '重试刷新', onClick: () => void loadThemes() },
                { label: '重新检测连接', onClick: () => void restartCodex() },
                ...(codeCodexWarning || activeMode === 'code-codex'
                  ? [{ label: '重新检测 CDP', onClick: () => void checkCodeCodexHealth() }]
                  : []),
              ]}
            />
          ) : null}
          {codeCodexWarning ? (
            <div className="theme-error theme-warning-banner" role="alert">
              <span>{codeCodexWarning}</span>
              <button type="button" className="btn" onClick={() => void checkCodeCodexHealth()} disabled={switchBusy}>重新检测</button>
              <button type="button" className="btn" onClick={() => setCodeCodexWarning(null)}>知道了</button>
            </div>
          ) : null}
        </section>
      </section>

      {startupNotice ? (
        <div className={`theme-startup-notice ${startupNotice.tone}`} role="status">{startupNotice.text}</div>
      ) : null}

      {toast && <div className="theme-toast" role="status"><Check size={15} />{toast}</div>}

      {pendingSwitch ? (
        <Modal
          title={modeSwitchConfirmation(pendingSwitch).title}
          onClose={() => {
            if (!switchBusy) setPendingSwitch(null);
          }}
          footer={(
            <>
              <button type="button" className="btn" disabled={switchBusy} autoFocus onClick={() => setPendingSwitch(null)}>取消</button>
              <button type="button" className="btn primary" disabled={switchBusy} onClick={() => void performModeSwitch(pendingSwitch)}>
                {switchBusy ? '正在切换…' : `切换到${MODE_LABELS[pendingSwitch]}`}
              </button>
            </>
          )}
        >
          <div className="theme-switch-confirm">
            <p>{modeSwitchConfirmation(pendingSwitch).message}</p>
          </div>
        </Modal>
      ) : null}

      {pendingDelete ? (
        <Modal
          title="删除主题"
          onClose={() => {
            if (!deleteSubmit.busy) setPendingDelete(null);
          }}
          footer={(
            <>
              <button type="button" className="btn" disabled={deleteSubmit.busy} autoFocus onClick={() => setPendingDelete(null)}>取消</button>
              <button type="button" className="btn danger" disabled={deleteSubmit.busy} onClick={() => void deleteSubmit.run()}>
                {deleteSubmit.busy ? '处理中…' : '删除主题'}
              </button>
            </>
          )}
        >
          <div className="theme-delete-preview">
            <img src={previewUrl(pendingDelete.id)} alt="" />
            <div>
              <strong>{pendingDelete.name}</strong>
              <p>确定删除这个主题吗？删除后无法从主题库恢复。</p>
            </div>
          </div>
          {deleteSubmit.error ? <ErrorNotice error={deleteSubmit.error} /> : null}
        </Modal>
      ) : null}
    </main>
  );
}
