import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWorkspace } from './helpers';

describe('删除确认', () => {
  it('取消不删除，确认后条目从树中移除且编辑器关闭', async () => {
    const bridge = renderWorkspace();
    const user = userEvent.setup();

    // 打开 notes.txt 进入编辑器
    await user.click(await screen.findByLabelText('notes.txt'));
    expect(await screen.findByRole('textbox')).toBeInTheDocument();

    // 触发删除 → 确认对话框出现
    await user.click(screen.getByLabelText('删除'));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('删除确认')).toBeInTheDocument();

    // 取消：不删除
    await user.click(within(dialog).getByRole('button', { name: '取消' }));
    expect(bridge.hasEntry('notes.txt')).toBe(true);

    // 再次删除并确认
    await user.click(screen.getByLabelText('删除'));
    const dialogAgain = await screen.findByRole('dialog');
    await user.click(within(dialogAgain).getByRole('button', { name: '删除' }));

    await waitFor(() => expect(bridge.hasEntry('notes.txt')).toBe(false));
    expect(screen.queryByText('notes.txt')).toBeNull();
    expect(screen.getByText('从左侧文件树选择一个文件开始')).toBeInTheDocument();
  });
});
