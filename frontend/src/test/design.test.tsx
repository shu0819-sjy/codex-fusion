import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWorkspace } from './helpers';

describe('设计走查：导航、图片交互与可访问性', () => {
  it('面包屑显示路径分段，点击目录段在树中定位并选中该目录', async () => {
    renderWorkspace();
    const user = userEvent.setup();
    await user.click(await screen.findByLabelText('展开 src'));
    await user.click(await screen.findByLabelText('展开 utils'));
    await user.click(await screen.findByLabelText('format.ts'));
    expect(await screen.findByRole('textbox')).toBeInTheDocument();

    // 元信息行出现可点击的面包屑目录段（可见文本为分段名，完整路径在 title）
    const meta = document.querySelector('.editor-meta') as HTMLElement;
    const crumb = within(meta).getByRole('button', { name: 'utils' });
    await user.click(crumb);

    await waitFor(() => {
      const selected = document.querySelector('.tree-node.selected .tree-name');
      expect(selected?.textContent).toBe('utils');
    });
  });

  it('标签支持 ←/→ 键盘切换（tablist 导航规范）', async () => {
    renderWorkspace();
    const user = userEvent.setup();
    await user.click(await screen.findByLabelText('README.md'));
    await user.click(await screen.findByLabelText('notes.txt'));
    // 当前激活 notes.txt
    expect(screen.getByRole('tab', { name: 'notes.txt' }).getAttribute('aria-selected')).toBe('true');

    fireEvent.keyDown(screen.getByRole('tab', { name: 'notes.txt' }), { key: 'ArrowLeft' });
    await waitFor(() => {
      expect(screen.getByRole('tab', { name: 'README.md' }).getAttribute('aria-selected')).toBe('true');
    });
  });

  it('图片支持缩放控件并显示百分比', async () => {
    renderWorkspace();
    const user = userEvent.setup();
    await user.click(await screen.findByLabelText('展开 assets'));
    await user.click(await screen.findByLabelText('logo.png'));
    await screen.findByRole('img');

    await user.click(screen.getByLabelText('放大图片'));
    expect(await screen.findByText('125%')).toBeInTheDocument();
    await user.click(screen.getByLabelText('放大图片'));
    expect(await screen.findByText('156%')).toBeInTheDocument();
    await user.click(screen.getByLabelText('重置缩放'));
    expect(await screen.findByText('100%')).toBeInTheDocument();
  });

  it('图片加载失败时显示容错占位并可重试', async () => {
    renderWorkspace();
    const user = userEvent.setup();
    await user.click(await screen.findByLabelText('展开 assets'));
    await user.click(await screen.findByLabelText('logo.png'));
    const image = await screen.findByRole('img', { name: 'assets/logo.png' });

    fireEvent.error(image);
    expect(await screen.findByText(/图片加载失败/)).toBeInTheDocument();
    expect(screen.queryByRole('img')).toBeNull();

    await user.click(screen.getByRole('button', { name: '重试' }));
    expect(await screen.findByRole('img', { name: 'assets/logo.png' })).toBeInTheDocument();
  });

  it('切换标签时在树中自动展开祖先目录并高亮目标文件', async () => {
    renderWorkspace();
    const user = userEvent.setup();
    await user.click(await screen.findByLabelText('README.md'));
    await user.click(await screen.findByLabelText('展开 src'));
    await user.click(await screen.findByLabelText('展开 utils'));
    await user.click(await screen.findByLabelText('format.ts'));
    await screen.findByRole('textbox');

    // 折叠 utils，format.ts 行从树中消失
    await user.click(screen.getByLabelText('折叠 utils'));
    expect(screen.queryByLabelText('format.ts')).toBeNull();

    // 切到 README 标签再切回 format 标签 → 树中定位
    await user.click(screen.getByRole('tab', { name: 'README.md' }));
    await user.click(screen.getByRole('tab', { name: 'format.ts' }));

    await waitFor(() => {
      expect(screen.getByLabelText('折叠 utils')).toBeInTheDocument();
      const selected = document.querySelector('.tree-node.selected .tree-name');
      expect(selected?.textContent).toBe('format.ts');
    });
  });

  it('对话框支持 Escape 关闭（不误触提交）', async () => {
    renderWorkspace();
    const user = userEvent.setup();
    await user.click(screen.getByLabelText('新建文件'));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();

    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(screen.queryByText('newfile.txt')).toBeNull();
  });
});
