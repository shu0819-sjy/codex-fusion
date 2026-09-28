import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWorkspace } from './helpers';

describe('文件操作（新建 / 重命名 / 移动 / 复制 / 删除）', () => {
  it('新建文件后出现在树中并自动打开', async () => {
    const bridge = renderWorkspace();
    const user = userEvent.setup();
    await user.click(await screen.findByLabelText('新建文件'));
    const input = await screen.findByPlaceholderText('名称（不含路径）');
    await user.type(input, 'newfile.txt');
    await user.click(screen.getByRole('button', { name: '创建' }));

    expect((await screen.findAllByText('newfile.txt')).length).toBeGreaterThan(0);
    expect(bridge.hasEntry('newfile.txt')).toBe(true);
    // 新文件自动打开为空内容
    const textarea = await screen.findByRole('textbox');
    expect((textarea as HTMLTextAreaElement).value).toBe('');
  });

  it('新建目录后可在其中创建空目录提示', async () => {
    const bridge = renderWorkspace();
    const user = userEvent.setup();
    await user.click(screen.getByLabelText('新建目录'));
    const input = await screen.findByPlaceholderText('名称（不含路径）');
    await user.type(input, 'newdir');
    await user.click(screen.getByRole('button', { name: '创建' }));

    expect(await screen.findByText('newdir')).toBeInTheDocument();
    expect(bridge.hasEntry('newdir')).toBe(true);
    await user.click(screen.getByLabelText('展开 newdir'));
    expect(await screen.findByText('（空目录）')).toBeInTheDocument();
  });

  it('重命名后条目路径更新，打开的编辑器跟随新路径', async () => {
    const bridge = renderWorkspace();
    const user = userEvent.setup();
    await user.click(await screen.findByLabelText('notes.txt'));
    expect(await screen.findByRole('textbox')).toBeInTheDocument();

    await user.click(screen.getByLabelText('重命名'));
    const input = await screen.findByDisplayValue('notes.txt');
    await user.clear(input);
    await user.type(input, 'renamed.txt');
    const renameDialog = screen.getByRole('dialog');
    await user.click(within(renameDialog).getByRole('button', { name: '重命名' }));

    expect((await screen.findAllByText('renamed.txt')).length).toBeGreaterThan(0);
    expect(bridge.hasEntry('notes.txt')).toBe(false);
    expect(bridge.hasEntry('renamed.txt')).toBe(true);
  });

  it('移动到目录后旧路径消失、新路径出现', async () => {
    const bridge = renderWorkspace();
    const user = userEvent.setup();
    await user.click(await screen.findByLabelText('notes.txt'));
    await user.click(screen.getByLabelText('移动'));
    const input = await screen.findByPlaceholderText('留空表示工作区根目录');
    await user.type(input, 'src');
    const moveDialog = screen.getByRole('dialog');
    await user.click(within(moveDialog).getByRole('button', { name: '移动' }));

    expect(bridge.hasEntry('notes.txt')).toBe(false);
    expect(bridge.hasEntry('src/notes.txt')).toBe(true);
    // 根目录不再有该条目行（标签页中的同名文本不属于树节点）
    expect(screen.queryByLabelText('notes.txt')).toBeNull();
    await user.click(screen.getByLabelText('展开 src'));
    expect(await screen.findByLabelText('notes.txt')).toBeInTheDocument();
  });

  it('复制到目录后原文件保留且副本出现', async () => {
    const bridge = renderWorkspace();
    const user = userEvent.setup();
    await user.click(await screen.findByLabelText('notes.txt'));
    await user.click(screen.getByLabelText('复制'));
    const input = await screen.findByPlaceholderText('留空表示工作区根目录');
    await user.type(input, 'assets');
    const copyDialog = screen.getByRole('dialog');
    await user.click(within(copyDialog).getByRole('button', { name: '复制' }));

    expect(bridge.hasEntry('notes.txt')).toBe(true);
    expect(bridge.hasEntry('assets/notes.txt')).toBe(true);
    await user.click(screen.getByLabelText('展开 assets'));
    expect((await screen.findAllByText('notes.txt')).length).toBeGreaterThanOrEqual(2);
  });

  it('删除非空目录时展示桥接错误且不删除', async () => {
    const bridge = renderWorkspace();
    const user = userEvent.setup();
    await user.click(await screen.findByLabelText('src'));
    await user.click(screen.getByLabelText('删除'));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: '删除' }));

    expect(await screen.findByText('NOT_EMPTY')).toBeInTheDocument();
    expect(bridge.hasEntry('src')).toBe(true);
  });
});
