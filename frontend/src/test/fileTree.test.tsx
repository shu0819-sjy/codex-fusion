import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWorkspace } from './helpers';

describe('文件树', () => {
  it('延迟展开目录并显示子项与加载结果', async () => {
    renderWorkspace();
    const user = userEvent.setup();

    // 初始仅显示根级条目，子项未加载
    expect(await screen.findByText('src')).toBeInTheDocument();
    expect(screen.queryByText('app.ts')).toBeNull();

    // 展开 src：出现 app.ts 与 utils
    await user.click(screen.getByLabelText('展开 src'));
    expect(await screen.findByText('app.ts')).toBeInTheDocument();
    expect(screen.getByText('utils')).toBeInTheDocument();

    // 展开 utils：出现 format.ts / parse.ts
    await user.click(screen.getByLabelText('展开 utils'));
    expect(await screen.findByText('format.ts')).toBeInTheDocument();
    expect(screen.getByText('parse.ts')).toBeInTheDocument();
  });

  it('空目录展开后显示提示', async () => {
    renderWorkspace();
    const user = userEvent.setup();
    await user.click(await screen.findByLabelText('展开 empty'));
    expect(await screen.findByText('（空目录）')).toBeInTheDocument();
  });

  it('无权限目录显示锁标记且不提供展开按钮', async () => {
    renderWorkspace();
    expect(await screen.findByRole('button', { name: 'restricted（无权限访问）' })).toBeInTheDocument();
    expect(screen.getAllByLabelText('无权限访问').length).toBeGreaterThan(0);
    expect(screen.queryByLabelText('展开 restricted')).toBeNull();
  });

  it('隐藏项默认不显示，开启开关后出现', async () => {
    renderWorkspace();
    const user = userEvent.setup();
    expect(screen.queryByText('.gitignore')).toBeNull();
    await user.click(screen.getByLabelText('显示隐藏项'));
    expect(await screen.findByText('.gitignore')).toBeInTheDocument();
  });
});
