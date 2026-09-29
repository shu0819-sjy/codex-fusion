import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ThemeStudio } from '../components/ThemeStudio';

const themePayload = {
  themes: [
    {
      id: 'theme-one', name: '夜航', image: 'night.jpg', hasImage: true, imageSize: '512 KB',
      imageDims: '1920 x 1080', appearance: 'dark', created: '2026-09-11', hasTagline: true, isActive: true,
    },
  ],
  active: '夜航',
  skinConnected: true,
  codexStatus: 'running_cdp',
  codexMessage: '已连接调试端口',
};

afterEach(() => {
  delete window.__codexFusionThemeRequest__;
});

/** 功能：渲染主题页并等待首屏加载完成；入参：可选切换回调与当前模式；返回：userEvent 实例。
 *  模式切换测试显式启用 Code-Codex 入口（生产默认隐藏）。 */
async function renderStudio(
  onRequestModeSwitch: (target: 'dream-skin' | 'code-codex') => Promise<unknown>,
  activeMode: 'dream-skin' | 'code-codex' | 'unknown' = 'dream-skin',
) {
  window.__codexFusionThemeRequest__ = vi.fn(async () => themePayload);
  const user = userEvent.setup();
  render(<ThemeStudio onRequestModeSwitch={onRequestModeSwitch as never} activeMode={activeMode} enableCodeCodex />);
  await screen.findByRole('heading', { name: '夜航' });
  return user;
}

describe('模式切换 UI', () => {
  it('点击切换到 Code-Codex 先弹出确认对话框并警告未保存内容可能丢失', async () => {
    const onRequestModeSwitch = vi.fn(async () => ({ outcome: 'success', message: '已切换到 Code-Codex 模式。' }));
    const user = await renderStudio(onRequestModeSwitch);

    await user.click(screen.getByRole('button', { name: /切换到 Code-Codex/ }));

    const dialog = await screen.findByRole('dialog', { name: '切换到 Code-Codex' });
    expect(dialog).toHaveTextContent('未保存的内容可能丢失');
    expect(dialog).toHaveTextContent('只关闭 Dream Skin 自己管理的进程');
    expect(onRequestModeSwitch).not.toHaveBeenCalled();
  });

  it('用户在确认对话框里取消时不会切换', async () => {
    const onRequestModeSwitch = vi.fn(async () => ({ outcome: 'success' }));
    const user = await renderStudio(onRequestModeSwitch);

    await user.click(screen.getByRole('button', { name: /切换到 Code-Codex/ }));
    await screen.findByRole('dialog', { name: '切换到 Code-Codex' });
    await user.click(screen.getByRole('button', { name: '取消' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(onRequestModeSwitch).not.toHaveBeenCalled();
  });

  it('用户确认后提交切换请求并展示结果', async () => {
    const onRequestModeSwitch = vi.fn(async () => ({
      outcome: 'success',
      message: '已切换到 Code-Codex 模式。',
      mode: 'code-codex',
    }));
    const user = await renderStudio(onRequestModeSwitch);

    await user.click(screen.getByRole('button', { name: /切换到 Code-Codex/ }));
    await screen.findByRole('dialog', { name: '切换到 Code-Codex' });
    await user.click(screen.getByRole('button', { name: '切换到Code-Codex 模式' }));

    await waitFor(() => expect(onRequestModeSwitch).toHaveBeenCalledWith('code-codex'));
    expect(await screen.findByText('已切换到 Code-Codex 模式。')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('切回 Dream Skin 时同样先确认并说明会校验壁纸效果', async () => {
    const onRequestModeSwitch = vi.fn(async () => ({
      outcome: 'success',
      message: '已恢复 Dream Skin 模式。',
      mode: 'dream-skin',
    }));
    // 当前已在 Code-Codex 时，「切回 Dream Skin」才是可点的主操作（V3）
    const user = await renderStudio(onRequestModeSwitch, 'code-codex');

    await user.click(screen.getByRole('button', { name: /切回 Dream Skin/ }));

    const dialog = await screen.findByRole('dialog', { name: '切换回 Dream Skin' });
    expect(dialog).toHaveTextContent('CDP 端口与壁纸效果');
    await user.click(screen.getByRole('button', { name: '切换到Dream Skin 模式' }));

    await waitFor(() => expect(onRequestModeSwitch).toHaveBeenCalledWith('dream-skin'));
  });

  it('确认对话框确认后只提交一次切换请求，不再套 window.confirm', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm');
    const onRequestModeSwitch = vi.fn(async () => ({
      outcome: 'success',
      message: '已切换到 Code-Codex 模式。',
      mode: 'code-codex',
    }));
    const user = await renderStudio(onRequestModeSwitch);

    await user.click(screen.getByRole('button', { name: /切换到 Code-Codex/ }));
    await screen.findByRole('dialog', { name: '切换到 Code-Codex' });
    await user.click(screen.getByRole('button', { name: '切换到Code-Codex 模式' }));

    await waitFor(() => expect(onRequestModeSwitch).toHaveBeenCalledTimes(1));
    expect(confirmSpy).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it('切换失败时如实展示失败原因，不谎报成功', async () => {
    const onRequestModeSwitch = vi.fn(async () => ({
      outcome: 'failed',
      message: 'Code-Codex 启动失败，已恢复 Dream Skin。',
      mode: 'dream-skin',
    }));
    const user = await renderStudio(onRequestModeSwitch);

    await user.click(screen.getByRole('button', { name: /切换到 Code-Codex/ }));
    await screen.findByRole('dialog', { name: '切换到 Code-Codex' });
    await user.click(screen.getByRole('button', { name: '切换到Code-Codex 模式' }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Code-Codex 启动失败，已恢复 Dream Skin。'));
  });

  it('切换被阻止（存在其他不允许关闭的 Codex 会话）时展示宿主给的阻止原因', async () => {
    const onRequestModeSwitch = vi.fn(async () => {
      throw new Error('切换被阻止：检测到非 Dream Skin 管理的 Codex 会话。');
    });
    const user = await renderStudio(onRequestModeSwitch);

    await user.click(screen.getByRole('button', { name: /切换到 Code-Codex/ }));
    await screen.findByRole('dialog', { name: '切换到 Code-Codex' });
    await user.click(screen.getByRole('button', { name: '切换到Code-Codex 模式' }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('切换被阻止：检测到非 Dream Skin 管理的 Codex 会话。'));
  });

  it('上一次切换中途被中断时，启动就要把这件事告诉用户', async () => {
    window.__codexFusionThemeRequest__ = vi.fn(async () => themePayload);
    render(
      <ThemeStudio
        startupNotice={{
          text: '上次模式切换没有跑完就被中断了（通常是切换过程中关闭了窗口），运行模式可能停在中间状态。',
          tone: 'warning',
        }}
      />,
    );

    // 顶栏 Mode+CDP 芯片也是 role=status，启动提示用文案定位避免歧义
    expect(await screen.findByText(/上次模式切换没有跑完就被中断了/)).toBeInTheDocument();
  });

  it('默认隐藏全部模式入口（工作区/切回/切换到 Code-Codex，仅显式启用才显示）', async () => {
    const onRequestModeSwitch = vi.fn(async () => ({ outcome: 'success' }));
    window.__codexFusionThemeRequest__ = vi.fn(async () => themePayload);
    const user = userEvent.setup();
    render(<ThemeStudio onRequestModeSwitch={onRequestModeSwitch as never} activeMode="dream-skin" />);
    await screen.findByRole('heading', { name: '夜航' });

    expect(screen.queryByRole('button', { name: /切换到 Code-Codex/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Dream Skin · 当前/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /工作区/ })).not.toBeInTheDocument();
    // 状态指示（品牌标题 + mode chip）仍保留
    expect(screen.getAllByText(/Dream Skin/).length).toBeGreaterThan(0);
    void user;
  });
});
