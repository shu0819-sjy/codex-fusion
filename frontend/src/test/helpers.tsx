import { render } from '@testing-library/react';
import type { WorkspaceBridge } from '../bridge/WorkspaceBridge';
import { MockWorkspaceBridge } from '../bridge/MockWorkspaceBridge';
import { WorkspaceShell } from '../components/WorkspaceShell';

/**
 * 渲染完整工作台并返回桥接实例。
 * 默认使用零延迟的 MockWorkspaceBridge，便于断言异步加载结果。
 */
export function renderWorkspace(): MockWorkspaceBridge;
export function renderWorkspace(bridge: WorkspaceBridge): WorkspaceBridge;
/**
 * 渲染完整工作台并返回桥接实例。
 * 入参：可选的桥接实例；返回值：传入实例或默认 MockWorkspaceBridge；无桥接实例时保留测试辅助方法的具体类型。
 */
export function renderWorkspace(bridge?: WorkspaceBridge): WorkspaceBridge {
  const instance = bridge ?? new MockWorkspaceBridge({ latencyMs: 0 });
  render(<WorkspaceShell bridge={instance} />);
  return instance;
}
