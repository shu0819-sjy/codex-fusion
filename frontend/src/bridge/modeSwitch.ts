import { BridgeOperationError, NOT_CONNECTED } from './WorkspaceBridge';

/**
 * 模式切换的前端协议层。
 *
 * 边界（与宿主分工）：
 * - 前端只做两件事：向用户确认、把一次 `mode.switch` 请求交给宿主；
 * - 前端绝不结束进程、绝不连接 CDP、绝不拼接安装路径；
 * - 关闭哪些进程、如何回滚、如何验证，全部由宿主侧的切换脚本按「可执行文件路径 + Dream Skin 档案路径」判定。
 */

/** 两个互斥的运行模式 */
export type FusionMode = 'dream-skin' | 'code-codex';

/** 切换结果类别（与脚本侧 outcome 一致） */
export type ModeSwitchOutcome =
  | 'success'
  | 'already-active'
  | 'blocked'
  | 'cancelled'
  | 'failed'
  | 'partial'
  | 'rollback'
  | 'rollback-failed';

/** 切换后实际观测到的模式 */
export type ObservedMode = FusionMode | 'none' | 'both' | 'unknown';

/** 宿主返回的切换结果 */
export interface ModeSwitchResult {
  schemaVersion: number;
  action: string;
  mode: ObservedMode;
  outcome: ModeSwitchOutcome;
  /** 0=成功；2=被阻止；3=用户取消；4=验证未通过；5=回滚未通过 */
  exitCode: number;
  message: string;
  detail?: unknown;
  timestamp: string;
}

/** 宿主必须实现的 JSONL 方法名 */
export const MODE_SWITCH_METHOD = 'mode.switch';

/** 切换请求的传输函数：由宿主注入，测试可注入替身 */
export type ModeSwitchTransport = (target: FusionMode) => Promise<unknown>;

/** 模式显示名 */
export const MODE_LABELS: Record<FusionMode, string> = {
  'dream-skin': 'Dream Skin 模式',
  'code-codex': 'Code-Codex 模式',
};

/**
 * 功能：生成切换前的确认文案。入参：目标模式；返回：标题与正文。
 * 返回值中的正文必须始终包含「未保存内容可能丢失」的警告，这是切换前的硬性要求。
 */
export function modeSwitchConfirmation(target: FusionMode): { title: string; message: string } {
  if (target === 'code-codex') {
    return {
      title: '切换到 Code-Codex',
      message: [
        '即将关闭 Dream Skin 当前管理的 Codex 会话，并启动 Code-Codex。',
        '',
        '• 未保存的内容可能丢失，请先保存正在编辑的内容。',
        '• 只关闭 Dream Skin 自己管理的进程，其他 Codex 窗口不受影响。',
        '• Code-Codex 使用它自己的界面、插件与粒子效果，不继承 Dream Skin 的壁纸配置。',
        '• 如果 Code-Codex 启动失败，会自动恢复 Dream Skin。',
        '',
        '是否继续？',
      ].join('\n'),
    };
  }
  return {
    title: '切换回 Dream Skin',
    message: [
      '即将关闭 Code-Codex，并恢复 Dream Skin 的壁纸与动态效果。',
      '',
      '• 未保存的内容可能丢失，请先保存正在编辑的内容。',
      '• 只关闭 Code-Codex 自己的进程，其他 Codex 窗口不受影响。',
      '• 恢复后会校验 CDP 端口与壁纸效果，校验不通过会如实告知。',
      '',
      '是否继续？',
    ].join('\n'),
  };
}

/**
 * 功能：把宿主原始 outcome 收敛到前端认识的 ModeSwitchOutcome。
 * 入参：原始 outcome 字符串；返回：规范 outcome。
 * 边界：ensure 历史返回 `ready`（表示已就绪）映射为 success，避免启动成功被当成告警。
 */
export function mapModeSwitchOutcome(raw: string): ModeSwitchOutcome {
  if (raw === 'ready' || raw === 'ok') {
    return 'success';
  }
  return raw as ModeSwitchOutcome;
}

/** 功能：把任意宿主返回值归一化为 ModeSwitchResult。入参：宿主返回值；返回：规范结果对象。 */
export function normalizeModeSwitchResult(value: unknown): ModeSwitchResult {
  if (!value || typeof value !== 'object') {
    throw new BridgeOperationError('INVALID_RESULT', '宿主返回的模式切换结果格式不合法');
  }
  const record = value as Record<string, unknown>;
  const outcome = record.outcome;
  if (typeof outcome !== 'string') {
    // 兼容早期只返回 { ok: true } 的启动器注入点
    if (record.ok === true) {
      return {
        schemaVersion: 1,
        action: typeof record.action === 'string' ? record.action : 'mode.switch',
        mode: typeof record.mode === 'string' ? (record.mode as ObservedMode) : 'dream-skin',
        outcome: 'success',
        exitCode: 0,
        message: typeof record.message === 'string' ? record.message : '操作已完成。',
        timestamp: new Date().toISOString(),
      };
    }
    throw new BridgeOperationError('INVALID_RESULT', '宿主返回的模式切换结果缺少 outcome 字段');
  }
  return {
    schemaVersion: typeof record.schemaVersion === 'number' ? record.schemaVersion : 1,
    action: typeof record.action === 'string' ? record.action : 'mode.switch',
    mode: typeof record.mode === 'string' ? (record.mode as ObservedMode) : 'unknown',
    outcome: mapModeSwitchOutcome(outcome),
    exitCode: typeof record.exitCode === 'number' ? record.exitCode : 0,
    message: typeof record.message === 'string' ? record.message : '',
    detail: record.detail,
    timestamp: typeof record.timestamp === 'string' ? record.timestamp : new Date().toISOString(),
  };
}

/** 功能：默认传输实现，优先走宿主注入的模式切换入口。入参：目标模式；返回：宿主返回的原始结果。 */
async function defaultTransport(target: FusionMode): Promise<unknown> {
  // 模式切换要结束并拉起进程，必须交给宿主专门注入的切换入口（宿主的 mode_switch 命令，由它调用切换脚本）。
  // 这里绝不把 mode.switch 塞进工作区 JSONL 传输层：那条桥只实现 workspace.*，
  // 会把参数当成相对路径去校验，最后回一个路径类错误给用户。
  const modeSwitch = window.__codexFusionModeSwitch__;
  if (typeof modeSwitch === 'function') {
    return modeSwitch(target);
  }
  // 兼容路径：宿主尚未提供模式切换入口时，Code-Codex 方向回退到既有的启动器注入点
  if (target === 'code-codex' && window.__codexFusionLaunchCodeCodex__) {
    return window.__codexFusionLaunchCodeCodex__();
  }
  throw new BridgeOperationError(
    NOT_CONNECTED,
    '当前运行环境没有接入模式切换宿主，无法切换运行模式。请在 Codex Fusion 桌面应用中使用该功能。',
  );
}

/** 切换选项 */
export interface RequestModeSwitchOptions {
  /** 确认函数，默认使用 window.confirm；测试可注入 */
  confirm?: (message: string) => boolean;
  /** 传输函数，默认走宿主传输层；测试可注入 */
  transport?: ModeSwitchTransport;
}

/**
 * 功能：在 UI 已确认后执行模式切换（不再弹出 window.confirm）。
 * 入参：目标模式与可选传输；返回：宿主归一化结果。
 * 边界：ThemeStudio 自建确认框确认后必须走本函数，避免与 requestModeSwitch 双重确认。
 */
export async function executeModeSwitch(
  target: FusionMode,
  options: { transport?: ModeSwitchTransport } = {},
): Promise<ModeSwitchResult> {
  const transport = options.transport ?? defaultTransport;
  return normalizeModeSwitchResult(await transport(target));
}

/**
 * 功能：请求一次模式切换。入参：目标模式与可选注入项；返回：切换结果（取消时返回本地构造的 cancelled 结果）。
 * 边界：用户拒绝确认时不会发出任何宿主请求，因此绝不可能发生切换。
 * 说明：带自建确认 UI 的调用方应改用 executeModeSwitch，本函数仅服务无 UI 确认的入口。
 */
export async function requestModeSwitch(
  target: FusionMode,
  options: RequestModeSwitchOptions = {},
): Promise<ModeSwitchResult> {
  const { title, message } = modeSwitchConfirmation(target);
  const confirm = options.confirm ?? ((text: string) => typeof window.confirm !== 'function' || window.confirm(text));
  if (!confirm(message)) {
    return {
      schemaVersion: 1,
      action: target === 'code-codex' ? 'switch-to-code-codex' : 'switch-to-dream-skin',
      mode: target === 'code-codex' ? 'dream-skin' : 'code-codex',
      outcome: 'cancelled',
      exitCode: 3,
      message: `${title}已取消，当前运行模式保持不变。`,
      timestamp: new Date().toISOString(),
    };
  }
  return executeModeSwitch(target, { transport: options.transport });
}

/** 功能：把切换结果转成可展示的文案与严重级别。入参：结果对象；返回：展示信息。 */
export function describeModeSwitchResult(result: ModeSwitchResult): {
  text: string;
  tone: 'success' | 'neutral' | 'warning';
} {
  switch (result.outcome) {
    case 'success':
      return { text: result.message || '模式切换完成。', tone: 'success' };
    case 'already-active':
      return { text: result.message || '目标模式已在运行，无需切换。', tone: 'neutral' };
    case 'cancelled':
      return { text: result.message || '已取消切换。', tone: 'neutral' };
    case 'rollback':
      return { text: result.message || '切换失败，已恢复原来的模式。', tone: 'warning' };
    case 'partial':
      return { text: result.message || '已切换，但效果校验未通过。', tone: 'warning' };
    default:
      return { text: result.message || '模式切换失败。', tone: 'warning' };
  }
}

/**
 * 上次切换的结论形态。
 *
 * `interrupted` 是切换脚本开工时留下的「进行中」标记：脚本开跑了却没走到结束
 * （例如切换途中把窗口关掉）。它与「从未切换过」必须区分开，
 * 否则用户会以为那两次点击什么都没发生。
 */
export interface LastSwitchOutcome {
  /** 是否有可用的历史结论 */
  present: boolean;
  /** 是否停在「进行中」——即上次切换没有跑完 */
  interrupted: boolean;
  result: ModeSwitchResult | null;
}

/**
 * 功能：读取上一次模式切换的结论。入参：可选注入函数（测试用）；返回：历史结论。
 * 边界：宿主未接入或读取失败时返回 present=false，绝不编造结论。
 */
export async function readLastSwitchOutcome(
  reader?: () => Promise<unknown>,
): Promise<LastSwitchOutcome> {
  const load = reader ?? (typeof window !== 'undefined' ? window.__codexFusionLastSwitchOutcome__ : undefined);
  if (typeof load !== 'function') {
    return { present: false, interrupted: false, result: null };
  }
  try {
    const raw = await load();
    if (!raw || typeof raw !== 'object') {
      return { present: false, interrupted: false, result: null };
    }
    const record = raw as Record<string, unknown>;
    if (record.present !== true) {
      return { present: false, interrupted: false, result: null };
    }
    return {
      present: true,
      interrupted: record.interrupted === true,
      result: normalizeModeSwitchResult(record),
    };
  } catch {
    // 历史结论读不到不该影响主题页与工作区使用。
    return { present: false, interrupted: false, result: null };
  }
}

/**
 * 功能：决定启动时该向用户显示哪一条提示。入参：上次切换结论 + 启动自检结果；返回：提示或 null。
 * 边界：最多只显示一条，避免两条提示互相干扰。取舍顺序是——
 *       1. 自检本身是告警类（被阻止 / 失败 / 回滚）：这是用户需要动手处理的，优先；
 *       2. 上次切换没跑完：直接回答「我点的切换怎么没反应」；
 *       3. 自检成功进入 Dream Skin：值得说一句；
 *       4. 本来就在 Dream Skin：常态，不打扰。
 */
export function pickStartupNotice(
  last: LastSwitchOutcome | null,
  ensureResult: ModeSwitchResult | null,
): { text: string; tone: 'success' | 'neutral' | 'warning' } | null {
  const ensureNotice = ensureResult ? describeModeSwitchResult(ensureResult) : null;
  const lastNotice = last ? describeLastSwitchOutcome(last) : null;

  if (ensureNotice && ensureNotice.tone === 'warning') {
    return ensureNotice;
  }
  if (lastNotice) {
    return lastNotice;
  }
  if (ensureNotice && ensureResult && ensureResult.outcome !== 'already-active') {
    return ensureNotice;
  }
  return null;
}

/** 功能：把当前运行模式转成中文显示名。入参：模式；返回：显示名。 */
export function modeName(mode: string): string {
  if (mode === 'dream-skin') return 'Dream Skin 模式';
  if (mode === 'code-codex') return 'Code-Codex 模式';
  return '未知模式';
}

/**
 * 功能：把「上次切换结论」转成启动提示文案。入参：历史结论；返回：展示信息或 null（无需提示）。
 * 边界：只有「中途被中断」这种情况需要在下一次启动时提醒用户，
 *       正常成功的切换不值得打扰，从没切换过也没有可说的。
 */
export function describeLastSwitchOutcome(
  last: LastSwitchOutcome,
): { text: string; tone: 'success' | 'neutral' | 'warning' } | null {
  if (!last.present || !last.interrupted) {
    return null;
  }
  return {
    text: '上次模式切换没有跑完就被中断了（通常是切换过程中关闭了窗口），运行模式可能停在中间状态。建议重新执行一次切换以确认当前模式。',
    tone: 'warning',
  };
}
