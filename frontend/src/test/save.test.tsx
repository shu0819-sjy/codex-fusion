import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWorkspace } from './helpers';

describe('正常保存', () => {
  it('无修改时保存按钮禁用，编辑后可保存', async () => {
    renderWorkspace();
    const user = userEvent.setup();
    await user.click(await screen.findByLabelText('README.md'));
    const saveButton = await screen.findByLabelText('保存');
    expect(saveButton).toBeDisabled();
    const textarea = await screen.findByRole('textbox');
    await user.clear(textarea);
    await user.type(textarea, '修改后的内容');
    expect(screen.getByLabelText('保存')).toBeEnabled();
  });

  it('保存后内容写入桥接层且版本号递增、未保存标记消失', async () => {
    const bridge = renderWorkspace();
    const user = userEvent.setup();
    await user.click(await screen.findByLabelText('README.md'));
    const textarea = await screen.findByRole('textbox');
    await user.clear(textarea);
    await user.type(textarea, '保存后的新内容');
    await user.click(screen.getByLabelText('保存'));

    await waitFor(() => expect(screen.queryAllByText('未保存的更改')).toHaveLength(0));
    const result = await bridge.preview({ relativePath: 'README.md' });
    expect(result.text).toBe('保存后的新内容');
    expect(result.version).toBe('v2');
  });
});
