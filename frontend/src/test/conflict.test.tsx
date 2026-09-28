import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWorkspace } from './helpers';

describe('版本冲突', () => {
  it('冲突时保留草稿，另存为副本写入新文件', async () => {
    const bridge = renderWorkspace();
    const user = userEvent.setup();
    await user.click(await screen.findByLabelText('README.md'));
    const textarea = await screen.findByRole('textbox');
    await user.clear(textarea);
    await user.type(textarea, '我的本地草稿');

    // 模拟另一个进程修改了同一文件
    bridge.simulateExternalSave('README.md', '外部进程写入的内容');
    await user.click(screen.getByLabelText('保存'));

    // 冲突对话框出现，草稿仍在编辑器中
    expect(await screen.findByText('版本冲突')).toBeInTheDocument();
    expect(screen.getByRole('textbox')).toHaveValue('我的本地草稿');

    // 另存为副本：草稿写入新文件并打开
    await user.click(screen.getByRole('button', { name: '另存为副本' }));
    expect((await screen.findAllByText('README-copy.md')).length).toBeGreaterThan(0);
    expect(screen.getByRole('textbox')).toHaveValue('我的本地草稿');

    const copy = await bridge.preview({ relativePath: 'README-copy.md' });
    expect(copy.text).toBe('我的本地草稿');
    const original = await bridge.preview({ relativePath: 'README.md' });
    expect(original.text).toBe('外部进程写入的内容');
  });

  it('冲突时重新加载会放弃草稿并加载最新内容', async () => {
    const bridge = renderWorkspace();
    const user = userEvent.setup();
    await user.click(await screen.findByLabelText('README.md'));
    const textarea = await screen.findByRole('textbox');
    await user.clear(textarea);
    await user.type(textarea, '我的本地草稿');

    bridge.simulateExternalSave('README.md', '外部进程写入的内容');
    await user.click(screen.getByLabelText('保存'));
    await screen.findByText('版本冲突');

    await user.click(screen.getByRole('button', { name: '重新加载' }));
    await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue('外部进程写入的内容'));
  });
});
