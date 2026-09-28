import type { WorkspaceBridge } from './WorkspaceBridge';
import type { BridgeTransport } from './NativeWorkspaceBridge';

/**
 * 宿主注入点：原生容器可以在页面加载前挂载一个桥接实例，
 * 前端优先使用它，从而在生产环境中接入真实工作区。
 */
declare global {
  interface Window {
    __codexFusionBridge__?: WorkspaceBridge;
    /** 宿主注入的 JSONL 请求传输层；只处理 `workspace.*` 工作区请求，前端不负责进程管理。 */
    __codexFusionTransport__?: BridgeTransport;
    /**
     * 宿主注入的模式切换入口。
     *
     * 为什么单独给一条：模式的切换要结束并拉起进程，属于进程管理；
     * 工作区桥只实现 `workspace.*`，把 `mode.switch` 交给它只会拿到路径类错误。
     * 这里直连宿主的 `mode_switch` 命令，由宿主调用切换脚本。
     */
    __codexFusionModeSwitch__?: (target: 'dream-skin' | 'code-codex') => Promise<unknown>;
    /** 宿主注入的 Dream Skin 本地主题 JSON 代理。 */
    __codexFusionThemeRequest__?: (
      method: 'GET' | 'POST',
      path: string,
      body?: Record<string, unknown>,
    ) => Promise<unknown>;
    __codexFusionLaunchCodeCodex__?: () => Promise<unknown>;
    /**
     * 宿主注入的「启动自检」入口：按当前运行模式把应用带入 Dream Skin 模式。
     * 前端只触发一次并展示结果，绝不在这里做任何进程判断。
     */
    __codexFusionEnsureDreamSkinMode__?: () => Promise<unknown>;
    /**
     * 宿主注入的「上次切换结论」只读入口。
     * 用来在下次启动时如实说明上一次切换是否跑完了，尤其是中途被关闭窗口的情况。
     */
    __codexFusionLastSwitchOutcome__?: () => Promise<unknown>;
    /**
     * 宿主注入的「Code-Codex 模式健康检查」只读入口。
     * 用来在切换后如实判断文件树/预览注入链路是否可用：
     * 新版 Codex 的 Chromium 忽略默认数据目录的调试端口时，进程虽起但 CDP 不可连。
     */
    __codexFusionCodeCodexHealth__?: () => Promise<unknown>;
  }
}

export {};
