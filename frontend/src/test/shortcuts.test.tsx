import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWorkspace } from './helpers';

describe('快捷键', () => {
  it('Ctrl+S 保存当前草稿', async () => {
    const bridge = renderWorkspace();
    const user = userEvent.setup();
    await user.click(await screen.findByLabelText('README.md'));
    const textarea = await screen.findByRole('textbox');
    await user.clear(textarea);
    await user.type(textarea, '快捷键保存的内容');
    await user.keyboard('{Control>}s{/Control}');
    await waitFor(() => expect(screen.queryAllByText('未保存的更改')).toHaveLength(0));
    const result = await bridge.preview({ relativePath: 'README.md' });
    expect(result.text).toBe('快捷键保存的内容');
  });

  it('F2 打开重命名对话框并预填当前名称', async () => {
    renderWorkspace();
    const user = userEvent.setup();
    await user.click(await screen.findByLabelText('notes.txt'));
    await user.keyboard('{F2}');
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getByDisplayValue('notes.txt')).toBeInTheDocument();
  });

  it('Delete 打开删除确认对话框', async () => {
    renderWorkspace();
    const user = userEvent.setup();
    await user.click(await screen.findByLabelText('notes.txt'));
    await user.keyboard('{Delete}');
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });
});
