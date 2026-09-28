import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * 宿主注入契约的守卫测试。
 *
 * 为什么需要它：模式切换是进程管理，必须走宿主专门注入的入口；
 * 一旦有人把它接回只实现 `workspace.*` 的工作区 JSONL 传输层，
 * 用户点「切换模式」就会拿到一个路径类错误（表现为界面底部一条红色告警），
 * 而按钮看起来「点了没反应」。单元测试里注入的是替身，抓不到这种接线错误，
 * 所以这里直接检查真实的宿主注入脚本与前端路由。
 */
const repoRoot = resolve(__dirname, '..', '..', '..');
const indexPath = resolve(repoRoot, 'frontend', 'index.html');
const modeSwitchPath = resolve(repoRoot, 'frontend', 'src', 'bridge', 'modeSwitch.ts');
const hostTypesPath = resolve(repoRoot, 'frontend', 'src', 'bridge', 'host.d.ts');

describe('宿主注入契约', () => {
  it('宿主注入脚本必须提供模式切换入口，并指向宿主的 mode_switch 命令', () => {
    const html = readFileSync(indexPath, 'utf8');

    expect(html).toContain('__codexFusionModeSwitch__');
    expect(html).toContain("invoke('mode_switch'");
    // 模式切换绝不允许被接到工作区桥上
    expect(html).not.toMatch(/__codexFusionModeSwitch__[\s\S]{0,200}workspace_request/);
  });

  it('前端模式切换的默认传输层不得再向工作区 JSONL 传输层发送 mode.switch', () => {
    const source = readFileSync(modeSwitchPath, 'utf8');

    expect(source).toContain('__codexFusionModeSwitch__');
    // 默认传输实现里不得出现把 mode.switch 交给 __codexFusionTransport__ 的写法
    expect(source).not.toMatch(/const transport = window\.__codexFusionTransport__/);
  });

  it('宿主必须提供「上次切换结论」只读入口，且注入脚本与前端声明保持一致', () => {
    const html = readFileSync(indexPath, 'utf8');
    const declaration = readFileSync(hostTypesPath, 'utf8');

    expect(html).toContain('__codexFusionLastSwitchOutcome__');
    expect(html).toContain("invoke('last_switch_outcome'");
    expect(declaration).toContain('__codexFusionLastSwitchOutcome__');
    // 这个入口是只读的历史查询，绝不能接到工作区桥上
    expect(html).not.toMatch(/__codexFusionLastSwitchOutcome__[\s\S]{0,200}workspace_request/);
  });
});
