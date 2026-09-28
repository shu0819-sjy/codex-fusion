import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const enginePath = new URL('./dynamic-effects.v5.js', import.meta.url);
const effectsCssPath = new URL('./dynamic-effects.v5.css', import.meta.url);

/**
 * 创建最小浏览器与 Canvas 运行环境。
 * 入参：effect 效果类型，config 效果参数。
 * 返回：引擎全局对象、绘制调用记录和帧推进方法；不访问真实页面。
 */
function createRuntime(effect, config, visibilityState = 'visible') {
  const attributes = new Map([
    ['data-ds-effect', effect],
    ['data-ds-effect-config', typeof config === 'string' ? config : JSON.stringify(config)],
  ]);
  const calls = [];
  const frames = [];
  const documentListeners = new Map();
  const windowListeners = new Map();
  const elements = new Map();

  /**
   * 记录 Canvas API 调用并提供绘制所需的最小返回值。
   * 入参：无。
   * 返回：可被效果引擎调用的 CanvasRenderingContext2D 替身。
   */
  function createContext() {
    return new Proxy({}, {
      get(_target, property) {
        if (property === 'createLinearGradient' || property === 'createRadialGradient') {
          return () => ({ addColorStop() {} });
        }
        if (property === 'measureText') return () => ({ width: 8 });
        return (...args) => { calls.push([String(property), args]); };
      },
      set(_target, property, value) {
        calls.push([`set:${String(property)}`, [value]]);
        return true;
      },
    });
  }

  /**
   * 触发已注册的事件监听器。
   * 入参：监听器集合与事件名称。
   * 返回：无；未注册监听器时安全结束。
   */
  function dispatch(listeners, name) {
    const handlers = listeners.get(name) || [];
    for (const handler of handlers) handler({ type: name });
  }

  const documentElement = {
    getAttribute(name) { return attributes.get(name) ?? null; },
    setAttribute(name, value) { attributes.set(name, String(value)); },
    removeAttribute(name) { attributes.delete(name); },
  };
  const document = {
    body: {
      appendChild(element) { elements.set(element.id, element); },
    },
    visibilityState,
    documentElement,
    addEventListener(name, handler) {
      documentListeners.set(name, [...(documentListeners.get(name) || []), handler]);
    },
    removeEventListener(name, handler) {
      documentListeners.set(name, (documentListeners.get(name) || []).filter(item => item !== handler));
    },
    createElement(tagName) {
      if (tagName !== 'canvas') throw new Error(`不支持的测试节点：${tagName}`);
      const element = {
        id: '',
        style: {},
        setAttribute() {},
        remove() { elements.delete(element.id); },
        getContext() { return createContext(); },
      };
      return element;
    },
    getElementById(id) { return elements.get(id) || null; },
  };
  const window = {
    devicePixelRatio: 1,
    innerWidth: 960,
    innerHeight: 540,
    addEventListener(name, handler) {
      windowListeners.set(name, [...(windowListeners.get(name) || []), handler]);
    },
    removeEventListener(name, handler) {
      windowListeners.set(name, (windowListeners.get(name) || []).filter(item => item !== handler));
    },
    matchMedia() { return { matches: false, addEventListener() {}, removeEventListener() {} }; },
    requestAnimationFrame(callback) { frames.push(callback); return frames.length; },
    cancelAnimationFrame() {},
  };
  class MutationObserver {
    /**
     * 保存属性监听回调。
     * 入参：callback 变更回调。
     * 返回：无。
     */
    constructor(callback) { this.callback = callback; }
    /**
     * 保持与浏览器 MutationObserver 的接口一致。
     * 入参：无。
     * 返回：无；测试中由显式 API 驱动状态。
     */
    observe() {}
    /**
     * 断开观察器。
     * 入参：无。
     * 返回：无。
     */
    disconnect() {}
  }
  const sandbox = {
    window,
    document,
    MutationObserver,
    requestAnimationFrame: window.requestAnimationFrame,
    cancelAnimationFrame: window.cancelAnimationFrame,
    performance: { now: () => 0 },
    console,
  };

  vm.runInNewContext(fs.readFileSync(enginePath, 'utf8'), sandbox, { filename: enginePath.pathname });

  return {
    api: window.dynamicEffects,
    calls,
    hide() {
      document.visibilityState = 'hidden';
      dispatch(documentListeners, 'visibilitychange');
    },
    show() {
      document.visibilityState = 'visible';
      dispatch(documentListeners, 'visibilitychange');
    },
    revealWithoutVisibilityEvent() {
      document.visibilityState = 'visible';
    },
    tick(now) {
      const callbacks = frames.splice(0, frames.length);
      for (const callback of callbacks) callback(now);
    },
  };
}

test('引擎公开可诊断的启停接口', () => {
  const runtime = createRuntime('none', {});

  assert.equal(typeof runtime.api?.start, 'function');
  assert.equal(typeof runtime.api?.stop, 'function');
  assert.equal(typeof runtime.api?.getDiagnostics, 'function');
  assert.equal(typeof runtime.api?.getPresets, 'function');
  assert.equal(typeof runtime.api?.startPreset, 'function');
});

test('十个预设各有身份，三种雨景不能退化为同一状态', () => {
  const runtime = createRuntime('none', {});
  const expectedIds = [
    'fog-misty', 'matrix-digital', 'particles-float', 'rain-gentle', 'rain-heavy',
    'rain-storm', 'snow-light', 'stars-night', 'road-spray', 'night-trails',
  ];
  const presets = runtime.api.getPresets();
  assert.deepEqual([...presets].map(preset => preset.id), expectedIds);

  const sceneProfile = {
    horizonY: 0.42,
    vanishingX: 0.51,
    groundLevel: 0.58,
    roadScore: 0.82,
    nightScore: 0.71,
    accentColor: '102,171,230',
  };
  for (const presetId of expectedIds) {
    assert.equal(runtime.api.startPreset(presetId, sceneProfile), true);
    runtime.tick(16);
    const diagnostics = runtime.api.getDiagnostics();
    assert.equal(diagnostics.preset, presetId);
    assert.equal(diagnostics.sceneProfile.horizonY, sceneProfile.horizonY);
    assert.ok(runtime.calls.length > 0, `${presetId} 未产生绘制调用`);
  }
});

test('三种雨景使用相机空间投影与不同的动力学模型', () => {
  const runtime = createRuntime('none', {});
  const sceneProfile = {
    horizonY: 0.44,
    vanishingX: 0.62,
    groundLevel: 0.66,
    roadScore: 0.72,
    nightScore: 0.68,
    accentColor: '67,82,104',
  };
  const rainModels = {};

  for (const presetId of ['rain-gentle', 'rain-heavy', 'rain-storm']) {
    assert.equal(runtime.api.startPreset(presetId, sceneProfile), true);
    runtime.tick(16);
    rainModels[presetId] = runtime.api.getDiagnostics().rainModel;
    assert.equal(rainModels[presetId].projection, 'camera-space-v1');
    assert.ok(rainModels[presetId].farDepth > rainModels[presetId].nearDepth);
    assert.ok(rainModels[presetId].nearScale > rainModels[presetId].farScale * 3);
  }

  assert.ok(rainModels['rain-gentle'].fallSpeed < rainModels['rain-heavy'].fallSpeed);
  assert.ok(rainModels['rain-heavy'].fallSpeed < rainModels['rain-storm'].fallSpeed);
  assert.ok(rainModels['rain-gentle'].cameraFlow < rainModels['rain-heavy'].cameraFlow);
  assert.ok(rainModels['rain-heavy'].cameraFlow < rainModels['rain-storm'].cameraFlow);
  assert.ok(rainModels['rain-gentle'].windStrength < rainModels['rain-heavy'].windStrength);
  assert.ok(rainModels['rain-heavy'].windStrength < rainModels['rain-storm'].windStrength);
  assert.ok(rainModels['rain-gentle'].groundImpact < rainModels['rain-heavy'].groundImpact);
  assert.ok(rainModels['rain-heavy'].groundImpact < rainModels['rain-storm'].groundImpact);
});

test('细雨绵绵保留可见的中近景雨丝，而非退化为几乎静止的远景点', () => {
  const runtime = createRuntime('none', {});
  const sceneProfile = {
    horizonY: 0.44,
    vanishingX: 0.62,
    groundLevel: 0.66,
    roadScore: 0.72,
    nightScore: 0.68,
    accentColor: '67,82,104',
  };

  assert.equal(runtime.api.startPreset('rain-gentle', sceneProfile), true);
  const gentleModel = runtime.api.getDiagnostics().rainModel;
  assert.equal(runtime.api.startPreset('rain-heavy', sceneProfile), true);
  const heavyModel = runtime.api.getDiagnostics().rainModel;

  assert.ok(gentleModel.nearDepth <= 5.5, '细雨必须覆盖可见的中近景深度');
  assert.ok(gentleModel.nearScale >= 0.16, '细雨在中近景必须具有可辨识投影尺寸');
  assert.ok(gentleModel.fallSpeed >= 5, '细雨不能近似静止');
  assert.ok(gentleModel.fallSpeed < heavyModel.fallSpeed, '细雨速度仍应低于倾盆雨');
  assert.ok(gentleModel.particleCount >= 90, '细雨必须有足够的中近景雨丝，不能显得稀疏');
  assert.ok(gentleModel.particleCount < heavyModel.particleCount, '细雨数量仍应低于倾盆雨');
});

test('暴风雨拥有独立的雨幕、水汽和近景控制，而非只增加雨丝', () => {
  const runtime = createRuntime('none', {});
  const sceneProfile = {
    horizonY: 0.44,
    vanishingX: 0.62,
    groundLevel: 0.66,
    roadScore: 0.72,
    nightScore: 0.68,
    accentColor: '67,82,104',
  };

  runtime.api.startPreset('rain-heavy', sceneProfile);
  const heavyModel = runtime.api.getDiagnostics().rainModel;
  runtime.api.startPreset('rain-storm', sceneProfile);
  const stormModel = runtime.api.getDiagnostics().rainModel;

  assert.equal(stormModel.atmosphere, 'storm-front-v1');
  assert.ok(stormModel.sheetBands > 0);
  assert.ok(stormModel.sprayBands > 0);
  assert.ok(stormModel.maxTrailSeconds < heavyModel.maxTrailSeconds);
  assert.ok(stormModel.maxForegroundWidth <= 2.4);
});

test('暴风雨雷电按先导、多次回击与余辉分段演进', () => {
  const runtime = createRuntime('none', {});
  const sceneProfile = {
    horizonY: 0.44,
    vanishingX: 0.62,
    groundLevel: 0.66,
    roadScore: 0.72,
    nightScore: 0.68,
    accentColor: '67,82,104',
  };

  assert.equal(runtime.api.startPreset('rain-storm', sceneProfile), true);
  for (let timestamp = 50; timestamp <= 24000; timestamp += 50) runtime.tick(timestamp);
  const lightningModel = runtime.api.getDiagnostics().rainModel.lightningModel;

  assert.equal(lightningModel.sequence, 'leader-multistroke-bloom-v2');
  assert.ok(lightningModel.cycleCount >= 1, '暴风雨必须实际触发至少一次雷暴循环');
  assert.ok(lightningModel.mainSegments >= 6, '主闪必须由多个折线段构成');
  assert.ok(lightningModel.branchCount >= 1, '主闪必须带有至少一个分叉');
  assert.ok(lightningModel.maxCloudFlash < 0.6, '云层预闪应保持局部辉光，不能退化为全屏白闪');
  assert.ok(lightningModel.afterglowDuration >= 0.35, '雷击后必须保留短余辉');
  assert.equal(lightningModel.placement, 'peripheral-sky-v1', '主闪应避开消失点附近的主体区域');
  assert.ok(lightningModel.outerBoltWidth >= 7, '主闪必须保留可辨识的局部电晕');
  assert.ok(lightningModel.coreBoltWidth >= 2, '主闪核心不能细到被深色背景吞没');
  assert.equal(lightningModel.preferredSkyLane, 'left-biased', '主闪应优先使用界面主体外的左侧天空通道');
  assert.ok(lightningModel.minSkyClearance >= 0.1, '主闪起点必须远离顶部边缘，避免被窗口栏遮住');
});

test('雷击瞬间临时置于内容层上方，其余天气仍保持背景层', () => {
  const css = fs.readFileSync(effectsCssPath, 'utf8');
  const engineSource = fs.readFileSync(enginePath, 'utf8');
  assert.match(
    css,
    /html\[data-ds-lightning-active='true'\]\s+#ds-dynamic-canvas\s*\{[^}]*z-index:\s*3;/,
    '主闪阶段必须有短暂的前景层级，避免被不透明内容层吞没',
  );
  assert.match(
    engineSource,
    /engine\.canvas\.style\.zIndex = active \? '3' : '';/,
    '根属性被页面重置时，画布仍必须在主闪期间提高层级',
  );
});

test('重新注入后旧动画帧会自行退出，不能回写当前画布状态', () => {
  const engineSource = fs.readFileSync(enginePath, 'utf8');
  assert.match(engineSource, /var ENGINE_INSTANCE_KEY = '__CODEX_DREAM_SKIN_DYNAMIC_INSTANCE__';/);
  assert.match(engineSource, /function isCurrentEngine\(\)/);
  assert.match(engineSource, /if \(!isCurrentEngine\(\)\) \{\s*destroyCanvas\(\);\s*return;\s*\}/);
});

test('薄雾拥有高空雾丝和贴地体积层，而非只堆在地平线或使用全屏蒙版', () => {
  const runtime = createRuntime('none', {});
  const sceneProfile = {
    horizonY: 0.44,
    vanishingX: 0.62,
    groundLevel: 0.66,
    roadScore: 0.72,
    nightScore: 0.68,
    accentColor: '67,82,104',
  };

  runtime.api.startPreset('fog-misty', sceneProfile);
  runtime.tick(16);
  const fogModel = runtime.api.getDiagnostics().fogModel;

  assert.equal(fogModel.projection, 'layered-atmosphere-v2');
  assert.equal(fogModel.driftModel, 'multi-altitude-bidirectional-sway-v2');
  assert.equal(fogModel.layers, 4);
  assert.ok(fogModel.puffCount >= 24, '薄雾必须有足够的远中近景雾团');
  assert.equal(fogModel.skyLayers, 6, '薄雾必须为上半区建立独立高空层');
  assert.ok(fogModel.skySheets >= 6, '高空雾丝不能只靠一团居中的云雾');
  assert.ok(fogModel.skyBandStart <= 0.1, '高空雾丝必须覆盖到视口上方');
  assert.ok(fogModel.skyBandEnd > fogModel.skyBandStart, '高空雾带必须具备有效高度范围');
  assert.ok(fogModel.skyBandOpacity >= 0.16, '高空雾丝必须达到深色背景上的可感知阈值');
  assert.ok(fogModel.horizonBandEnd < fogModel.groundBandEnd);
  assert.ok(fogModel.horizonBandOpacity >= 0.08, '地平线雾带必须达到可感知阈值');
  assert.ok(fogModel.nearBandOpacity >= 0.04, '近地雾不能低到完全不可见');
  assert.ok(fogModel.streams >= 3, '薄雾需要有沿场景横向流动的雾丝');
  const initialStreamOffset = fogModel.streamOffset;
  const initialSkyOffset = fogModel.skyOffset;
  runtime.tick(1016);
  assert.notEqual(runtime.api.getDiagnostics().fogModel.streamOffset, initialStreamOffset, '雾丝必须在连续帧间实际横向漂移');
  assert.notEqual(runtime.api.getDiagnostics().fogModel.skyOffset, initialSkyOffset, '高空雾丝必须在连续帧间实际横向漂移');
});

test('旧版面板仅传参数时仍能辨别雨景与道路预设', () => {
  const runtime = createRuntime('none', {});

  runtime.api.start('rain', { intensity: 2, splash: false });
  assert.equal(runtime.api.getDiagnostics().preset, 'rain-gentle');
  runtime.api.start('rain', { intensity: 7, splash: true, glassDrops: true });
  assert.equal(runtime.api.getDiagnostics().preset, 'rain-heavy');
  runtime.api.start('rain', { intensity: 9, angle: 23, lightning: true });
  assert.equal(runtime.api.getDiagnostics().preset, 'rain-storm');
  runtime.api.start('road', { mode: 'trails' });
  assert.equal(runtime.api.getDiagnostics().preset, 'night-trails');
});

test('命令行剥离 JSON 引号后仍可保留预设身份', () => {
  const runtime = createRuntime('rain', '{preset:rain-heavy,intensity:7,splash:true,lightning:false}');

  assert.equal(runtime.api.getDiagnostics().preset, 'rain-heavy');
});

test('所有效果均能绘制至少一帧且可清理', () => {
  const effectConfigs = {
    rain: { intensity: 5, depthLayers: 3, glassDrops: true },
    particles: { count: 48, glow: true },
    snow: { count: 48, wind: 1 },
    fog: { layers: 3, density: 0.5 },
    stars: { count: 72, shootingStars: true },
    matrix: { fontSize: 14, trailLength: 14 },
  };

  for (const [effect, config] of Object.entries(effectConfigs)) {
    const runtime = createRuntime('none', {});
    runtime.api.start(effect, config);
    runtime.tick(16);
    runtime.tick(32);
    assert.equal(runtime.api.getDiagnostics().effect, effect);
    assert.ok(runtime.calls.length > 0, `${effect} 未产生绘制调用`);
    runtime.api.stop();
    assert.equal(runtime.api.getDiagnostics().effect, 'none');
  }
});

test('页面隐藏时暂停，恢复后继续调度', () => {
  const runtime = createRuntime('particles', { count: 24 });

  runtime.hide();
  assert.equal(runtime.api.getDiagnostics().paused, true);
  runtime.show();
  assert.equal(runtime.api.getDiagnostics().paused, false);
});

test('后台应用效果后，即使可见性恢复事件延迟也会在返回 Codex 时继续渲染', () => {
  const runtime = createRuntime('rain', { preset: 'rain-gentle' }, 'hidden');

  assert.equal(runtime.api.getDiagnostics().paused, false, '后台应用不能把新效果永久标记为暂停');
  runtime.revealWithoutVisibilityEvent();
  runtime.tick(16);
  assert.ok(runtime.calls.length > 0, '返回 Codex 后必须保留待执行的首帧渲染');
});
