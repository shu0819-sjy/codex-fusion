import { describe, expect, it, vi } from 'vitest';
import {
  describeLastSwitchOutcome,
  describeModeSwitchResult,
  executeModeSwitch,
  modeSwitchConfirmation,
  normalizeModeSwitchResult,
  pickStartupNotice,
  readLastSwitchOutcome,
  requestModeSwitch,
} from '../bridge/modeSwitch';

describe('模式切换协议层', () => {
  it('两个方向的确认文案都必须提示未保存内容可能丢失', () => {
    for (const target of ['code-codex', 'dream-skin'] as const) {
      const { title, message } = modeSwitchConfirmation(target);
      expect(title.length).toBeGreaterThan(0);
      expect(message).toContain('未保存的内容可能丢失');
      expect(message).toContain('其他 Codex');
    }
  });

  it('切换回 Dream Skin 的文案说明会校验 CDP 端口与壁纸效果', () => {
    expect(modeSwitchConfirmation('dream-skin').message).toContain('CDP 端口与壁纸效果');
  });

  it('用户取消时不发出任何宿主请求，也不会发生切换', async () => {
    const transport = vi.fn(async () => ({ outcome: 'success' }));

    const result = await requestModeSwitch('code-codex', { confirm: () => false, transport });

    expect(transport).not.toHaveBeenCalled();
    expect(result.outcome).toBe('cancelled');
    expect(result.exitCode).toBe(3);
    expect(result.mode).toBe('dream-skin');
  });

  it('用户确认后把请求交给宿主并归一化结果', async () => {
    const transport = vi.fn(async () => ({
      schemaVersion: 1,
      action: 'switch-to-code-codex',
      mode: 'code-codex',
      outcome: 'success',
      exitCode: 0,
      message: '已切换到 Code-Codex 模式。',
      timestamp: '2026-09-12T00:00:00.000Z',
    }));

    const result = await requestModeSwitch('code-codex', { confirm: () => true, transport });

    expect(transport).toHaveBeenCalledWith('code-codex');
    expect(result.outcome).toBe('success');
    expect(result.mode).toBe('code-codex');
  });

  it('宿主未接入切换能力时明确报错，不伪造成功', async () => {
    const originalTransport = window.__codexFusionTransport__;
    const originalLauncher = window.__codexFusionLaunchCodeCodex__;
    const originalModeSwitch = window.__codexFusionModeSwitch__;
    delete window.__codexFusionTransport__;
    delete window.__codexFusionLaunchCodeCodex__;
    delete window.__codexFusionModeSwitch__;
    try {
      await expect(requestModeSwitch('dream-skin', { confirm: () => true })).rejects.toMatchObject({
        code: 'NOT_CONNECTED',
      });
    } finally {
      if (originalTransport) window.__codexFusionTransport__ = originalTransport;
      if (originalLauncher) window.__codexFusionLaunchCodeCodex__ = originalLauncher;
      if (originalModeSwitch) window.__codexFusionModeSwitch__ = originalModeSwitch;
    }
  });

  it('切换必须走宿主注入的模式切换入口，绝不塞进工作区 JSONL 传输层', async () => {
    const originalTransport = window.__codexFusionTransport__;
    const originalModeSwitch = window.__codexFusionModeSwitch__;
    // 工作区桥只实现 workspace.*：一旦 mode.switch 被塞进去，就会拿到路径类错误。
    const transport = vi.fn(async () => ({
      id: 'x',
      ok: false,
      result: null,
      error: { code: 'InvalidPath', message: 'The relative path is invalid.' },
    }));
    const modeSwitch = vi.fn(async () => ({
      schemaVersion: 1,
      action: 'switch-to-code-codex',
      mode: 'code-codex',
      outcome: 'success',
      exitCode: 0,
      message: '已切换到 Code-Codex 模式。',
      timestamp: '2026-09-12T00:00:00.000Z',
    }));
    window.__codexFusionTransport__ = transport;
    window.__codexFusionModeSwitch__ = modeSwitch;
    try {
      const result = await requestModeSwitch('code-codex', { confirm: () => true });

      expect(modeSwitch).toHaveBeenCalledWith('code-codex');
      expect(transport).not.toHaveBeenCalled();
      expect(result.outcome).toBe('success');
    } finally {
      if (originalTransport) window.__codexFusionTransport__ = originalTransport;
      else delete window.__codexFusionTransport__;
      if (originalModeSwitch) window.__codexFusionModeSwitch__ = originalModeSwitch;
      else delete window.__codexFusionModeSwitch__;
    }
  });

  it('宿主的模式切换入口报错时如实上报，不伪装成成功', async () => {
    const originalModeSwitch = window.__codexFusionModeSwitch__;
    window.__codexFusionModeSwitch__ = vi.fn(async () => {
      throw new Error('模式切换脚本执行失败');
    });
    try {
      await expect(requestModeSwitch('dream-skin', { confirm: () => true })).rejects.toThrowError(
        /模式切换脚本执行失败/,
      );
    } finally {
      if (originalModeSwitch) window.__codexFusionModeSwitch__ = originalModeSwitch;
      else delete window.__codexFusionModeSwitch__;
    }
  });

  it('拒绝格式非法的宿主返回值', () => {
    expect(() => normalizeModeSwitchResult(null)).toThrowError(/格式不合法/);
    expect(() => normalizeModeSwitchResult({ hello: 'world' })).toThrowError(/缺少 outcome/);
  });

  it('上次切换停在「进行中」时必须被识别为中断，而不是当成没切换过', async () => {
    const load = vi.fn(async () => ({
      present: true,
      interrupted: true,
      schemaVersion: 1,
      action: 'switch-to-dream-skin',
      mode: 'unknown',
      outcome: 'running',
      exitCode: 0,
      message: '切换正在进行，尚未得出结果。',
      timestamp: '2026-09-12T00:00:00.000Z',
    }));

    const last = await readLastSwitchOutcome(load as unknown as () => Promise<unknown>);

    expect(last.present).toBe(true);
    expect(last.interrupted).toBe(true);
    const notice = describeLastSwitchOutcome(last);
    expect(notice?.tone).toBe('warning');
    expect(notice?.text).toContain('没有跑完');
  });

  it('没有历史结论时不产生任何启动提示', async () => {
    const load = vi.fn(async () => ({ present: false }));

    const last = await readLastSwitchOutcome(load as unknown as () => Promise<unknown>);

    expect(last.present).toBe(false);
    expect(describeLastSwitchOutcome(last)).toBeNull();
  });

  it('跑完的正常结论不产生启动提示（不打扰用户）', async () => {
    const load = vi.fn(async () => ({
      present: true,
      interrupted: false,
      schemaVersion: 1,
      action: 'switch-to-code-codex',
      mode: 'code-codex',
      outcome: 'success',
      exitCode: 0,
      message: '已切换到 Code-Codex。',
      timestamp: '2026-09-12T00:00:00.000Z',
    }));

    const last = await readLastSwitchOutcome(load as unknown as () => Promise<unknown>);

    expect(last.interrupted).toBe(false);
    expect(describeLastSwitchOutcome(last)).toBeNull();
  });

  it('宿主没有提供历史结论入口时静默降级，不编造结论', async () => {
    const original = window.__codexFusionLastSwitchOutcome__;
    delete window.__codexFusionLastSwitchOutcome__;
    try {
      const last = await readLastSwitchOutcome();
      expect(last.present).toBe(false);
      expect(last.result).toBeNull();
    } finally {
      if (original) window.__codexFusionLastSwitchOutcome__ = original;
    }
  });

  it('历史结论读取抛错时静默降级，不影响应用启动', async () => {
    const load = vi.fn(async () => {
      throw new Error('宿主不可用');
    });

    const last = await readLastSwitchOutcome(load as unknown as () => Promise<unknown>);

    expect(last.present).toBe(false);
  });

  it('启动提示最多一条：自检告警优先于中断提示，中断提示优先于常态说明', () => {
    const last = {
      present: true,
      interrupted: true,
      result: null,
    } as unknown as Parameters<typeof describeLastSwitchOutcome>[0];
    const base = {
      schemaVersion: 1,
      action: 'mode.switch',
      mode: 'dream-skin' as const,
      exitCode: 0,
      message: '',
      timestamp: '2026-09-12T00:00:00.000Z',
    };
    const blocked = { ...base, outcome: 'blocked' as const, message: 'Code-Codex 正在运行，未做改动。' };
    const entered = { ...base, outcome: 'success' as const, message: '已进入 Dream Skin。' };

    // 自检被阻止：用户需要动手处理，优先
    expect(pickStartupNotice(last, blocked)?.text).toBe('Code-Codex 正在运行，未做改动。');
    // 否则用中断提示回答「点了切换怎么没反应」
    expect(pickStartupNotice(last, entered)?.text).toContain('没有跑完');
    // 没有中断时，成功进入 Dream Skin 值得说一句
    expect(pickStartupNotice(null, entered)?.text).toBe('已进入 Dream Skin。');
    // 常态（本来就在 Dream Skin）不打扰
    expect(pickStartupNotice(null, { ...base, outcome: 'already-active' })).toBeNull();
    // 什么都没有时也不显示空提示
    expect(pickStartupNotice(null, null)).toBeNull();
  });

  it('把各类结果转成如实的展示文案', () => {
    const base = {
      schemaVersion: 1,
      action: 'mode.switch',
      mode: 'dream-skin' as const,
      exitCode: 0,
      message: '',
      timestamp: '2026-09-12T00:00:00.000Z',
    };

    expect(describeModeSwitchResult({ ...base, outcome: 'success' })).toEqual({
      text: '模式切换完成。',
      tone: 'success',
    });
    expect(describeModeSwitchResult({ ...base, outcome: 'already-active' }).tone).toBe('neutral');
    expect(describeModeSwitchResult({ ...base, outcome: 'rollback' })).toEqual({
      text: '切换失败，已恢复原来的模式。',
      tone: 'warning',
    });
    expect(describeModeSwitchResult({ ...base, outcome: 'failed', message: 'Code-Codex 启动失败' })).toEqual({
      text: 'Code-Codex 启动失败',
      tone: 'warning',
    });
  });

  it('ensure 的 outcome=ready 归一化为 success，启动提示不得变成 warning', () => {
    const ready = normalizeModeSwitchResult({
      schemaVersion: 1,
      action: 'ensure-dream-skin-mode',
      mode: 'dream-skin',
      outcome: 'ready',
      exitCode: 0,
      message: 'Dream Skin 已就绪。',
      timestamp: '2026-09-12T00:00:00.000Z',
    });
    expect(ready.outcome).toBe('success');
    expect(describeModeSwitchResult(ready).tone).toBe('success');
    expect(pickStartupNotice(null, ready)?.tone).toBe('success');
  });

  it('executeModeSwitch 不再弹出确认，直接交给传输层', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm');
    const transport = vi.fn(async () => ({
      schemaVersion: 1,
      action: 'switch-to-code-codex',
      mode: 'code-codex',
      outcome: 'success',
      exitCode: 0,
      message: '已切换。',
      timestamp: '2026-09-12T00:00:00.000Z',
    }));

    const result = await executeModeSwitch('code-codex', { transport });

    expect(transport).toHaveBeenCalledWith('code-codex');
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(result.outcome).toBe('success');
    confirmSpy.mockRestore();
  });
});
