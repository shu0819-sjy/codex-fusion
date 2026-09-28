import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ThemeStudio } from '../components/ThemeStudio';

const themePayload = {
  themes: [
    {
      id: 'theme-one', name: '夜航', image: 'night.jpg', hasImage: true, imageSize: '512 KB',
      imageDims: '1920 x 1080', appearance: 'dark', created: '2026-09-11', hasTagline: true, isActive: false,
    },
    {
      id: 'theme-two', name: '当前主题', image: 'active.jpg', hasImage: true, imageSize: '256 KB',
      imageDims: '', appearance: 'auto', created: '2026-09-10', hasTagline: false, isActive: true,
    },
  ],
  active: '当前主题',
  skinConnected: false,
  codexStatus: 'running_no_cdp',
  codexMessage: '等待调试端口',
};

afterEach(() => {
  delete window.__codexFusionThemeRequest__;
});

describe('壁纸主题工作台', () => {
  it('加载并显示主题列表与选中主题预览', async () => {
    window.__codexFusionThemeRequest__ = vi.fn(async () => themePayload);

    render(<ThemeStudio />);

    expect(await screen.findByRole('heading', { name: '夜航' })).toBeInTheDocument();
    // 未连接（skinConnected=false）且 Codex 报出未开调试端口时，状态栏必须提示需要先连接调试端口
    expect(screen.getByText(/没有调试端口/)).toBeInTheDocument();
    expect(screen.getByText('使用中')).toBeInTheDocument();
  });

  it('点击应用到 Codex 后显示成功反馈并刷新活动状态', async () => {
    const request = vi.fn(async (_method: 'GET' | 'POST', path: string) => {
      if (path === '/api/themes') return themePayload;
      return { ok: true };
    });
    window.__codexFusionThemeRequest__ = request;
    const user = userEvent.setup();

    render(<ThemeStudio />);
    await screen.findByRole('heading', { name: '夜航' });
    await user.click(screen.getByRole('button', { name: /^应用到 Codex$/ }));

    await waitFor(() => expect(screen.getByText('已应用到 Codex：夜航')).toBeInTheDocument());
    expect(request).toHaveBeenCalledWith('POST', '/api/themes/apply', { id: 'theme-one' });
  });

  it('切换内置动态效果并显示效果库', async () => {
    const request = vi.fn(async (_method: 'GET' | 'POST', path: string) => {
      if (path === '/api/themes') return themePayload;
      if (path === '/api/effect/current') return { ok: true, effect: 'none', name: null };
      if (path === '/api/effects') return { effects: [{ id: 'rain-heavy', name: '倾盆大雨', type: 'rain', description: '持续雨幕' }] };
      if (path === '/api/effect') return { ok: true, effect: 'snow' };
      return { ok: true };
    });
    window.__codexFusionThemeRequest__ = request;
    const user = userEvent.setup();

    render(<ThemeStudio />);
    await screen.findByRole('heading', { name: '夜航' });
    expect(await screen.findByRole('button', { name: /倾盆大雨/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /关闭效果/ })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /飘雪/ }));

    await waitFor(() => expect(screen.getByText('已切换动态效果：飘雪')).toBeInTheDocument());
    expect(request).toHaveBeenCalledWith('POST', '/api/effect', {
      effect: 'snow',
      config: { preset: 'snow-light', count: 70, speed: 0.88, opacity: 0.68, sizeMin: 1.1, sizeMax: 5.2, wind: 0.22, swing: 0.48 },
    });
    expect(screen.getByTitle('夜航 动态效果预览')).toBeInTheDocument();
  });

  it('可通过关闭效果取消动态效果', async () => {
    const request = vi.fn(async (_method: 'GET' | 'POST', path: string, body?: unknown) => {
      if (path === '/api/themes') return themePayload;
      if (path === '/api/effect/current') return { ok: true, effect: 'snow', name: null };
      if (path === '/api/effects') return { effects: [] };
      if (path === '/api/effect') {
        const effect = (body as { effect?: string } | undefined)?.effect ?? 'none';
        return { ok: true, effect };
      }
      return { ok: true };
    });
    window.__codexFusionThemeRequest__ = request;
    const user = userEvent.setup();

    render(<ThemeStudio />);
    await screen.findByRole('heading', { name: '夜航' });
    const clearButton = await screen.findByRole('button', { name: /关闭效果/ });
    expect(clearButton).not.toBeDisabled();
    await user.click(clearButton);

    await waitFor(() => expect(screen.getByText('已关闭动态效果')).toBeInTheDocument());
    expect(request).toHaveBeenCalledWith('POST', '/api/effect', { effect: 'none', config: {} });
  });

  it('非活动主题可删除，活动主题显示使用中标签', async () => {
    let themes = themePayload.themes;
    const request = vi.fn(async (_method: 'GET' | 'POST', path: string) => {
      if (path === '/api/themes') return { ...themePayload, themes };
      if (path === '/api/themes/delete') {
        themes = themes.filter((theme) => theme.id !== 'theme-one');
        return { ok: true };
      }
      return { ok: true };
    });
    window.__codexFusionThemeRequest__ = request;
    const user = userEvent.setup();

    render(<ThemeStudio />);
    await screen.findByRole('heading', { name: '夜航' });

    expect(screen.getByRole('button', { name: '删除 夜航' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '删除 当前主题' })).not.toBeInTheDocument();
    expect(screen.getByText('使用中')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '删除 夜航' }));
    expect(screen.getByRole('dialog', { name: '删除主题' })).toBeInTheDocument();
    expect(screen.getByText(/确定删除这个主题吗/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '删除主题' }));

    await waitFor(() => expect(screen.getByText('已删除主题：夜航')).toBeInTheDocument());
    expect(request).toHaveBeenCalledWith('POST', '/api/themes/delete', { id: 'theme-one' });
  });

  it('支持按名称搜索主题', async () => {
    window.__codexFusionThemeRequest__ = vi.fn(async () => themePayload);
    const user = userEvent.setup();

    render(<ThemeStudio />);
    await screen.findByRole('heading', { name: '夜航' });
    await user.type(screen.getByPlaceholderText('搜索主题名称'), '当前');

    expect(screen.queryByRole('button', { name: '删除 夜航' })).not.toBeInTheDocument();
    expect(screen.getByText('使用中')).toBeInTheDocument();
  });
});
