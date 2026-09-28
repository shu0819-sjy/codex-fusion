import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWorkspace } from './helpers';

describe('预览与只读', () => {
  it('可编辑文本以 textarea 打开', async () => {
    renderWorkspace();
    const user = userEvent.setup();
    await user.click(await screen.findByLabelText('README.md'));
    const textarea = await screen.findByRole('textbox');
    expect((textarea as HTMLTextAreaElement).value).toContain('Codex Fusion');
    expect(screen.queryByLabelText('只读预览')).toBeNull();
  });

  it('只读文件禁用编辑', async () => {
    renderWorkspace();
    const user = userEvent.setup();
    await user.click(await screen.findByLabelText('spec.md'));
    expect(await screen.findByLabelText('只读预览')).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getAllByText('只读').length).toBeGreaterThan(0);
  });

  it('截断文件显示紧凑状态且不可编辑', async () => {
    renderWorkspace();
    const user = userEvent.setup();
    await user.click(await screen.findByLabelText('big.log'));
    expect(await screen.findByText(/已截断显示/)).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('二进制文件只显示状态，不渲染内容', async () => {
    renderWorkspace();
    const user = userEvent.setup();
    await user.click(await screen.findByLabelText('展开 assets'));
    await user.click(await screen.findByLabelText('archive.zip'));
    expect(await screen.findByText(/二进制文件/)).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByLabelText('只读预览')).toBeNull();
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('图片文件渲染为图片预览（棋盘格画布，不进入文本编辑器）', async () => {
    renderWorkspace();
    const user = userEvent.setup();
    await user.click(await screen.findByLabelText('展开 assets'));
    await user.click(await screen.findByLabelText('logo.png'));
    const image = await screen.findByRole('img', { name: 'assets/logo.png' });
    expect((image as HTMLImageElement).src).toMatch(/^data:image\/svg\+xml/);
    expect(await screen.findByText('640 × 400 px')).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByText(/二进制文件/)).toBeNull();
  });

  it('符号链接按只读展示', async () => {
    renderWorkspace();
    const user = userEvent.setup();
    await user.click(await screen.findByLabelText('link-readme'));
    expect(await screen.findByText(/符号链接/)).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).toBeNull();
  });
});
