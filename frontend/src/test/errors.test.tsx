import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWorkspace } from './helpers';

describe('错误显示', () => {
  it('预览无权限文件时如实展示桥接错误码与消息', async () => {
    renderWorkspace();
    const user = userEvent.setup();
    await user.click(await screen.findByLabelText('locked.txt（无权限访问）'));
    expect(await screen.findByText('ACCESS_DENIED')).toBeInTheDocument();
    expect(screen.getByText(/无权限读取/)).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('新建文件名称非法时在对话框内展示桥接错误', async () => {
    renderWorkspace();
    const user = userEvent.setup();
    await user.click(screen.getByLabelText('新建文件'));
    const input = await screen.findByPlaceholderText('名称（不含路径）');
    await user.type(input, 'bad/name');
    await user.click(screen.getByRole('button', { name: '创建' }));
    expect(await screen.findByText('INVALID_NAME')).toBeInTheDocument();
    // 对话框保持打开，可修正后重试
    expect(screen.getByPlaceholderText('名称（不含路径）')).toBeInTheDocument();
  });
});
