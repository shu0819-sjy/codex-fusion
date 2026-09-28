/* Codex Dream Skin - Dynamic Effects Engine v5
 * 八个原有效果均为独立预设，并新增路面水雾与夜行光轨。
 * 场景轮廓完全由本地图像缩略图分析提供，不请求远程服务。
 */
(function () {
  'use strict';

  var CANVAS_ID = 'ds-dynamic-canvas';
  var MAX_DPR = 1.25;
  var MAX_DELTA_SECONDS = 0.05;
  var EFFECTS = {};
  var PRESETS = [
    { id: 'fog-misty', type: 'fog', config: { layers: 4, skyLayers: 6, speed: 0.26, opacity: 0.62, density: 0.82, color: '198,214,228' } },
    { id: 'matrix-digital', type: 'matrix', config: { columns: 52, speed: 3.6, opacity: 0.82, color: '0,255,70', fontSize: 15, trailLength: 26, glow: true } },
    { id: 'particles-float', type: 'particles', config: { count: 110, speed: 0.85, opacity: 0.82, color: '255,255,255', sizeMin: 1.6, sizeMax: 5.2, glow: true, drift: 0.7 } },
    { id: 'rain-gentle', type: 'rain', config: { intensity: 7.0, speed: 4.6, opacity: 0.72, angle: 8, wind: 0.55, depthLayers: 3, splash: true, glassDrops: true, mist: true, color: '184,205,232' } },
    { id: 'rain-heavy', type: 'rain', config: { intensity: 8.5, speed: 8, opacity: 0.72, angle: 12, wind: 1.0, depthLayers: 4, splash: true, glassDrops: true, mist: true, color: '174,194,224' } },
    { id: 'rain-storm', type: 'rain', config: { intensity: 10, speed: 10, opacity: 0.78, angle: 24, wind: 2.0, depthLayers: 4, splash: true, glassDrops: true, mist: true, lightning: true, color: '184,202,230' } },
    { id: 'snow-light', type: 'snow', config: { count: 70, speed: 0.88, opacity: 0.68, color: '255,255,255', sizeMin: 1.1, sizeMax: 5.2, wind: 0.22, swing: 0.48 } },
    { id: 'stars-night', type: 'stars', config: { count: 160, twinkleSpeed: 0.85, opacity: 0.78, color: '255,255,255', sizeMin: 0.35, sizeMax: 1.35, shootingStars: true, shootingFrequency: 0.004 } },
    { id: 'road-spray', type: 'road', config: { mode: 'spray', count: 56, speed: 0.78, opacity: 0.48, color: '186,210,228', spread: 0.98 } },
    { id: 'night-trails', type: 'road', config: { mode: 'trails', count: 36, speed: 0.95, opacity: 0.88, color: '129,197,255', spread: 0.92 } },
  ];
  var PRESET_BY_ID = {};
  for (var presetIndex = 0; presetIndex < PRESETS.length; presetIndex += 1) PRESET_BY_ID[PRESETS[presetIndex].id] = PRESETS[presetIndex];

  var engine = {
    canvas: null, ctx: null, animationId: null, effect: 'none', preset: 'none', config: {}, state: null,
    sceneProfile: null, width: 0, height: 0, dpr: 1, lastFrameAt: 0, paused: false, reducedMotion: false,
    quality: 1, slowFrames: 0, fastFrames: 0, pointerX: 0.5, pointerY: 0.5, pointerTargetX: 0.5, pointerTargetY: 0.5,
  };

  if (window.dynamicEffects && typeof window.dynamicEffects.stop === 'function') {
    try { window.dynamicEffects.stop(); } catch (error) {}
  }
  var ENGINE_INSTANCE_KEY = '__CODEX_DREAM_SKIN_DYNAMIC_INSTANCE__';
  var engineInstanceId = String(Date.now()) + '-' + String(Math.random()).slice(2);
  window[ENGINE_INSTANCE_KEY] = engineInstanceId;

  /** 功能：判断当前闭包是否仍是页面唯一的动态效果实例。入参：无。返回：是否为最新实例。边界：重注入后旧实例立即返回 false。 */
  function isCurrentEngine() {
    return window[ENGINE_INSTANCE_KEY] === engineInstanceId;
  }

  /** 功能：将数值限制在指定范围。入参：value、min、max。返回：安全数值。边界：非法值回退 min。 */
  function clamp(value, min, max) {
    var number = Number(value);
    if (!Number.isFinite(number)) return min;
    return Math.max(min, Math.min(max, number));
  }

  /** 功能：生成范围内随机数。入参：min、max。返回：随机浮点数。边界：相同边界稳定返回该值。 */
  function random(min, max) { return min + Math.random() * (max - min); }

  /** 功能：计算线性插值。入参：from、to、amount。返回：插值数值。边界：比例自动限制。 */
  function lerp(from, to, amount) { return from + (to - from) * clamp(amount, 0, 1); }

  /** 功能：读取受限配置数值。入参：value、defaultValue、min、max。返回：安全配置值。边界：非法值返回默认值。 */
  function numberConfig(value, defaultValue, min, max) {
    var number = Number(value);
    return Number.isFinite(number) ? clamp(number, min, max) : defaultValue;
  }

  /** 功能：解析 RGB 字符串。入参：rawColor。返回：三通道数组。边界：非法输入回退冷白。 */
  function parseColor(rawColor) {
    var values = String(rawColor || '174,194,224').split(',').map(Number);
    if (values.length !== 3 || values.some(function (value) { return !Number.isFinite(value); })) return [174, 194, 224];
    return [clamp(values[0], 0, 255), clamp(values[1], 0, 255), clamp(values[2], 0, 255)];
  }

  /** 功能：构建 rgba 样式。入参：rawColor、alpha。返回：CSS 颜色。边界：透明度始终受限。 */
  function rgba(rawColor, alpha) {
    var color = parseColor(rawColor);
    return 'rgba(' + color[0] + ',' + color[1] + ',' + color[2] + ',' + clamp(alpha, 0, 1) + ')';
  }

  /** 功能：把颜色数组转为 RGB 字符串。入参：color。返回：逗号分隔的三通道颜色。边界：通道会自动限制。 */
  function colorString(color) {
    return Math.round(clamp(color[0], 0, 255)) + ',' + Math.round(clamp(color[1], 0, 255)) + ',' + Math.round(clamp(color[2], 0, 255));
  }

  /** 功能：混合两种 RGB 颜色。入参：first、second、amount。返回：混合后颜色字符串。边界：比例自动限制。 */
  function blendColor(first, second, amount) {
    var left = parseColor(first);
    var right = parseColor(second);
    return colorString([lerp(left[0], right[0], amount), lerp(left[1], right[1], amount), lerp(left[2], right[2], amount)]);
  }

  /** 功能：解析旧命令行丢失 JSON 引号后的受限标量配置。入参：source。返回：可识别字段对象。边界：不匹配字段会被忽略，绝不执行字符串。 */
  function parseLooseConfig(source) {
    var config = {};
    var text = String(source || '');
    var pairPattern = /([A-Za-z][A-Za-z0-9_]*)\s*:\s*(true|false|-?\d+(?:\.\d+)?|[A-Za-z][A-Za-z0-9-]*)/g;
    var match = null;
    while ((match = pairPattern.exec(text)) !== null) {
      var key = match[1];
      var rawValue = match[2];
      if (rawValue === 'true') config[key] = true;
      else if (rawValue === 'false') config[key] = false;
      else if (/^-?\d/.test(rawValue)) config[key] = Number(rawValue);
      else config[key] = rawValue;
    }
    var colorMatch = /color\s*:\s*(\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3})/.exec(text);
    if (colorMatch) config.color = colorMatch[1].replace(/\s/g, '');
    return config;
  }

  /** 功能：读取页面指定的效果配置。入参：无。返回：对象配置。边界：标准 JSON 失败时仅兼容受限旧格式。 */
  function readDocumentConfig() {
    var source = document.documentElement.getAttribute('data-ds-effect-config');
    if (!source) return {};
    try {
      var parsed = JSON.parse(source);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (error) { return parseLooseConfig(source); }
  }

  /** 功能：归一化背景场景轮廓。入参：source 原始轮廓。返回：可供效果使用的固定结构。边界：缺失字段使用中性默认值。 */
  function normalizeSceneProfile(source) {
    var value = source && typeof source === 'object' ? source : {};
    return {
      horizonY: numberConfig(value.horizonY, 0.44, 0.26, 0.68),
      vanishingX: numberConfig(value.vanishingX, 0.5, 0.16, 0.84),
      groundLevel: numberConfig(value.groundLevel, 0.64, 0.48, 0.88),
      roadScore: numberConfig(value.roadScore, 0.42, 0, 1),
      nightScore: numberConfig(value.nightScore, 0.5, 0, 1),
      upperBrightness: numberConfig(value.upperBrightness, 0.45, 0, 1),
      lowerBrightness: numberConfig(value.lowerBrightness, 0.36, 0, 1),
      accentColor: typeof value.accentColor === 'string' ? value.accentColor : '128,188,235',
    };
  }

  /** 功能：从主题注入状态或调用配置读取场景轮廓。入参：config。返回：本地分析结果。边界：注入状态未准备好时回退中性轮廓。 */
  function readSceneProfile(config) {
    var runtimeState = window.__CODEX_DREAM_SKIN_STATE__;
    var analyzed = runtimeState && runtimeState.analysis && runtimeState.analysis.sceneProfile;
    var configured = config && config.sceneProfile;
    return normalizeSceneProfile(configured || analyzed);
  }

  /** 功能：按照预设标识取得真实预设。入参：effect、config。返回：预设对象或空值。边界：未知标识按效果类型寻找第一个预设。 */
  function resolvePreset(effect, config) {
    var requested = config && typeof config.preset === 'string' ? config.preset : '';
    if (PRESET_BY_ID[requested] && PRESET_BY_ID[requested].type === effect) return PRESET_BY_ID[requested];
    if (effect === 'rain') {
      if (config && (config.lightning === true || Number(config.intensity) >= 8 || Number(config.angle) >= 18)) return PRESET_BY_ID['rain-storm'];
      if (config && (Number(config.intensity) >= 5 || config.splash === true || config.glassDrops === true)) return PRESET_BY_ID['rain-heavy'];
      return PRESET_BY_ID['rain-gentle'];
    }
    if (effect === 'road') return config && config.mode === 'trails' ? PRESET_BY_ID['night-trails'] : PRESET_BY_ID['road-spray'];
    for (var index = 0; index < PRESETS.length; index += 1) if (PRESETS[index].type === effect) return PRESETS[index];
    return null;
  }

  /** 功能：合并预设默认值与调用配置。入参：preset、config。返回：新配置对象。边界：调用配置不存在时仅返回预设默认值。 */
  function mergePresetConfig(preset, config) {
    var merged = {};
    var defaults = preset && preset.config ? preset.config : {};
    var source = config && typeof config === 'object' ? config : {};
    var key = '';
    for (key in defaults) if (Object.prototype.hasOwnProperty.call(defaults, key)) merged[key] = defaults[key];
    for (key in source) if (Object.prototype.hasOwnProperty.call(source, key)) merged[key] = source[key];
    if (preset) merged.preset = preset.id;
    return merged;
  }

  /** 功能：移除旧的动态画布。入参：无。返回：无。边界：不存在时安全结束。 */
  function removeOldCanvas() {
    var oldCanvas = document.getElementById(CANVAS_ID);
    if (oldCanvas) oldCanvas.remove();
  }

  /** 功能：创建单一透明画布。入参：无。返回：是否成功。边界：无 2D 上下文时返回 false。 */
  function createCanvas() {
    if (engine.canvas && engine.ctx) return true;
    removeOldCanvas();
    var canvas = document.createElement('canvas');
    canvas.id = CANVAS_ID;
    canvas.setAttribute('aria-hidden', 'true');
    canvas.style.cssText = 'position:fixed;inset:0;z-index:1;pointer-events:none;opacity:0;transition:opacity 420ms ease;contain:strict;';
    document.body.appendChild(canvas);
    var context = canvas.getContext('2d', { alpha: true, desynchronized: true });
    if (!context) { canvas.remove(); return false; }
    engine.canvas = canvas;
    engine.ctx = context;
    resizeCanvas();
    return true;
  }

  /** 功能：同步画布到当前视口。入参：无。返回：无。边界：像素比和尺寸均有上限。 */
  function resizeCanvas() {
    if (!engine.canvas || !engine.ctx) return;
    engine.dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    engine.width = Math.max(1, window.innerWidth || 1);
    engine.height = Math.max(1, window.innerHeight || 1);
    engine.canvas.width = Math.round(engine.width * engine.dpr);
    engine.canvas.height = Math.round(engine.height * engine.dpr);
    engine.canvas.style.width = engine.width + 'px';
    engine.canvas.style.height = engine.height + 'px';
    engine.ctx.setTransform(engine.dpr, 0, 0, engine.dpr, 0, 0);
    if (engine.effect !== 'none') initializeCurrentEffect();
  }

  /** 功能：停止帧循环并销毁画布。入参：无。返回：无。边界：重复调用安全。 */
  function destroyCanvas() {
    if (engine.animationId) cancelAnimationFrame(engine.animationId);
    engine.animationId = null;
    if (engine.canvas) engine.canvas.remove();
    engine.canvas = null;
    engine.ctx = null;
    engine.state = null;
  }

  /** 功能：根据连续帧耗时调整画质。入参：frameCostMs。返回：无。边界：仅连续慢帧或快帧触发调整。 */
  function adaptQuality(frameCostMs) {
    if (frameCostMs > 23) { engine.slowFrames += 1; engine.fastFrames = 0; }
    else if (frameCostMs < 13) { engine.fastFrames += 1; engine.slowFrames = 0; }
    else { engine.slowFrames = 0; engine.fastFrames = 0; }
    if (engine.slowFrames >= 90 && engine.quality > 0.56) {
      engine.quality = Math.max(0.56, engine.quality - 0.1);
      engine.slowFrames = 0;
      initializeCurrentEffect();
    }
    if (engine.fastFrames >= 180 && engine.quality < 1) {
      engine.quality = Math.min(1, engine.quality + 0.1);
      engine.fastFrames = 0;
      initializeCurrentEffect();
    }
  }

  /** 功能：按三种雨景预设生成相机空间动力学档案。入参：presetId。返回：雨景运动参数。边界：未知标识回退倾盆大雨。 */
  function rainProfile(presetId) {
    if (presetId === 'rain-gentle') return {
      density: 1.5, nearDepth: 3.8, farDepth: 31, depthExponent: 0.74, focalLength: 0.92, focalHeight: 0.87,
      fallSpeed: 6.8, cameraFlow: 0.34, windStrength: 0.42, gust: 0.24, trailSeconds: 0.026, dropWidth: 0.0125,
      lens: 0, maxLensDrops: 0, groundImpact: 0.45, maxSplashes: 36, impactDepth: 7.2, mist: 0.3, reflection: 0.28,
      atmosphere: 'clear-rain-v1', sheetBands: 0, sprayBands: 0, maxTrailSeconds: 0.026, maxForegroundWidth: 1.65,
    };
    if (presetId === 'rain-storm') return {
      density: 0.94, nearDepth: 2.6, farDepth: 18, depthExponent: 1.08, focalLength: 0.82, focalHeight: 0.9,
      fallSpeed: 14.8, cameraFlow: 1.72, windStrength: 2.6, gust: 1.45, trailSeconds: 0.016, dropWidth: 0.008,
      lens: 1, maxLensDrops: 16, groundImpact: 1, maxSplashes: 90, impactDepth: 8.5, mist: 0.92, reflection: 0.92,
      atmosphere: 'storm-front-v1', sheetBands: 5, sprayBands: 4, maxTrailSeconds: 0.016, maxForegroundWidth: 1.2,
    };
    return {
      density: 1.62, nearDepth: 2.15, farDepth: 29, depthExponent: 0.72, focalLength: 0.8, focalHeight: 0.87,
      fallSpeed: 8.9, cameraFlow: 0.64, windStrength: 0.82, gust: 0.62, trailSeconds: 0.034, dropWidth: 0.011,
      lens: 0.88, maxLensDrops: 12, groundImpact: 0.72, maxSplashes: 70, impactDepth: 12, mist: 0.62, reflection: 0.7,
      atmosphere: 'downpour-v1', sheetBands: 0, sprayBands: 0, maxTrailSeconds: 0.034, maxForegroundWidth: 2.9,
    };
  }

  /** 功能：在相机视锥内按预设密度采样世界深度。入参：profile 雨景档案。返回：正向世界 z 深度。边界：始终不小于近裁剪距离。 */
  function sampleRainDepth(profile) {
    var progression = Math.pow(Math.random(), profile.depthExponent);
    return Math.max(profile.nearDepth, lerp(profile.nearDepth, profile.farDepth, progression));
  }

  /** 功能：将相机空间的世界坐标投影到背景消失点所在的屏幕空间。入参：worldX、elevation、depth、profile。返回：屏幕坐标与投影倍率。边界：近裁剪外的坐标仍安全投影。 */
  function projectRainPoint(worldX, elevation, depth, profile) {
    var safeDepth = Math.max(profile.nearDepth * 0.42, depth);
    return {
      x: engine.sceneProfile.vanishingX * engine.width + worldX / safeDepth * profile.focalLength * engine.width,
      y: engine.sceneProfile.horizonY * engine.height + elevation / safeDepth * profile.focalHeight * engine.height,
      scale: profile.focalLength / safeDepth,
    };
  }

  /** 功能：创建一条相机空间雨丝。入参：config、profile、spawnAnywhere。返回：包含世界 x、elevation、z 的雨丝状态。边界：初始位置始终落在扩展视锥内。 */
  function createRainDrop(config, profile, spawnAnywhere) {
    var depth = sampleRainDepth(profile);
    var screenX = random(-engine.width * 0.14, engine.width * 1.14);
    var screenY = spawnAnywhere ? random(-engine.height * 0.16, engine.height * 1.08) : -random(engine.height * 0.05, engine.height * 0.24);
    var speedScale = 0.62 + numberConfig(config.speed, 5, 1, 10) * 0.075;
    var horizontalOffset = screenX / Math.max(1, engine.width) - engine.sceneProfile.vanishingX;
    var verticalOffset = screenY / Math.max(1, engine.height) - engine.sceneProfile.horizonY;
    var angle = numberConfig(config.angle, 8, -35, 35) * Math.PI / 180;
    var configuredWind = numberConfig(config.wind, 0, -8, 8) * 0.18;
    var groundElevation = Math.max(0.8, (engine.sceneProfile.groundLevel - engine.sceneProfile.horizonY) * profile.farDepth / profile.focalHeight);
    var elevation = verticalOffset * depth / profile.focalHeight;
    if (elevation >= groundElevation) elevation = groundElevation - random(0.08, 0.76);
    return {
      worldX: horizontalOffset * depth / profile.focalLength,
      elevation: elevation,
      depth: depth,
      fallSpeed: profile.fallSpeed * speedScale * random(0.84, 1.16),
      cameraFlow: profile.cameraFlow * (0.76 + numberConfig(config.speed, 5, 1, 10) * 0.045) * random(0.82, 1.18),
      windVelocity: profile.windStrength + configuredWind + Math.tan(angle) * profile.fallSpeed * 0.16 + random(-0.24, 0.24),
      worldWidth: profile.dropWidth * random(0.72, 1.28),
      phase: random(0, Math.PI * 2),
      wobble: random(0.08, 0.8),
      opacity: random(0.62, 1) * numberConfig(config.opacity, 0.55, 0.05, 1),
      screenX: screenX,
      screenY: screenY,
    };
  }

  /** 功能：创建镜头玻璃水滴。入参：config、profile。返回：水滴状态。边界：暴风雨水滴优先停留在镜头边缘，单滴半径限制为小面积。 */
  function createLensDrop(config, profile) {
    var isStorm = profile.atmosphere === 'storm-front-v1';
    var radius = random(isStorm ? 2.4 : 3.2, isStorm ? 7.2 : 9.6) * numberConfig(config.glassScale, 1, 0.5, 1.8);
    var x = isStorm && Math.random() < 0.78
      ? (Math.random() < 0.5 ? random(0, engine.width * 0.18) : random(engine.width * 0.82, engine.width))
      : random(0, engine.width);
    return {
      x: x, y: random(-20, engine.height), radius: radius, velocity: random(3, 13) + radius * 0.42,
      sway: random(-0.9, 0.9), phase: random(0, Math.PI * 2), tail: random(5, 22), delay: random(0.35, 3.3),
      life: random(8, 20), opacity: random(0.14, 0.31) * numberConfig(config.opacity, 0.55, 0.05, 1) * profile.lens,
    };
  }

  /** 功能：初始化雨景的相机空间雨体积、镜头水滴和路面反射。入参：config。返回：完整雨景状态。边界：粒子数量随画质缩放。 */
  function initializeRain(config) {
    var profile = rainProfile(engine.preset);
    var intensity = numberConfig(config.intensity, 5, 1, 10);
    var count = Math.round((20 + intensity * 12) * profile.density * engine.quality);
    var lensCount = config.glassDrops === false ? 0 : Math.min(profile.maxLensDrops, Math.round((4 + intensity * 2.2) * profile.lens * engine.quality));
    var streaks = [];
    var lensDrops = [];
    var roadLines = [];
    var stormSheets = [];
    var stormSprays = [];
    for (var index = 0; index < count; index += 1) streaks.push(createRainDrop(config, profile, true));
    for (var lensIndex = 0; lensIndex < lensCount; lensIndex += 1) lensDrops.push(createLensDrop(config, profile));
    for (var lineIndex = 0; lineIndex < 16; lineIndex += 1) roadLines.push({ side: Math.random() < 0.5 ? -1 : 1, offset: random(0.05, 1), phase: random(0, Math.PI * 2), width: random(0.25, 1) });
    for (var sheetIndex = 0; sheetIndex < profile.sheetBands; sheetIndex += 1) {
      stormSheets.push({ x: random(-engine.width * 0.15, engine.width * 1.05), width: random(engine.width * 0.14, engine.width * 0.28), phase: random(0, Math.PI * 2), opacity: random(0.048, 0.086), drift: random(16, 40) });
    }
    for (var sprayIndex = 0; sprayIndex < profile.sprayBands; sprayIndex += 1) {
      stormSprays.push({ side: Math.random() < 0.5 ? -1 : 1, depth: random(0.2, 0.94), phase: random(0, Math.PI * 2), opacity: random(0.03, 0.09), drift: random(0.12, 0.32) });
    }
    return {
      streaks: streaks,
      lensDrops: lensDrops,
      splashes: [],
      roadLines: roadLines,
      stormSheets: stormSheets,
      stormSprays: stormSprays,
      profile: profile,
      groundElevation: Math.max(0.8, (engine.sceneProfile.groundLevel - engine.sceneProfile.horizonY) * profile.farDepth / profile.focalHeight),
      wind: 0,
      windTarget: 0,
      gustClock: random(0.8, 2.4),
      lightning: 0,
      lightningEcho: 0,
      lightningClock: random(4.5, 10.5),
      lightningEvent: null,
      rainModel: {
        projection: 'camera-space-v1',
        nearDepth: profile.nearDepth,
        farDepth: profile.farDepth,
        nearScale: profile.focalLength / profile.nearDepth,
        farScale: profile.focalLength / profile.farDepth,
        fallSpeed: profile.fallSpeed,
        cameraFlow: profile.cameraFlow,
        windStrength: profile.windStrength,
        groundImpact: profile.groundImpact,
        groundElevation: Math.max(0.8, (engine.sceneProfile.groundLevel - engine.sceneProfile.horizonY) * profile.farDepth / profile.focalHeight),
        atmosphere: profile.atmosphere,
        sheetBands: profile.sheetBands,
        sprayBands: profile.sprayBands,
        maxTrailSeconds: profile.maxTrailSeconds,
        maxForegroundWidth: profile.maxForegroundWidth,
        particleCount: count,
        lightningModel: {
          sequence: 'leader-multistroke-bloom-v2',
          cycleCount: 0,
          phase: 'idle',
          cloudFlash: 0,
          strike: 0,
          afterglow: 0,
          exposure: 0,
          mainSegments: 0,
          branchCount: 0,
          maxCloudFlash: 0.52,
          afterglowDuration: 0.78,
          placement: 'peripheral-sky-v1',
          preferredSkyLane: 'left-biased',
          minSkyClearance: 0.1,
          outerBoltWidth: 14.5,
          coreBoltWidth: 2.15,
        },
      },
    };
  }

  /** 功能：在投影后的路面接触点创建短寿命飞溅。入参：state、drop、config。返回：无。边界：细雨、远景与非路面接触不会创建飞溅。 */
  function createSplash(state, drop, config) {
    var profile = state.profile;
    if (!config.splash || profile.groundImpact <= 0 || drop.depth > profile.impactDepth || drop.elevation < state.groundElevation || Math.random() > 0.28) return;
    var nearFactor = clamp((profile.impactDepth - drop.depth) / Math.max(1, profile.impactDepth - profile.nearDepth), 0.12, 1);
    var count = Math.round((1 + nearFactor * 3) * profile.groundImpact);
    for (var index = 0; index < count; index += 1) {
      state.splashes.push({
        x: drop.screenX,
        y: clamp(drop.screenY, engine.sceneProfile.horizonY * engine.height, engine.height),
        vx: random(-24, 24) * nearFactor,
        vy: -random(18, 48) * nearFactor,
        life: 1,
        size: random(0.45, 1.5) * nearFactor,
      });
    }
    if (state.splashes.length > state.profile.maxSplashes) state.splashes.splice(0, state.splashes.length - state.profile.maxSplashes);
  }

  /** 功能：用中点位移法生成自然锯齿闪电路径。入参：起止坐标、递归代数、初始位移。返回：点集。边界：首尾点固定；代数过高时自动钳制避免过密折线。 */
  function createLightningPath(startX, startY, endX, endY, generations, displace) {
    var points = [{ x: startX, y: startY }, { x: endX, y: endY }];
    var offset = Math.max(1, displace);
    var depth = Math.max(2, Math.min(6, Math.round(generations)));
    for (var gen = 0; gen < depth; gen += 1) {
      var next = [points[0]];
      for (var index = 0; index < points.length - 1; index += 1) {
        var a = points[index];
        var b = points[index + 1];
        var dx = b.x - a.x;
        var dy = b.y - a.y;
        var length = Math.sqrt(dx * dx + dy * dy) || 1;
        var midX = (a.x + b.x) * 0.5;
        var midY = (a.y + b.y) * 0.5;
        var px = -dy / length;
        var py = dx / length;
        var amount = (Math.random() * 2 - 1) * offset * (0.72 + Math.random() * 0.45);
        // 轻微沿主轴滑动，避免过于规整的“之”字
        var slide = (Math.random() * 2 - 1) * offset * 0.18;
        next.push({
          x: midX + px * amount + (dx / length) * slide,
          y: midY + py * amount + (dy / length) * slide,
        });
        next.push(b);
      }
      points = next;
      offset *= 0.52;
    }
    points[0] = { x: startX, y: startY };
    points[points.length - 1] = { x: endX, y: endY };
    return points;
  }

  /** 功能：为暴风雨创建大小、落点与形态都变化的雷电事件。入参：无。返回：本次雷暴事件。边界：落点避开画面中心主体，远景闪电更细更淡。 */
  function createStormLightning() {
    var scene = engine.sceneProfile;
    var horizon = scene.horizonY * engine.height;
    var vanishingX = scene.vanishingX * engine.width;
    var roll = Math.random();
    // 远景细闪 / 中景常规 / 近景粗闪 / 云间片状闪（无落地通道）
    var kind = roll < 0.22 ? 'distant' : roll < 0.62 ? 'mid' : roll < 0.86 ? 'near' : 'sheet';
    var sizeScale = kind === 'distant' ? random(0.32, 0.55)
      : kind === 'near' ? random(1.15, 1.55)
      : kind === 'sheet' ? random(0.7, 1.1)
      : random(0.72, 1.08);
    var sideRoll = Math.random();
    var side = sideRoll < 0.42 ? -1 : sideRoll < 0.84 ? 1 : (Math.random() < 0.5 ? -1 : 1);
    var laneJitter = kind === 'near' ? random(0.12, 0.28) : random(0.16, 0.42);
    var startX;
    if (kind === 'sheet' || sideRoll >= 0.84) {
      // 偶尔从更靠中上的云层起闪，但仍避开消失点正上方
      startX = clamp(vanishingX + random(-0.28, 0.28) * engine.width, engine.width * 0.12, engine.width * 0.88);
      if (Math.abs(startX - vanishingX) < engine.width * 0.08) {
        startX += (startX < vanishingX ? -1 : 1) * engine.width * random(0.1, 0.18);
      }
    } else if (side < 0) {
      startX = clamp(vanishingX - laneJitter * engine.width - random(0, engine.width * 0.12), engine.width * 0.06, engine.width * 0.48);
    } else {
      startX = clamp(vanishingX + laneJitter * engine.width + random(0, engine.width * 0.1), engine.width * 0.55, engine.width * 0.94);
    }
    var startY = kind === 'distant'
      ? random(engine.height * 0.02, Math.max(engine.height * 0.05, horizon * 0.16))
      : kind === 'near'
        ? random(engine.height * 0.06, Math.max(engine.height * 0.12, horizon * 0.34))
        : random(engine.height * 0.03, Math.max(engine.height * 0.09, horizon * 0.24));
    var reach = kind === 'distant' ? random(0.35, 0.62)
      : kind === 'near' ? random(0.82, 1.08)
      : kind === 'sheet' ? random(0.18, 0.42)
      : random(0.58, 0.9);
    var endX = startX + random(-0.16, 0.14) * engine.width * (kind === 'near' ? 1.15 : 1);
    endX = clamp(endX, engine.width * 0.05, engine.width * 0.95);
    // 再推离消失点，减少打到主体上的概率
    if (Math.abs(endX - vanishingX) < engine.width * 0.05) {
      endX += (endX < vanishingX ? -1 : 1) * engine.width * random(0.06, 0.12);
    }
    var endY = kind === 'sheet'
      ? startY + random(engine.height * 0.04, engine.height * 0.12)
      : lerp(startY, horizon + engine.height * (kind === 'near' ? 0.18 : 0.1), reach);
    endY = clamp(endY, startY + engine.height * 0.05, engine.height * 0.92);
    var generations = kind === 'distant' ? Math.round(random(3, 5)) : Math.round(random(4, 6));
    var displace = engine.width * (0.028 + sizeScale * 0.028) * (kind === 'sheet' ? 0.7 : 1);
    var main = createLightningPath(startX, startY, endX, endY, generations, displace);
    var branches = [];
    var branchCount = kind === 'sheet' ? 1 + Math.floor(random(0, 2))
      : kind === 'distant' ? 1 + Math.floor(random(0, 2))
      : kind === 'near' ? 3 + Math.floor(random(0, 4))
      : 2 + Math.floor(random(0, 3));
    for (var index = 0; index < branchCount; index += 1) {
      var anchorIndex = Math.min(main.length - 4, Math.max(2, Math.floor(random(0.18, 0.86) * main.length)));
      var anchor = main[anchorIndex];
      var forkBias = (Math.random() < 0.5 ? side : -side) * (Math.random() < 0.6 ? 1 : 0.4);
      var branchReach = (kind === 'sheet' ? random(0.08, 0.2) : random(0.045, 0.2)) * engine.width * sizeScale;
      var branchEndX = clamp(anchor.x + forkBias * branchReach + random(-0.04, 0.04) * engine.width, engine.width * 0.02, engine.width * 0.98);
      var branchEndY = kind === 'sheet'
        ? clamp(anchor.y + random(-engine.height * 0.03, engine.height * 0.05), 0, horizon + engine.height * 0.05)
        : Math.min(horizon + engine.height * 0.12, anchor.y + random(engine.height * 0.03, engine.height * 0.16) * (0.7 + sizeScale * 0.4));
      var branch = createLightningPath(anchor.x, anchor.y, branchEndX, branchEndY, Math.round(random(3, 5)), engine.width * 0.014 * sizeScale);
      branches.push({ points: branch, strength: random(0.35, 0.9) * (kind === 'distant' || kind === 'sheet' ? 0.7 : 1), delay: random(0, 0.025) });
      if (kind !== 'distant' && kind !== 'sheet' && Math.random() < 0.6 && branch.length > 4) {
        var twigAnchor = branch[Math.floor(branch.length * random(0.3, 0.75))];
        var twig = createLightningPath(
          twigAnchor.x,
          twigAnchor.y,
          clamp(twigAnchor.x + random(-0.12, 0.12) * engine.width * sizeScale, 0, engine.width),
          Math.min(horizon + engine.height * 0.08, twigAnchor.y + random(engine.height * 0.015, engine.height * 0.09)),
          3,
          engine.width * 0.01 * sizeScale
        );
        branches.push({ points: twig, strength: random(0.18, 0.45), delay: random(0.01, 0.04) });
      }
    }
    var peak = kind === 'distant' ? random(0.55, 0.78) : kind === 'near' ? random(0.95, 1) : random(0.75, 0.95);
    var strokes = kind === 'sheet'
      ? [{ at: 0.08, peak: peak * 0.55 }, { at: 0.14, peak: peak * 0.35 }]
      : [{ at: 0.09, peak: peak }, { at: 0.155, peak: peak * 0.58 }, { at: 0.21, peak: peak * 0.34 }];
    if (kind !== 'sheet' && Math.random() < (kind === 'near' ? 0.65 : 0.4)) {
      strokes.push({ at: 0.255, peak: peak * random(0.18, 0.3) });
    }
    return {
      phase: 'cloud', elapsed: 0, cloudFlash: 0, strike: 0, afterglow: 0, exposure: 0, leader: 0,
      main: main, branches: branches, mainSegments: main.length - 1, side: side, strokes: strokes,
      impactX: endX, impactY: endY, sizeScale: sizeScale, kind: kind,
    };
  }

  /** 功能：根据配置计算下一次雷暴的安全等待时间。入参：效果配置。返回：秒数。边界：频率异常时保持 5 至 14 秒的自然间隔。 */
  function nextLightningDelay(config) {
    var frequency = numberConfig(config.lightningFrequency, 0.006, 0.001, 0.03);
    return random(5.5, 12.5) * clamp(0.006 / frequency, 0.55, 1.7);
  }

  /** 功能：在雷击窗口临时抬升画布，同时保留根属性供 CSS 回退。入参：active 是否进入主闪或回闪。返回：无。边界：画布未创建时只更新根属性。 */
  function setLightningForeground(active) {
    if (!isCurrentEngine()) return;
    if (engine.canvas) engine.canvas.style.zIndex = active ? '3' : '';
    if (active) document.documentElement.setAttribute('data-ds-lightning-active', 'true');
    else document.documentElement.removeAttribute('data-ds-lightning-active');
  }

  /** 功能：按多次回击包络计算当前通道亮度。入参：雷暴事件。返回：0-1 亮度。边界：无回击表时回退单峰曲线。 */
  function sampleLightningStroke(event) {
    var strokes = event.strokes || [{ at: 0.1, peak: 1 }];
    var best = 0;
    for (var index = 0; index < strokes.length; index += 1) {
      var stroke = strokes[index];
      var age = event.elapsed - stroke.at;
      if (age < -0.01 || age > 0.085) continue;
      var attack = age < 0 ? clamp((age + 0.01) / 0.01, 0, 1) : 1;
      var decay = age <= 0 ? 1 : Math.exp(-age * 48);
      // 回击尖峰极短，随后迅速衰减，避免“常亮折线”
      var pulse = stroke.peak * attack * decay;
      if (pulse > best) best = pulse;
    }
    return best;
  }

  /** 功能：推进云层预闪、阶梯先导、多次回击与余辉时序。入参：雨景状态、效果配置、帧间隔。返回：无。边界：关闭闪电时清理事件但不影响雨幕。 */
  function updateStormLightning(state, config, deltaSeconds) {
    var model = state.rainModel.lightningModel;
    if (!config.lightning) {
      state.lightningEvent = null;
      setLightningForeground(false);
      model.phase = 'idle';
      model.cloudFlash = 0;
      model.strike = 0;
      model.afterglow = 0;
      model.exposure = 0;
      return;
    }
    state.lightningClock -= deltaSeconds;
    if (!state.lightningEvent && state.lightningClock <= 0) {
      state.lightningEvent = createStormLightning();
      state.lightningClock = nextLightningDelay(config);
      model.cycleCount += 1;
      model.mainSegments = state.lightningEvent.mainSegments;
      model.branchCount = state.lightningEvent.branches.length;
      model.skyLane = state.lightningEvent.side < 0 ? 'left' : 'right';
      model.kind = state.lightningEvent.kind || 'mid';
      model.sizeScale = state.lightningEvent.sizeScale || 1;
    }
    var event = state.lightningEvent;
    if (!event) {
      setLightningForeground(false);
      return;
    }
    event.elapsed += deltaSeconds;
    var firstStrokeAt = event.strokes && event.strokes[0] ? event.strokes[0].at : 0.09;
    var lastStrokeAt = event.strokes && event.strokes.length ? event.strokes[event.strokes.length - 1].at : firstStrokeAt;
    var afterglowStart = lastStrokeAt + 0.09;
    if (event.elapsed < firstStrokeAt * 0.55) {
      event.phase = 'cloud';
      event.leader = 0;
      event.cloudFlash = 0.08 + (event.elapsed / Math.max(0.02, firstStrokeAt * 0.55)) * 0.28;
      event.strike = 0;
      event.exposure = event.cloudFlash * 0.12;
    } else if (event.elapsed < firstStrokeAt) {
      event.phase = 'leader';
      event.leader = clamp((event.elapsed - firstStrokeAt * 0.55) / Math.max(0.02, firstStrokeAt * 0.45), 0, 1) * 0.22;
      event.cloudFlash = 0.28 + event.leader * 0.35;
      event.strike = event.leader * 0.35;
      event.exposure = event.cloudFlash * 0.18;
    } else if (event.elapsed < afterglowStart) {
      event.phase = 'strike';
      event.leader = 0;
      event.strike = sampleLightningStroke(event);
      event.cloudFlash = 0.22 + event.strike * 0.55;
      event.exposure = Math.pow(event.strike, 1.35) * 0.72 + event.cloudFlash * 0.08;
    } else if (event.elapsed < afterglowStart + model.afterglowDuration) {
      event.phase = 'afterglow';
      var fade = 1 - (event.elapsed - afterglowStart) / model.afterglowDuration;
      event.strike = 0.04 * fade;
      event.cloudFlash = 0.14 * fade;
      event.afterglow = 0.22 * fade;
      event.exposure = 0.06 * fade;
    } else {
      state.lightningEvent = null;
      setLightningForeground(false);
      model.phase = 'idle';
      model.cloudFlash = 0;
      model.strike = 0;
      model.afterglow = 0;
      model.exposure = 0;
      return;
    }
    state.lightning = event.strike;
    state.lightningEcho = event.afterglow;
    model.phase = event.phase;
    model.cloudFlash = event.cloudFlash;
    model.strike = event.strike;
    model.afterglow = event.afterglow;
    model.exposure = event.exposure;
    setLightningForeground(event.strike > 0.01 || event.leader > 0.05);
  }

  /** 功能：更新相机空间雨丝、风场、镜头水滴、飞溅和闪电。入参：state、config、deltaSeconds。返回：无。边界：不可见时间不会导致跳帧。 */
  function updateRain(state, config, deltaSeconds) {
    state.gustClock -= deltaSeconds;
    if (state.gustClock <= 0) {
      state.gustClock = random(0.85, 3.1);
      state.windTarget = random(-state.profile.gust, state.profile.gust);
    }
    state.wind = lerp(state.wind, state.windTarget, deltaSeconds * (1.1 + state.profile.gust));
    updateStormLightning(state, config, deltaSeconds);
    for (var index = 0; index < state.streaks.length; index += 1) {
      var drop = state.streaks[index];
      drop.phase += deltaSeconds * 4;
      var nearFactor = clamp((state.profile.farDepth - drop.depth) / Math.max(1, state.profile.farDepth - state.profile.nearDepth), 0, 1);
      var sway = Math.sin(drop.phase) * drop.wobble * (engine.preset === 'rain-gentle' ? 0.025 : 0.08);
      drop.worldX += (drop.windVelocity + state.wind * (0.46 + nearFactor * 0.72) + sway) * deltaSeconds;
      drop.elevation += drop.fallSpeed * deltaSeconds;
      drop.depth -= drop.cameraFlow * deltaSeconds;
      var projected = projectRainPoint(drop.worldX, drop.elevation, drop.depth, state.profile);
      drop.screenX = projected.x;
      drop.screenY = projected.y;
      if (drop.elevation >= state.groundElevation) {
        createSplash(state, drop, config);
        state.streaks[index] = createRainDrop(config, state.profile, false);
        continue;
      }
      if (drop.depth < state.profile.nearDepth * 0.75 || drop.screenX < -engine.width * 0.32 || drop.screenX > engine.width * 1.32 || drop.screenY > engine.height + 80) state.streaks[index] = createRainDrop(config, state.profile, false);
    }
    for (var lensIndex = state.lensDrops.length - 1; lensIndex >= 0; lensIndex -= 1) {
      var lensDrop = state.lensDrops[lensIndex];
      lensDrop.life -= deltaSeconds;
      lensDrop.phase += deltaSeconds * (0.6 + lensDrop.radius * 0.04);
      lensDrop.delay -= deltaSeconds;
      if (lensDrop.delay <= 0) {
        lensDrop.y += lensDrop.velocity * deltaSeconds;
        lensDrop.x += (lensDrop.sway + state.wind * 0.11 + Math.sin(lensDrop.phase) * 0.45) * deltaSeconds * 9;
        lensDrop.tail = Math.min(48, lensDrop.tail + deltaSeconds * (4 + lensDrop.radius));
      }
      if (lensDrop.y > engine.height + lensDrop.radius * 4 || lensDrop.life <= 0) state.lensDrops[lensIndex] = createLensDrop(config, state.profile);
    }
    for (var splashIndex = state.splashes.length - 1; splashIndex >= 0; splashIndex -= 1) {
      var splash = state.splashes[splashIndex];
      splash.x += splash.vx * deltaSeconds;
      splash.y += splash.vy * deltaSeconds;
      splash.vy += 98 * deltaSeconds;
      splash.life -= deltaSeconds * 2.4;
      if (splash.life <= 0) state.splashes.splice(splashIndex, 1);
    }
    for (var sheetIndex = 0; sheetIndex < state.stormSheets.length; sheetIndex += 1) {
      var sheet = state.stormSheets[sheetIndex];
      sheet.phase += deltaSeconds * (0.45 + state.profile.gust * 0.22);
      sheet.x += (sheet.drift + state.wind * 12) * deltaSeconds;
      if (sheet.x - sheet.width > engine.width + engine.width * 0.16) sheet.x = -sheet.width - random(30, engine.width * 0.18);
    }
    for (var sprayIndex = 0; sprayIndex < state.stormSprays.length; sprayIndex += 1) {
      var spray = state.stormSprays[sprayIndex];
      spray.phase += deltaSeconds * (0.4 + state.profile.gust * 0.16);
      spray.depth += spray.drift * deltaSeconds;
      if (spray.depth > 1.08) {
        spray.depth = random(0.12, 0.3);
        spray.side = Math.random() < 0.5 ? -1 : 1;
      }
    }
  }

  /** 功能：绘制贴地湿路面的软反光碎片。入参：state、color。返回：无。边界：道路置信度过低时不绘制，避免在非道路背景生成透视线。 */
  function drawRoadReflection(state, color) {
    var context = engine.ctx;
    var scene = engine.sceneProfile;
    if (scene.roadScore < 0.18) return;
    var intensity = state.profile.reflection * scene.roadScore * 0.24;
    if (intensity <= 0.03) return;
    var horizon = scene.horizonY * engine.height;
    var ground = scene.groundLevel * engine.height;
    var accent = blendColor(color, scene.accentColor, 0.45);
    context.save();
    clipGroundVolume(context, horizon, Math.min(engine.height, ground + engine.height * 0.2), 1.12);
    context.globalCompositeOperation = 'screen';
    for (var index = 0; index < state.roadLines.length; index += 1) {
      var line = state.roadLines[index];
      var originX = scene.vanishingX * engine.width;
      var depth = line.offset;
      var y = lerp(horizon, Math.min(engine.height, ground + engine.height * 0.2), depth * depth);
      var x = originX + line.side * engine.width * (0.025 + depth * 0.32);
      var radiusX = engine.width * (0.012 + depth * 0.055) * line.width;
      var radiusY = 1.5 + depth * 5.5;
      var reflection = context.createRadialGradient(x, y, 0, x, y, radiusX);
      reflection.addColorStop(0, rgba(accent, intensity * (0.09 + line.width * 0.08)));
      reflection.addColorStop(0.42, rgba(accent, intensity * 0.035));
      reflection.addColorStop(1, rgba(accent, 0));
      context.fillStyle = reflection;
      context.fillRect(x - radiusX, y - radiusY, radiusX * 2, radiusY * 2);
    }
    context.restore();
  }

  /** 功能：裁剪沿消失点向前景展开的低空体积区域。入参：context、horizonY、groundY、spread。返回：无。边界：范围会覆盖整个可见路面，避免形成横平蒙版。 */
  function clipGroundVolume(context, horizonY, groundY, spread) {
    var originX = engine.sceneProfile.vanishingX * engine.width;
    var horizonHalfWidth = Math.max(22, engine.width * 0.035);
    var edgePadding = engine.width * Math.max(0, spread - 1) * 0.5;
    context.beginPath();
    context.moveTo(originX - horizonHalfWidth, horizonY);
    context.lineTo(originX + horizonHalfWidth, horizonY);
    context.lineTo(engine.width + edgePadding, groundY);
    context.lineTo(-edgePadding, groundY);
    context.closePath();
    context.clip();
  }

  /** 功能：绘制暴风雨的远景雨幕与贴地横向水汽。入参：state、color。返回：无。边界：非暴风雨预设不产生任何绘制调用。 */
  function drawStormAtmosphere(state, color) {
    if (state.profile.atmosphere !== 'storm-front-v1') return;
    var context = engine.ctx;
    var scene = engine.sceneProfile;
    var horizon = scene.horizonY * engine.height;
    var ground = Math.min(engine.height, scene.groundLevel * engine.height + engine.height * 0.24);
    var originX = scene.vanishingX * engine.width;
    context.save();
    context.globalCompositeOperation = 'screen';
    context.filter = 'blur(8px)';
    for (var sheetIndex = 0; sheetIndex < state.stormSheets.length; sheetIndex += 1) {
      var sheet = state.stormSheets[sheetIndex];
      var sway = Math.sin(sheet.phase) * 18;
      var gradient = context.createLinearGradient(sheet.x - sheet.width, horizon, sheet.x + sheet.width + sway, ground);
      gradient.addColorStop(0, rgba(color, 0));
      gradient.addColorStop(0.42, rgba(color, sheet.opacity * 0.2));
      gradient.addColorStop(0.58, rgba(color, sheet.opacity * 0.46));
      gradient.addColorStop(0.76, rgba(color, sheet.opacity * 0.18));
      gradient.addColorStop(1, rgba(color, 0));
      context.fillStyle = gradient;
      context.fillRect(sheet.x - sheet.width, horizon, sheet.width * 2, ground - horizon);
    }
    context.restore();
    context.save();
    clipGroundVolume(context, horizon, ground, 1.2);
    context.globalCompositeOperation = 'screen';
    context.filter = 'blur(5px)';
    for (var sprayIndex = 0; sprayIndex < state.stormSprays.length; sprayIndex += 1) {
      var spray = state.stormSprays[sprayIndex];
      var depth = clamp(spray.depth, 0, 1);
      var y = lerp(horizon + 12, ground, depth * depth);
      var x = originX + spray.side * engine.width * (0.06 + depth * 0.43);
      var radiusX = engine.width * (0.06 + depth * 0.16);
      var radiusY = 7 + depth * 26;
      var fog = context.createRadialGradient(x, y, 0, x, y, radiusX);
      var alpha = spray.opacity * (0.62 + Math.sin(spray.phase) * 0.24);
      fog.addColorStop(0, rgba(color, alpha));
      fog.addColorStop(0.5, rgba(color, alpha * 0.36));
      fog.addColorStop(1, rgba(color, 0));
      context.fillStyle = fog;
      context.fillRect(x - radiusX, y - radiusY, radiusX * 2, radiusY * 2);
    }
    context.restore();
  }

  /** 功能：描绘一条包含多个折线段的闪电路径。入参：画布上下文、点集、线宽。返回：无。边界：少于两个点时不绘制。 */
  function strokeLightningPath(context, points, width) {
    if (!points || points.length < 2) return;
    context.lineWidth = width;
    context.beginPath();
    context.moveTo(points[0].x, points[0].y);
    for (var index = 1; index < points.length; index += 1) context.lineTo(points[index].x, points[index].y);
    context.stroke();
  }

  /** 功能：绘制全场曝光、云内辉光、多分叉通道与热白芯的逼真雷电。入参：雨景状态、雨色。返回：无。边界：无雷暴事件时不产生绘制；远景/近景按 sizeScale 调整线宽与亮度。 */
  function drawStormLightning(state, color) {
    var event = state.lightningEvent;
    if (!event) return;
    var context = engine.ctx;
    var lightningModel = state.rainModel.lightningModel;
    var sizeScale = numberConfig(event.sizeScale, 1, 0.25, 1.8);
    var kind = event.kind || 'mid';
    var distanceFade = kind === 'distant' ? 0.62 : kind === 'sheet' ? 0.78 : 1;
    var cloudEnergy = (event.cloudFlash + event.afterglow * 0.8) * distanceFade;
    var source = event.main[0];
    var horizon = engine.sceneProfile.horizonY * engine.height;
    var boltEnergy = Math.max(event.strike, event.leader || 0) * distanceFade;
    var exposure = (event.exposure || 0) * (0.55 + sizeScale * 0.45) * distanceFade;
    var outerWidth = lightningModel.outerBoltWidth * sizeScale;
    var coreWidth = lightningModel.coreBoltWidth * Math.max(0.55, sizeScale * 0.92);

    if (exposure > 0.01) {
      context.save();
      context.globalCompositeOperation = 'screen';
      var washRadius = Math.max(engine.width, engine.height) * (0.55 + sizeScale * 0.35);
      var wash = context.createRadialGradient(
        event.impactX || source.x,
        Math.min(horizon, (event.impactY || horizon) * 0.85),
        0,
        event.impactX || source.x,
        Math.min(horizon, source.y + engine.height * 0.1),
        washRadius
      );
      wash.addColorStop(0, rgba('210,230,255', exposure * 0.28));
      wash.addColorStop(0.35, rgba('120,160,220', exposure * 0.12));
      wash.addColorStop(1, rgba('40,70,120', 0));
      context.fillStyle = wash;
      context.fillRect(0, 0, engine.width, engine.height);
      context.restore();
    }

    if (cloudEnergy > 0.002) {
      var radius = Math.max(engine.width * 0.2, Math.min(engine.width * 0.56, engine.height * 0.72)) * (0.75 + sizeScale * 0.35);
      context.save();
      context.globalCompositeOperation = 'screen';
      context.filter = 'blur(18px)';
      var cloudOuter = context.createRadialGradient(source.x, Math.max(0, source.y), 0, source.x, Math.max(0, source.y), radius);
      cloudOuter.addColorStop(0, rgba('186,210,255', cloudEnergy * 0.42));
      cloudOuter.addColorStop(0.4, rgba('96,132,198', cloudEnergy * 0.18));
      cloudOuter.addColorStop(1, rgba('50,78,130', 0));
      context.fillStyle = cloudOuter;
      context.fillRect(source.x - radius, 0, radius * 2, Math.max(horizon + engine.height * 0.28, radius));
      context.filter = 'blur(6px)';
      var cloudCore = context.createRadialGradient(source.x, Math.max(0, source.y * 0.9), 0, source.x, Math.max(0, source.y), radius * 0.45);
      cloudCore.addColorStop(0, rgba('240,248,255', cloudEnergy * 0.5));
      cloudCore.addColorStop(0.55, rgba('160,200,255', cloudEnergy * 0.16));
      cloudCore.addColorStop(1, rgba('120,160,220', 0));
      context.fillStyle = cloudCore;
      context.fillRect(source.x - radius * 0.5, 0, radius, Math.max(horizon + engine.height * 0.12, radius * 0.55));
      context.restore();
    }

    if (boltEnergy <= 0.002) return;
    // 云间片状闪：以云层辉光为主，通道极淡且短
    if (kind === 'sheet' && boltEnergy < 0.2) return;

    var branches = event.branches || [];
    context.save();
    context.globalCompositeOperation = 'screen';
    context.lineCap = 'round';
    context.lineJoin = 'round';

    // 外层紫蓝电晕
    context.filter = 'blur(' + (kind === 'distant' ? 10 : 16) + 'px)';
    context.strokeStyle = rgba('110,92,255', boltEnergy * 0.34);
    strokeLightningPath(context, event.main, outerWidth * 1.35);
    for (var coronaIndex = 0; coronaIndex < branches.length; coronaIndex += 1) {
      var coronaBranch = branches[coronaIndex];
      var coronaPoints = coronaBranch.points || coronaBranch;
      var coronaStrength = (coronaBranch.strength == null ? 0.7 : coronaBranch.strength) * boltEnergy;
      if (event.elapsed < (coronaBranch.delay || 0)) continue;
      context.strokeStyle = rgba('120,100,255', coronaStrength * 0.28);
      strokeLightningPath(context, coronaPoints, outerWidth * 0.7);
    }

    // 中层青蓝辉光
    context.filter = 'blur(6px)';
    context.strokeStyle = rgba('80,170,255', boltEnergy * 0.72);
    strokeLightningPath(context, event.main, outerWidth * 0.72);
    for (var midIndex = 0; midIndex < branches.length; midIndex += 1) {
      var midBranch = branches[midIndex];
      var midPoints = midBranch.points || midBranch;
      var midStrength = (midBranch.strength == null ? 0.7 : midBranch.strength) * boltEnergy;
      if (event.elapsed < (midBranch.delay || 0)) continue;
      context.strokeStyle = rgba('90,180,255', midStrength * 0.55);
      strokeLightningPath(context, midPoints, outerWidth * 0.38);
    }

    // 内层冷白光
    context.filter = 'blur(1.2px)';
    context.strokeStyle = rgba('190,225,255', boltEnergy * 0.95);
    strokeLightningPath(context, event.main, coreWidth + 1.4 * sizeScale);
    for (var haloIndex = 0; haloIndex < branches.length; haloIndex += 1) {
      var haloBranch = branches[haloIndex];
      var haloPoints = haloBranch.points || haloBranch;
      var haloStrength = (haloBranch.strength == null ? 0.7 : haloBranch.strength) * boltEnergy;
      if (event.elapsed < (haloBranch.delay || 0)) continue;
      context.strokeStyle = rgba('170,210,255', haloStrength * 0.72);
      strokeLightningPath(context, haloPoints, coreWidth * 0.7);
    }

    // 热白芯：主通道几乎纯白，分叉略暗且更细
    context.filter = 'none';
    context.strokeStyle = rgba('255,252,245', Math.min(1, boltEnergy * 1.05));
    strokeLightningPath(context, event.main, coreWidth);
    context.strokeStyle = rgba('230,245,255', boltEnergy * 0.75);
    strokeLightningPath(context, event.main, Math.max(0.55, coreWidth * 0.45));
    for (var coreIndex = 0; coreIndex < branches.length; coreIndex += 1) {
      var coreBranch = branches[coreIndex];
      var corePoints = coreBranch.points || coreBranch;
      var coreStrength = (coreBranch.strength == null ? 0.7 : coreBranch.strength) * boltEnergy;
      if (event.elapsed < (coreBranch.delay || 0)) continue;
      context.strokeStyle = rgba('236,246,255', coreStrength * 0.82);
      strokeLightningPath(context, corePoints, Math.max(0.45, coreWidth * 0.42 * (coreBranch.strength == null ? 0.8 : coreBranch.strength)));
    }

    // 落地点短暂溅射辉光：远景/云间闪不画落地溅射
    if (kind !== 'sheet' && kind !== 'distant' && event.strike > 0.18 && event.impactX != null) {
      context.filter = 'blur(8px)';
      var impactRadius = engine.width * (0.05 + sizeScale * 0.045);
      var impact = context.createRadialGradient(event.impactX, event.impactY, 0, event.impactX, event.impactY, impactRadius);
      impact.addColorStop(0, rgba('230,245,255', event.strike * 0.35 * distanceFade));
      impact.addColorStop(0.45, rgba('120,180,255', event.strike * 0.12 * distanceFade));
      impact.addColorStop(1, rgba('80,120,180', 0));
      context.fillStyle = impact;
      context.fillRect(event.impactX - impactRadius, event.impactY - impactRadius * 0.55, impactRadius * 2, impactRadius * 1.2);
    }

    context.restore();
  }

  /** 功能：绘制带高光、暗边和流痕的镜头水滴。入参：context、drop、config。返回：无。边界：水滴不会遮挡大面积内容。 */
  function drawLensDrop(context, drop, config) {
    var color = blendColor(config.color || '174,194,224', engine.sceneProfile.accentColor, 0.18);
    var radius = drop.radius;
    context.save();
    context.translate(drop.x, drop.y);
    context.rotate(drop.sway * 0.06);
    var body = context.createRadialGradient(-radius * 0.34, -radius * 0.42, radius * 0.08, 0, 0, radius * 1.15);
    body.addColorStop(0, rgba('238,247,255', drop.opacity * 0.94));
    body.addColorStop(0.28, rgba(color, drop.opacity * 0.42));
    body.addColorStop(0.74, rgba('18,35,55', drop.opacity * 0.2));
    body.addColorStop(1, rgba('4,12,22', 0));
    context.fillStyle = body;
    context.beginPath();
    context.ellipse(0, 0, radius * 0.84, radius * 1.06, 0, 0, Math.PI * 2);
    context.fill();
    context.strokeStyle = rgba('235,246,255', drop.opacity * 0.58);
    context.lineWidth = Math.max(0.45, radius * 0.09);
    context.beginPath();
    context.arc(-radius * 0.08, -radius * 0.08, radius * 0.76, Math.PI * 1.12, Math.PI * 1.78);
    context.stroke();
    var tail = context.createLinearGradient(0, radius * 0.55, 0, radius + drop.tail);
    tail.addColorStop(0, rgba(color, drop.opacity * 0.32));
    tail.addColorStop(1, rgba(color, 0));
    context.strokeStyle = tail;
    context.lineWidth = Math.max(0.4, radius * 0.21);
    context.beginPath();
    context.moveTo(0, radius * 0.52);
    context.quadraticCurveTo(drop.sway * 2, radius + drop.tail * 0.42, drop.sway * 3, radius + drop.tail);
    context.stroke();
    context.restore();
  }

  /** 功能：绘制远中近分层雨幕、贴地雾和雨面反射。入参：state、config。返回：无。边界：细雨保持稀疏，暴风雨才启用强烈前景。 */
  function drawRain(state, config) {
    var context = engine.ctx;
    var profile = state.profile;
    var color = blendColor(config.color || '174,194,224', engine.sceneProfile.accentColor, 0.14);
    if (config.mist !== false) {
      var rainHorizon = engine.sceneProfile.horizonY * engine.height;
      var rainMistBottom = Math.min(engine.height, engine.sceneProfile.groundLevel * engine.height + engine.height * 0.2);
      var mist = context.createLinearGradient(0, rainHorizon, 0, rainMistBottom);
      mist.addColorStop(0, rgba(color, 0));
      mist.addColorStop(0.48, rgba(color, 0.014 * profile.mist));
      mist.addColorStop(1, rgba(color, 0.028 * profile.mist));
      context.save();
      context.filter = 'blur(16px)';
      context.fillStyle = mist;
      context.fillRect(0, rainHorizon, engine.width, rainMistBottom - rainHorizon);
      context.restore();
    }
    drawStormAtmosphere(state, color);
    drawStormLightning(state, color);
    drawRoadReflection(state, color);
    var sorted = state.streaks.slice().sort(function (left, right) { return right.depth - left.depth; });
    for (var index = 0; index < sorted.length; index += 1) {
      var drop = sorted[index];
      var head = projectRainPoint(drop.worldX, drop.elevation, drop.depth, profile);
      var tailSeconds = Math.min(profile.maxTrailSeconds, profile.trailSeconds * (0.84 + Math.sin(drop.phase) * 0.1));
      var tail = projectRainPoint(
        drop.worldX - drop.windVelocity * tailSeconds,
        drop.elevation - drop.fallSpeed * tailSeconds,
        drop.depth + drop.cameraFlow * tailSeconds,
        profile,
      );
      if (head.x < -engine.width * 0.18 || head.x > engine.width * 1.18 || head.y < -engine.height * 0.2 || head.y > engine.height * 1.1) continue;
      var width = clamp(drop.worldWidth / Math.max(profile.nearDepth * 0.75, drop.depth) * profile.focalLength * engine.width, 0.34, profile.maxForegroundWidth);
      var opacity = drop.opacity * clamp(0.38 + head.scale * 5.2, 0.34, 1);
      if (profile.atmosphere === 'storm-front-v1') opacity *= 0.88;
      var length = Math.hypot(head.x - tail.x, head.y - tail.y);
      if (length < 0.9 || width < 0.42) {
        context.fillStyle = rgba(color, opacity * 0.62);
        context.beginPath();
        context.arc(head.x, head.y, Math.max(0.32, width), 0, Math.PI * 2);
        context.fill();
        continue;
      }
      var useHighlightGradient = profile.atmosphere !== 'storm-front-v1' && width > 0.82 && length > 8;
      if (useHighlightGradient) {
        var streak = context.createLinearGradient(tail.x, tail.y, head.x, head.y);
        streak.addColorStop(0, rgba(color, 0));
        streak.addColorStop(0.56, rgba(color, opacity * 0.48));
        streak.addColorStop(1, rgba('232,244,255', opacity * 0.72));
        context.strokeStyle = streak;
      } else context.strokeStyle = rgba(color, opacity * 0.52);
      context.lineWidth = width;
      context.lineCap = 'round';
      if (useHighlightGradient && width > 1.25 && config.glow !== false) {
        context.shadowColor = rgba(color, opacity * 0.22);
        context.shadowBlur = 1.5 + width * 1.2;
      }
      context.beginPath();
      context.moveTo(tail.x, tail.y);
      context.lineTo(head.x, head.y);
      context.stroke();
    }
    context.shadowBlur = 0;
    for (var lensIndex = 0; lensIndex < state.lensDrops.length; lensIndex += 1) drawLensDrop(context, state.lensDrops[lensIndex], config);
    for (var splashIndex = 0; splashIndex < state.splashes.length; splashIndex += 1) {
      var splash = state.splashes[splashIndex];
      context.fillStyle = rgba(color, splash.life * 0.46);
      context.beginPath();
      context.arc(splash.x, splash.y, splash.size, 0, Math.PI * 2);
      context.fill();
    }
  }

  /** 功能：初始化高空雾丝、地平线雾带和近地体积雾。入参：config。返回：雾体积层与诊断状态。边界：保持 4/6 层契约；高空不整屏蒙版，近地雾锚定消失点。 */
  function initializeFog(config) {
    var layers = Math.round(numberConfig(config.layers, 4, 3, 6));
    var skyLayers = Math.round(numberConfig(config.skyLayers, 6, 4, 7));
    var puffsPerLayer = 6;
    var puffs = [];
    var streams = [];
    var skySheets = [];
    var horizon = engine.sceneProfile.horizonY;
    var ground = engine.sceneProfile.groundLevel;
    var opacity = numberConfig(config.opacity, 0.62, 0, 1);
    var density = numberConfig(config.density, 0.82, 0, 1);
    var skyBandStart = Math.max(0.04, horizon - 0.4);
    var skyBandEnd = clamp(horizon + 0.02, skyBandStart + 0.22, 0.56);
    var horizonBandEnd = horizon + (ground - horizon) * 0.48;
    var midBandEnd = horizon + (ground - horizon) * 0.82;
    var groundBandEnd = Math.min(0.97, ground + 0.2);
    for (var skyIndex = 0; skyIndex < skyLayers; skyIndex += 1) {
      var skyProgress = (skyIndex + 0.5) / skyLayers;
      skySheets.push({
        lateral: clamp(-0.92 + skyProgress * 1.84 + random(-0.12, 0.12), -1, 1),
        altitude: clamp(skyProgress + random(-0.08, 0.08), 0.03, 0.97),
        widthFactor: random(0.85, 1.35),
        thicknessFactor: random(0.55, 1.05),
        velocity: random(0.028, 0.08),
        direction: skyIndex % 2 === 0 ? 1 : -1,
        sway: random(0.02, 0.06),
        phase: random(0, Math.PI * 2),
        // 细长雾丝 vs 宽雾团，交替出现更有空气感
        filament: skyIndex % 2 === 1,
      });
    }
    for (var layer = 0; layer < layers; layer += 1) {
      var progress = (layer + 0.5) / layers;
      for (var index = 0; index < puffsPerLayer; index += 1) {
        puffs.push({
          lateral: random(-1, 1),
          progress: clamp(progress + random(-0.12, 0.12), 0.04, 1),
          radiusFactor: random(0.7, 1.35),
          aspect: random(1.6, 2.8),
          velocity: random(0.1, 0.3) * (0.4 + progress),
          direction: (layer + index) % 2 === 0 ? 1 : -1,
          phase: random(0, Math.PI * 2),
        });
      }
    }
    for (var streamIndex = 0; streamIndex < Math.max(3, Math.round(layers * 0.9)); streamIndex += 1) {
      streams.push({
        lateral: random(-0.96, 0.96),
        progress: clamp((streamIndex + 0.5) / Math.max(3, Math.round(layers * 0.9)) + random(-0.13, 0.13), 0.08, 0.94),
        widthFactor: random(0.9, 1.45),
        velocity: random(0.06, 0.16),
        direction: streamIndex % 2 === 0 ? 1 : -1,
        sway: random(0.035, 0.11),
        phase: random(0, Math.PI * 2),
      });
    }
    return {
      puffs: puffs,
      streams: streams,
      skySheets: skySheets,
      clock: 0,
      fogModel: {
        projection: 'layered-atmosphere-v2',
        driftModel: 'multi-altitude-bidirectional-sway-v2',
        layers: layers,
        puffCount: puffs.length,
        streams: streams.length,
        skyLayers: skyLayers,
        skySheets: skySheets.length,
        streamOffset: streams.length > 0 ? streams[0].lateral : 0,
        skyOffset: skySheets.length > 0 ? skySheets[0].lateral : 0,
        skyBandStart: skyBandStart,
        skyBandEnd: skyBandEnd,
        horizonBandEnd: horizonBandEnd,
        midBandEnd: midBandEnd,
        groundBandEnd: groundBandEnd,
        // 质量优先：够见，但不糊成白蒙
        skyBandOpacity: opacity * density * 0.36,
        horizonBandOpacity: opacity * density * 0.28,
        nearBandOpacity: opacity * density * 0.18,
      },
    };
  }

  /** 功能：更新高空/中景/近地雾的视差漂移与呼吸。入参：state、config、deltaSeconds。返回：无。边界：边缘软反转，避免跳变。 */
  function updateFog(state, config, deltaSeconds) {
    state.clock += deltaSeconds;
    var speed = numberConfig(config.speed, 0.26, 0.02, 2);
    for (var skyIndex = 0; skyIndex < state.skySheets.length; skyIndex += 1) {
      var skySheet = state.skySheets[skyIndex];
      skySheet.phase += deltaSeconds * (0.05 + skySheet.altitude * 0.06);
      // 高空更慢，形成视差
      skySheet.lateral += skySheet.direction * skySheet.velocity * speed * 0.85 * deltaSeconds;
      if (skySheet.lateral > 1.02 || skySheet.lateral < -1.02) {
        skySheet.lateral = clamp(skySheet.lateral, -1.02, 1.02);
        skySheet.direction *= -1;
      }
    }
    for (var index = 0; index < state.puffs.length; index += 1) {
      var puff = state.puffs[index];
      puff.phase += deltaSeconds * (0.09 + puff.progress * 0.14);
      puff.lateral += puff.direction * puff.velocity * speed * (1.15 + puff.progress * 0.55) * deltaSeconds;
      if (puff.lateral > 1.14 || puff.lateral < -1.14) {
        puff.lateral = clamp(puff.lateral, -1.14, 1.14);
        puff.direction *= -1;
      }
    }
    for (var streamIndex = 0; streamIndex < state.streams.length; streamIndex += 1) {
      var stream = state.streams[streamIndex];
      stream.phase += deltaSeconds * (0.11 + stream.progress * 0.18);
      stream.lateral += stream.direction * stream.velocity * speed * (1.05 + stream.progress * 0.7) * deltaSeconds;
      if (stream.lateral > 1.1 || stream.lateral < -1.1) {
        stream.lateral = clamp(stream.lateral, -1.1, 1.1);
        stream.direction *= -1;
      }
    }
    if (state.streams.length > 0) state.fogModel.streamOffset = state.streams[0].lateral;
    if (state.skySheets.length > 0) state.fogModel.skyOffset = state.skySheets[0].lateral;
  }

  /** 功能：绘制分层体积雾——细长高空雾丝、柔和地平线霾、近地横向雾团。入参：state、config。返回：无。边界：不用整屏实心蒙版，保留背景细节。 */
  function drawFog(state, config) {
    var context = engine.ctx;
    var baseColor = blendColor(config.color || '198,214,228', engine.sceneProfile.accentColor, 0.1);
    var skyColor = blendColor(baseColor, '176,200,224', 0.45);
    var groundColor = blendColor(baseColor, '210,218,226', 0.35);
    var density = numberConfig(config.density, 0.82, 0, 1);
    var opacity = numberConfig(config.opacity, 0.62, 0, 1);
    if (density <= 0 || opacity <= 0) return;
    var scene = engine.sceneProfile;
    var horizon = scene.horizonY * engine.height;
    var originX = scene.vanishingX * engine.width;
    var skyBandStart = state.fogModel.skyBandStart * engine.height;
    var skyBandEnd = state.fogModel.skyBandEnd * engine.height;
    var horizonBandEnd = state.fogModel.horizonBandEnd * engine.height;
    var midBandEnd = state.fogModel.midBandEnd * engine.height;
    var groundBandEnd = state.fogModel.groundBandEnd * engine.height;
    var horizonBandOpacity = state.fogModel.horizonBandOpacity;
    var nearBandOpacity = state.fogModel.nearBandOpacity;
    var skyBandOpacity = state.fogModel.skyBandOpacity;

    // 1) 高空：细长雾丝 + 少量宽团，大模糊但低不透明度
    context.save();
    context.filter = 'blur(' + Math.round(16 + density * 10) + 'px)';
    context.globalCompositeOperation = 'screen';
    for (var skyIndex = 0; skyIndex < state.skySheets.length; skyIndex += 1) {
      var skySheet = state.skySheets[skyIndex];
      var skyWave = Math.sin(skySheet.phase) * skySheet.sway;
      var skyY = lerp(skyBandStart, skyBandEnd, skySheet.altitude) + Math.cos(skySheet.phase * 0.6) * (2 + skySheet.altitude * 6);
      var skySpread = engine.width * 0.62;
      var skyX = engine.width * 0.5 + (skySheet.lateral + skyWave) * skySpread;
      var skyRadiusX = engine.width * (skySheet.filament ? 0.34 : 0.22) * skySheet.widthFactor;
      var skyRadiusY = (skySheet.filament ? 14 : 26) * skySheet.thicknessFactor * (0.7 + skySheet.altitude * 0.5);
      var skyAlpha = skyBandOpacity * (0.7 + Math.sin(skySheet.phase * 0.55) * 0.18) * (skySheet.filament ? 0.75 : 1);
      var skyGradient = context.createRadialGradient(skyX, skyY, 0, skyX, skyY, skyRadiusX);
      skyGradient.addColorStop(0, rgba(skyColor, skyAlpha * 0.85));
      skyGradient.addColorStop(0.45, rgba(skyColor, skyAlpha * 0.4));
      skyGradient.addColorStop(1, rgba(skyColor, 0));
      context.fillStyle = skyGradient;
      context.fillRect(skyX - skyRadiusX, skyY - skyRadiusY, skyRadiusX * 2, skyRadiusY * 2);
    }
    context.restore();

    // 2) 地平线：柔和窄霾，避免整条白带
    context.save();
    context.globalCompositeOperation = 'screen';
    var distantHaze = context.createLinearGradient(0, horizon - 40, 0, horizonBandEnd + 24);
    distantHaze.addColorStop(0, rgba(groundColor, 0));
    distantHaze.addColorStop(0.35, rgba(groundColor, horizonBandOpacity * 0.35));
    distantHaze.addColorStop(0.58, rgba(groundColor, horizonBandOpacity * 0.7));
    distantHaze.addColorStop(0.82, rgba(groundColor, horizonBandOpacity * 0.28));
    distantHaze.addColorStop(1, rgba(groundColor, 0));
    context.fillStyle = distantHaze;
    context.fillRect(0, horizon - 40, engine.width, horizonBandEnd - horizon + 64);
    context.restore();

    // 3) 中景横向雾丝：沿消失点两侧铺开
    context.save();
    context.filter = 'blur(' + Math.round(10 + density * 8) + 'px)';
    context.globalCompositeOperation = 'screen';
    for (var streamIndex = 0; streamIndex < state.streams.length; streamIndex += 1) {
      var stream = state.streams[streamIndex];
      var streamDepth = stream.progress;
      var streamWave = Math.sin(stream.phase) * stream.sway;
      var streamY = lerp(horizon + 8, midBandEnd, streamDepth * streamDepth) + Math.cos(stream.phase * 0.7) * (2 + streamDepth * 5);
      var streamSpread = engine.width * (0.28 + streamDepth * 0.5);
      var streamX = originX + (stream.lateral + streamWave) * streamSpread;
      var streamRadiusX = engine.width * (0.16 + streamDepth * 0.22) * stream.widthFactor;
      var streamRadiusY = 9 + streamDepth * 20;
      var streamAlpha = nearBandOpacity * (0.7 + streamDepth * 0.45) * (0.82 + Math.sin(stream.phase * 0.65) * 0.14);
      var streamGradient = context.createRadialGradient(streamX, streamY, 0, streamX, streamY, streamRadiusX);
      streamGradient.addColorStop(0, rgba(groundColor, streamAlpha * 0.9));
      streamGradient.addColorStop(0.5, rgba(groundColor, streamAlpha * 0.35));
      streamGradient.addColorStop(1, rgba(groundColor, 0));
      context.fillStyle = streamGradient;
      context.fillRect(streamX - streamRadiusX, streamY - streamRadiusY, streamRadiusX * 2, streamRadiusY * 2);
    }

    // 4) 近地体积雾团：扁长椭球形，贴着地面扩张
    for (var index = 0; index < state.puffs.length; index += 1) {
      var puff = state.puffs[index];
      var depth = puff.progress;
      var breath = 0.84 + Math.sin(puff.phase) * 0.16;
      var y = lerp(horizonBandEnd, groundBandEnd, depth * depth) + Math.cos(puff.phase * 0.55) * (1.5 + depth * 4);
      var spread = engine.width * (0.1 + depth * 0.58);
      var x = originX + (puff.lateral + Math.sin(puff.phase) * 0.03) * spread;
      var radiusX = engine.width * (0.06 + depth * 0.2) * puff.radiusFactor;
      var radiusY = (8 + depth * 22) / Math.max(1.2, puff.aspect || 2);
      var alpha = opacity * density * (0.08 + depth * 0.16) * breath;
      var gradient = context.createRadialGradient(x, y, 0, x, y, radiusX);
      gradient.addColorStop(0, rgba(groundColor, alpha));
      gradient.addColorStop(0.48, rgba(groundColor, alpha * 0.42));
      gradient.addColorStop(1, rgba(groundColor, 0));
      context.fillStyle = gradient;
      context.fillRect(x - radiusX, y - radiusY, radiusX * 2, radiusY * 2);
    }
    context.restore();
  }

  /** 功能：初始化具有景深、色温和辉光分层的浮动粒子。入参：config。返回：粒子状态。边界：数量按质量等级下调。 */
  function initializeParticles(config) {
    var count = Math.round(numberConfig(config.count, 60, 12, 320) * engine.quality);
    var particles = [];
    var minSize = numberConfig(config.sizeMin, 1, 0.2, 12);
    var maxSize = Math.max(minSize, numberConfig(config.sizeMax, 3, minSize, 18));
    var baseOpacity = numberConfig(config.opacity, 0.5, 0.05, 1);
    for (var index = 0; index < count; index += 1) {
      var depth = Math.pow(random(0.05, 1), 0.85);
      var tintRoll = Math.random();
      particles.push({
        x: random(0, engine.width),
        y: random(engine.sceneProfile.horizonY * engine.height * 0.85, engine.height + 20),
        depth: depth,
        size: lerp(minSize, maxSize, depth * random(0.55, 1)),
        velocityX: random(-10, 10) * (0.35 + depth),
        velocityY: random(-12, -2.5) * (0.22 + depth),
        phase: random(0, Math.PI * 2),
        phaseSpeed: random(0.45, 2.1),
        opacity: random(0.42, 0.95) * baseOpacity,
        tint: tintRoll < 0.4 ? 'warm' : tintRoll < 0.75 ? 'cool' : 'accent',
        sparkle: Math.random() < 0.32,
      });
    }
    return { particles: particles, clock: 0, gust: 0, gustTarget: 0, gustClock: random(0.8, 2.2) };
  }

  /** 功能：更新粒子微风阵风、漂浮与循环重生。入参：state、config、deltaSeconds。返回：无。边界：越界后从底部或侧边平滑重生。 */
  function updateParticles(state, config, deltaSeconds) {
    state.clock += deltaSeconds;
    state.gustClock -= deltaSeconds;
    if (state.gustClock <= 0) {
      state.gustClock = random(0.9, 2.6);
      state.gustTarget = random(-1.4, 1.4) * numberConfig(config.drift, 0.3, 0, 3);
    }
    state.gust = lerp(state.gust, state.gustTarget, deltaSeconds * 2.2);
    var drift = numberConfig(config.drift, 0.3, 0, 3);
    var speed = numberConfig(config.speed, 0.5, 0.05, 4);
    var skyLine = engine.sceneProfile.horizonY * engine.height;
    for (var index = 0; index < state.particles.length; index += 1) {
      var particle = state.particles[index];
      particle.phase += particle.phaseSpeed * deltaSeconds * 1.35;
      particle.x += (particle.velocityX + Math.sin(state.clock * 0.9 + particle.phase) * 14 * drift + state.gust * 28 * particle.depth) * deltaSeconds;
      particle.y += (particle.velocityY * speed * 1.25 + Math.cos(state.clock * 0.7 + particle.phase) * 4.2) * deltaSeconds;
      if (particle.y < skyLine - 28) {
        particle.y = engine.height + random(8, 36);
        particle.x = random(0, engine.width);
        particle.phase = random(0, Math.PI * 2);
      }
      if (particle.x < -36) particle.x = engine.width + 36;
      if (particle.x > engine.width + 36) particle.x = -36;
    }
  }

  /** 功能：绘制高对比离焦光斑、色温变化与近景视差。入参：state、config。返回：无。边界：几乎全部粒子带 bloom，保证预览中肉眼可见。 */
  function drawParticles(state, config) {
    var context = engine.ctx;
    var base = blendColor(config.color || '255,255,255', engine.sceneProfile.accentColor, 0.28);
    var warm = blendColor(base, '255,200,120', 0.7);
    var cool = blendColor(base, '140,200,255', 0.7);
    var accent = blendColor(base, engine.sceneProfile.accentColor, 0.85);
    var parallaxX = (engine.pointerX - 0.5) * 18;
    var parallaxY = (engine.pointerY - 0.5) * 12;
    context.save();
    context.globalCompositeOperation = 'screen';
    for (var index = 0; index < state.particles.length; index += 1) {
      var particle = state.particles[index];
      var twinkle = 0.55 + (Math.sin(particle.phase) + 1) * 0.35;
      if (particle.sparkle) twinkle *= 0.85 + (Math.sin(particle.phase * 5.2) + 1) * 0.28;
      var alpha = Math.min(1, particle.opacity * twinkle * 1.35);
      var x = particle.x + parallaxX * particle.depth;
      var y = particle.y + parallaxY * particle.depth;
      var color = particle.tint === 'warm' ? warm : particle.tint === 'cool' ? cool : accent;
      var radius = particle.size * (0.75 + particle.depth * 1.05);
      var bloomRadius = radius * (particle.depth > 0.45 ? 4.8 : 3.2);
      var bloom = context.createRadialGradient(x, y, 0, x, y, bloomRadius);
      bloom.addColorStop(0, rgba('255,252,240', alpha));
      bloom.addColorStop(0.18, rgba(color, alpha * 0.85));
      bloom.addColorStop(0.5, rgba(color, alpha * 0.32));
      bloom.addColorStop(1, rgba(color, 0));
      context.fillStyle = bloom;
      context.fillRect(x - bloomRadius, y - bloomRadius, bloomRadius * 2, bloomRadius * 2);
      context.fillStyle = rgba('255,255,255', alpha * 0.9);
      context.beginPath();
      context.arc(x, y, Math.max(0.8, radius * 0.45), 0, Math.PI * 2);
      context.fill();
    }
    context.restore();
  }

  /** 功能：初始化质量优先的分层雪花（远点/中斑/近晶体）。入参：config。返回：雪花状态。边界：数量默认 70，避免糊成雪幕。 */
  function initializeSnow(config) {
    var count = Math.round(numberConfig(config.count, 70, 16, 120) * engine.quality);
    var minSize = numberConfig(config.sizeMin, 1.1, 0.2, 12);
    var maxSize = Math.max(minSize, numberConfig(config.sizeMax, 5.2, minSize, 14));
    var baseOpacity = numberConfig(config.opacity, 0.68, 0.05, 1);
    var flakes = [];
    for (var index = 0; index < count; index += 1) {
      var roll = Math.random();
      // 远 55% / 中 30% / 近 15%：近景晶体少而精
      var layer = roll < 0.55 ? 'far' : roll < 0.85 ? 'mid' : 'near';
      var depth = layer === 'far' ? random(0.08, 0.38) : layer === 'mid' ? random(0.4, 0.72) : random(0.78, 1);
      var size = layer === 'far'
        ? lerp(minSize * 0.55, minSize * 1.1, random(0, 1))
        : layer === 'mid'
          ? lerp(minSize * 1.1, maxSize * 0.62, random(0, 1))
          : lerp(maxSize * 0.62, maxSize, random(0, 1));
      flakes.push({
        x: random(-16, engine.width + 16),
        y: random(-engine.height * 0.2, engine.height),
        depth: depth,
        layer: layer,
        size: size,
        velocity: (layer === 'far' ? random(10, 18) : layer === 'mid' ? random(16, 28) : random(22, 34)) * (0.55 + depth * 0.45),
        drift: (layer === 'far' ? random(3, 8) : layer === 'mid' ? random(6, 14) : random(8, 16)) * (0.5 + depth * 0.5),
        phase: random(0, Math.PI * 2),
        phaseSpeed: random(0.35, 0.85),
        rotation: random(0, Math.PI * 2),
        rotationSpeed: layer === 'near' ? random(-0.55, 0.55) : random(-0.25, 0.25),
        opacity: (layer === 'far' ? random(0.22, 0.42) : layer === 'mid' ? random(0.38, 0.62) : random(0.55, 0.82)) * baseOpacity,
        swayAmp: random(0.65, 1.15),
      });
    }
    return { flakes: flakes, windSmooth: 0 };
  }

  /** 功能：更新雪花的轻柔下落、侧摆与缓慢旋转。入参：state、config、deltaSeconds。返回：无。边界：越界后从顶部稀疏重生。 */
  function updateSnow(state, config, deltaSeconds) {
    var wind = numberConfig(config.wind, 0.22, -2, 2);
    var swing = numberConfig(config.swing, 0.48, 0, 2);
    var speed = numberConfig(config.speed, 0.88, 0.2, 3);
    state.windSmooth = lerp(state.windSmooth, wind, deltaSeconds * 0.7);
    for (var index = 0; index < state.flakes.length; index += 1) {
      var flake = state.flakes[index];
      flake.phase += deltaSeconds * flake.phaseSpeed;
      // 双频摆动，比单一 sin 更自然，但不夸张
      var sway = Math.sin(flake.phase) * 0.72 + Math.sin(flake.phase * 0.37 + flake.depth) * 0.28;
      flake.y += flake.velocity * speed * deltaSeconds * (0.92 + Math.sin(flake.phase * 0.4) * 0.06);
      flake.x += (state.windSmooth * 12 * flake.depth + sway * flake.drift * swing * flake.swayAmp) * deltaSeconds;
      flake.rotation += flake.rotationSpeed * deltaSeconds;
      if (flake.y > engine.height + 24) {
        flake.y = -random(12, 48);
        flake.x = random(-16, engine.width + 16);
        flake.phase = random(0, Math.PI * 2);
      }
      if (flake.x < -28) flake.x = engine.width + 20;
      if (flake.x > engine.width + 28) flake.x = -20;
    }
  }

  /** 功能：绘制精致分层雪：远景柔点、中景软斑、近景细线六瓣晶体。入参：state、config。返回：无。边界：近景晶体数量少，避免厚重光晕糊屏。 */
  function drawSnow(state, config) {
    var context = engine.ctx;
    var color = blendColor(config.color || '255,255,255', '230,240,255', 0.2);
    // 远→近绘制，保证近景晶体压在上面
    var ordered = state.flakes.slice().sort(function (a, b) { return a.depth - b.depth; });
    context.save();
    for (var index = 0; index < ordered.length; index += 1) {
      var flake = ordered[index];
      var breathe = 0.92 + Math.sin(flake.phase * 0.8) * 0.08;
      var alpha = flake.opacity * breathe;
      if (flake.layer === 'far') {
        context.globalCompositeOperation = 'source-over';
        context.fillStyle = rgba(color, alpha * 0.85);
        context.beginPath();
        context.arc(flake.x, flake.y, Math.max(0.55, flake.size * 0.45), 0, Math.PI * 2);
        context.fill();
        continue;
      }
      if (flake.layer === 'mid') {
        context.globalCompositeOperation = 'screen';
        var soft = context.createRadialGradient(flake.x, flake.y, 0, flake.x, flake.y, flake.size * 1.6);
        soft.addColorStop(0, rgba('255,255,255', alpha * 0.75));
        soft.addColorStop(0.55, rgba(color, alpha * 0.28));
        soft.addColorStop(1, rgba(color, 0));
        context.fillStyle = soft;
        context.fillRect(flake.x - flake.size * 1.6, flake.y - flake.size * 1.6, flake.size * 3.2, flake.size * 3.2);
        continue;
      }
      // 近景：细线六瓣晶体 + 极轻中心光
      context.globalCompositeOperation = 'screen';
      var coreGlow = context.createRadialGradient(flake.x, flake.y, 0, flake.x, flake.y, flake.size * 1.15);
      coreGlow.addColorStop(0, rgba('255,255,255', alpha * 0.35));
      coreGlow.addColorStop(1, rgba(color, 0));
      context.fillStyle = coreGlow;
      context.fillRect(flake.x - flake.size * 1.15, flake.y - flake.size * 1.15, flake.size * 2.3, flake.size * 2.3);
      context.save();
      context.translate(flake.x, flake.y);
      context.rotate(flake.rotation);
      context.globalCompositeOperation = 'source-over';
      context.strokeStyle = rgba('245,250,255', alpha * 0.92);
      context.fillStyle = rgba('255,255,255', alpha * 0.9);
      context.lineWidth = Math.max(0.55, flake.size * 0.085);
      context.lineCap = 'round';
      context.lineJoin = 'round';
      context.beginPath();
      context.arc(0, 0, Math.max(0.5, flake.size * 0.1), 0, Math.PI * 2);
      context.fill();
      for (var arm = 0; arm < 6; arm += 1) {
        var angle = arm * Math.PI / 3;
        var cos = Math.cos(angle);
        var sin = Math.sin(angle);
        var tip = flake.size * 0.92;
        context.beginPath();
        context.moveTo(cos * flake.size * 0.12, sin * flake.size * 0.12);
        context.lineTo(cos * tip, sin * tip);
        context.stroke();
        // 两级侧枝，形成更像真实雪晶的结构
        var b1 = tip * 0.42;
        var b2 = tip * 0.68;
        var side = flake.size * 0.22;
        var px = -sin;
        var py = cos;
        context.beginPath();
        context.moveTo(cos * b1 + px * side, sin * b1 + py * side);
        context.lineTo(cos * b1, sin * b1);
        context.lineTo(cos * b1 - px * side, sin * b1 - py * side);
        context.stroke();
        context.beginPath();
        context.moveTo(cos * b2 + px * side * 0.7, sin * b2 + py * side * 0.7);
        context.lineTo(cos * b2, sin * b2);
        context.lineTo(cos * b2 - px * side * 0.7, sin * b2 - py * side * 0.7);
        context.stroke();
      }
      context.restore();
    }
    context.restore();
  }

  /** 功能：初始化真实夜空风格星点（多数针点 + 少量亮星）。入参：config。返回：星空状态。边界：仅分布在地平线以上，避免地面出现假星。 */
  function initializeStars(config) {
    var count = Math.round(numberConfig(config.count, 160, 40, 320) * engine.quality);
    var minSize = numberConfig(config.sizeMin, 0.35, 0.15, 4);
    var maxSize = Math.max(minSize, numberConfig(config.sizeMax, 1.35, minSize, 6));
    var baseOpacity = numberConfig(config.opacity, 0.78, 0.05, 1);
    var stars = [];
    var skyBottom = Math.max(engine.height * 0.26, engine.sceneProfile.horizonY * engine.height * 0.98);
    for (var index = 0; index < count; index += 1) {
      var roll = Math.random();
      // 背景场星 78% / 普通星 17% / 亮星 5%
      var rank = roll < 0.78 ? 'field' : roll < 0.95 ? 'normal' : 'bright';
      var tintRoll = Math.random();
      var radius = rank === 'field'
        ? random(minSize * 0.7, minSize * 1.15)
        : rank === 'normal'
          ? random(minSize * 1.05, maxSize * 0.75)
          : random(maxSize * 0.75, maxSize);
      stars.push({
        x: random(0, engine.width),
        // 略偏上半天空更密，贴近真实夜空观感
        y: Math.pow(random(0, 1), 1.15) * skyBottom,
        rank: rank,
        radius: radius,
        phase: random(0, Math.PI * 2),
        speed: rank === 'bright' ? random(0.55, 1.2) : random(0.25, 0.9),
        opacity: (rank === 'field' ? random(0.18, 0.42) : rank === 'normal' ? random(0.4, 0.7) : random(0.7, 0.95)) * baseOpacity,
        tint: tintRoll < 0.62 ? 'white' : tintRoll < 0.86 ? 'blue' : 'gold',
        // 只有极少数亮星带细衍射芒，避免贴纸十字星
        spike: rank === 'bright' && Math.random() < 0.55,
      });
    }
    return { stars: stars, shootingStars: [], nextShooting: random(4, 9) };
  }

  /** 功能：更新星点轻微闪烁与流星轨迹。入参：state、config、deltaSeconds。返回：无。边界：关闭流星后已有轨迹自然消失。 */
  function updateStars(state, config, deltaSeconds) {
    var twinkleSpeed = numberConfig(config.twinkleSpeed, 0.85, 0.1, 5);
    for (var index = 0; index < state.stars.length; index += 1) {
      var star = state.stars[index];
      // 亮星闪得稍明显，场星几乎不动
      var rate = star.rank === 'bright' ? 1.15 : star.rank === 'normal' ? 0.85 : 0.45;
      star.phase += star.speed * twinkleSpeed * rate * deltaSeconds;
    }
    state.nextShooting -= deltaSeconds;
    if (config.shootingStars !== false && state.nextShooting <= 0) {
      var angle = random(-0.48, -0.18);
      var speed = random(340, 520);
      state.shootingStars.push({
        x: random(engine.width * 0.08, engine.width * 0.75),
        y: random(engine.height * 0.04, engine.height * 0.26),
        velocityX: Math.cos(angle) * speed,
        velocityY: Math.sin(angle) * -speed * 0.5 + random(80, 160),
        length: random(100, 190),
        width: random(1.0, 1.7),
        life: 1,
      });
      state.nextShooting = random(3.5, 8.5) / Math.sqrt(numberConfig(config.shootingFrequency, 0.004, 0.0005, 0.08) / 0.004);
    }
    for (var shootingIndex = state.shootingStars.length - 1; shootingIndex >= 0; shootingIndex -= 1) {
      var shooting = state.shootingStars[shootingIndex];
      shooting.x += shooting.velocityX * deltaSeconds;
      shooting.y += shooting.velocityY * deltaSeconds;
      shooting.life -= deltaSeconds * 0.8;
      if (shooting.life <= 0 || shooting.x > engine.width + 200 || shooting.y > engine.height + 120) {
        state.shootingStars.splice(shootingIndex, 1);
      }
    }
  }

  /** 功能：绘制真实感针点星空，并保留可用的流星尾迹。入参：state、config。返回：无。边界：禁止大光斑与粗十字，仅亮星可有极细芒线。 */
  function drawStars(state, config) {
    var context = engine.ctx;
    context.save();
    context.globalCompositeOperation = 'screen';
    for (var index = 0; index < state.stars.length; index += 1) {
      var star = state.stars[index];
      // 闪烁只改亮度，不改尺寸，避免“泡泡星”
      var twinkle = star.rank === 'field'
        ? 0.82 + Math.sin(star.phase) * 0.1
        : star.rank === 'normal'
          ? 0.72 + Math.sin(star.phase) * 0.18 + Math.sin(star.phase * 1.7) * 0.06
          : 0.62 + Math.sin(star.phase) * 0.24 + Math.sin(star.phase * 2.1) * 0.08;
      var alpha = clamp(star.opacity * twinkle, 0, 1);
      var color = star.tint === 'blue' ? '198,220,255'
        : star.tint === 'gold' ? '255,236,210'
        : '245,248,255';
      var r = star.radius;
      if (star.rank === 'bright') {
        // 亮星：极小芯 + 很短的柔晕，仍保持针点感
        var soft = context.createRadialGradient(star.x, star.y, 0, star.x, star.y, r * 2.4);
        soft.addColorStop(0, rgba('255,255,255', alpha * 0.95));
        soft.addColorStop(0.35, rgba(color, alpha * 0.35));
        soft.addColorStop(1, rgba(color, 0));
        context.fillStyle = soft;
        context.fillRect(star.x - r * 2.4, star.y - r * 2.4, r * 4.8, r * 4.8);
        if (star.spike) {
          context.strokeStyle = rgba('255,255,255', alpha * 0.35);
          context.lineWidth = 0.45;
          context.beginPath();
          context.moveTo(star.x - r * 2.1, star.y);
          context.lineTo(star.x + r * 2.1, star.y);
          context.moveTo(star.x, star.y - r * 2.1);
          context.lineTo(star.x, star.y + r * 2.1);
          context.stroke();
        }
      } else if (star.rank === 'normal') {
        context.fillStyle = rgba(color, alpha * 0.55);
        context.beginPath();
        context.arc(star.x, star.y, Math.max(0.55, r * 0.85), 0, Math.PI * 2);
        context.fill();
        context.fillStyle = rgba('255,255,255', alpha);
        context.beginPath();
        context.arc(star.x, star.y, Math.max(0.35, r * 0.45), 0, Math.PI * 2);
        context.fill();
      } else {
        // 场星：单像素级小点
        context.fillStyle = rgba(color, alpha);
        context.fillRect(star.x, star.y, Math.max(0.7, r), Math.max(0.7, r));
      }
    }
    // 流星：保留并略作克制，继续可用
    for (var shootingIndex = 0; shootingIndex < state.shootingStars.length; shootingIndex += 1) {
      var shooting = state.shootingStars[shootingIndex];
      var speed = Math.sqrt(shooting.velocityX * shooting.velocityX + shooting.velocityY * shooting.velocityY) || 1;
      var unitX = shooting.velocityX / speed;
      var unitY = shooting.velocityY / speed;
      var tailX = shooting.x - unitX * shooting.length;
      var tailY = shooting.y - unitY * shooting.length;
      context.filter = 'blur(1.2px)';
      var glow = context.createLinearGradient(shooting.x, shooting.y, tailX, tailY);
      glow.addColorStop(0, rgba('255,255,255', shooting.life * 0.45));
      glow.addColorStop(0.45, rgba('210,230,255', shooting.life * 0.16));
      glow.addColorStop(1, rgba('210,230,255', 0));
      context.strokeStyle = glow;
      context.lineWidth = (shooting.width || 1.3) * 1.8;
      context.beginPath();
      context.moveTo(shooting.x, shooting.y);
      context.lineTo(tailX, tailY);
      context.stroke();
      context.filter = 'none';
      var core = context.createLinearGradient(shooting.x, shooting.y, tailX, tailY);
      core.addColorStop(0, rgba('255,255,255', shooting.life * 0.95));
      core.addColorStop(0.3, rgba('255,245,230', shooting.life * 0.5));
      core.addColorStop(1, rgba('210,230,255', 0));
      context.strokeStyle = core;
      context.lineWidth = shooting.width || 1.2;
      context.beginPath();
      context.moveTo(shooting.x, shooting.y);
      context.lineTo(tailX, tailY);
      context.stroke();
    }
    context.restore();
  }

  /** 功能：初始化矩阵字符列，含速度分层与亮度抖动。入参：config。返回：矩阵状态。边界：列数不超过当前可读字号的最大值。 */
  function initializeMatrix(config) {
    var fontSize = numberConfig(config.fontSize, 14, 10, 28);
    var maximumColumns = Math.ceil(engine.width / fontSize);
    var count = Math.round(numberConfig(config.columns, maximumColumns, 12, maximumColumns));
    var speedScale = numberConfig(config.speed, 1, 0.2, 4);
    var columns = [];
    for (var index = 0; index < count; index += 1) {
      columns.push({
        head: random(-engine.height / fontSize, engine.height / fontSize),
        speed: random(9, 34) * speedScale,
        phase: random(0, Math.PI * 2),
        brightness: random(0.55, 1),
        dense: Math.random() < 0.18,
      });
    }
    return {
      columns: columns,
      fontSize: fontSize,
      columnWidth: engine.width / Math.max(1, count),
      glyphs: '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZアイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホヤユヨラリルレロワヲン'.split(''),
    };
  }

  /** 功能：更新矩阵字符头与局部加速列。入参：state、config、deltaSeconds。返回：无。边界：重生高度随机避免同步闪烁。 */
  function updateMatrix(state, config, deltaSeconds) {
    for (var index = 0; index < state.columns.length; index += 1) {
      var column = state.columns[index];
      column.phase += deltaSeconds * (column.dense ? 1.35 : 1);
      var boost = column.dense ? 1.25 + Math.sin(column.phase * 2.2) * 0.15 : 1;
      column.head += column.speed * boost * deltaSeconds;
      if (column.head * state.fontSize > engine.height + state.fontSize * 5) {
        column.head = -random(4, engine.height / state.fontSize * 0.55);
        column.brightness = random(0.55, 1);
        column.dense = Math.random() < 0.18;
        column.speed = random(9, 34) * numberConfig(config.speed, 1, 0.2, 4);
      }
    }
  }

  /** 功能：绘制发光头部、渐隐尾迹与稀疏高亮列。入参：state、config。返回：无。边界：尾迹长度上限为 36。 */
  function drawMatrix(state, config) {
    var context = engine.ctx;
    var color = config.color || '88,255,156';
    var trailLength = Math.round(numberConfig(config.trailLength, 18, 5, 36));
    var opacity = numberConfig(config.opacity, 0.56, 0.05, 1);
    context.save();
    context.font = state.fontSize + 'px ui-monospace, SFMono-Regular, Consolas, monospace';
    context.textBaseline = 'top';
    for (var columnIndex = 0; columnIndex < state.columns.length; columnIndex += 1) {
      var column = state.columns[columnIndex];
      var x = columnIndex * state.columnWidth + state.columnWidth * 0.12;
      var localTrail = column.dense ? Math.min(36, trailLength + 6) : trailLength;
      for (var tail = 0; tail < localTrail; tail += 1) {
        var y = (column.head - tail) * state.fontSize;
        if (y < -state.fontSize || y > engine.height) continue;
        var fade = Math.pow(1 - tail / localTrail, 1.45);
        var alpha = Math.min(1, opacity * column.brightness * fade * 1.2);
        var glyph = state.glyphs[Math.floor((column.phase * 10 + tail * 9 + columnIndex * 5) % state.glyphs.length)];
        if (tail === 0) {
          if (config.glow !== false) {
            context.shadowColor = rgba(color, Math.min(1, alpha));
            context.shadowBlur = 14;
          }
          context.fillStyle = rgba('240,255,246', Math.min(1, alpha * 1.25));
        } else if (tail < 3) {
          context.shadowBlur = config.glow !== false ? 4 : 0;
          context.shadowColor = rgba(color, alpha * 0.5);
          context.fillStyle = rgba(blendColor(color, '200,255,220', 0.55), alpha);
        } else {
          context.shadowBlur = 0;
          context.fillStyle = rgba(color, alpha);
        }
        context.fillText(glyph, x, y);
      }
    }
    context.shadowBlur = 0;
    context.restore();
  }

  /** 功能：创建单组夜行车灯或水雾粒子。入参：mode、强制配置。返回：粒子状态。边界：车道与灯色按真实夜驾比例抽样。 */
  function createRoadItem(mode, forced) {
    var source = forced && typeof forced === 'object' ? forced : {};
    if (mode === 'trails') {
      // 六车道：含外侧，避免光轨挤在消失点正中
      var laneChoices = [-3, -2, -1, 1, 2, 3];
      var lane = laneChoices[Math.floor(random(0, laneChoices.length))];
      var kind = Math.random() < 0.58 ? 'head' : 'tail';
      return {
        lane: source.lane != null ? source.lane : lane,
        kind: source.kind || kind,
        progress: source.progress != null ? source.progress : random(0.02, 0.95),
        speed: source.speed != null ? source.speed : (kind === 'head' ? random(0.55, 1.35) : random(0.4, 1.05)),
        pairGap: source.pairGap != null ? source.pairGap : random(0.55, 1.15),
        brightness: source.brightness != null ? source.brightness : random(0.55, 1),
        trail: source.trail != null ? source.trail : random(0.55, 1.25),
        phase: source.phase != null ? source.phase : random(0, Math.PI * 2),
        life: source.life != null ? source.life : random(0.7, 1),
        blink: Math.random() < 0.12,
        // 同车道内再做横向微偏，让覆盖更满
        laneOffset: source.laneOffset != null ? source.laneOffset : random(-0.28, 0.28),
      };
    }
    // spray：细碎贴地水汽，避免大面积白蒙
    var kindRoll = Math.random();
    var kind = kindRoll < 0.42 ? 'speck' : kindRoll < 0.78 ? 'streak' : 'kick';
    return {
      side: source.side != null ? source.side : (Math.random() < 0.5 ? -1 : 1),
      lane: source.lane != null ? source.lane : random(-1, 1),
      progress: source.progress != null ? source.progress : random(0.05, 1),
      speed: source.speed != null ? source.speed : (kind === 'kick' ? random(0.85, 1.35) : random(0.4, 1.05)),
      width: source.width != null ? source.width : random(0.45, 1.15),
      phase: source.phase != null ? source.phase : random(0, Math.PI * 2),
      life: source.life != null ? source.life : random(0.6, 1),
      mist: source.mist != null ? source.mist : random(0.55, 1),
      kind: source.kind || kind,
      lift: source.lift != null ? source.lift : (kind === 'kick' ? random(0.25, 0.7) : random(0.02, 0.18)),
    };
  }

  /** 功能：初始化路面水雾或夜行光轨。入参：config。返回：路面效果状态。边界：道路得分低时仍可作为轻量环境层运行。 */
  function initializeRoad(config) {
    var mode = config.mode === 'trails' ? 'trails' : 'spray';
    var count = Math.round(numberConfig(config.count, mode === 'trails' ? 18 : 56, 8, 120) * engine.quality);
    var items = [];
    for (var index = 0; index < count; index += 1) items.push(createRoadItem(mode, { progress: random(0.02, 0.98) }));
    return { items: items, clock: 0, mode: mode };
  }

  /** 功能：推进路面水雾或车灯光轨透视进度。入参：state、config、deltaSeconds。返回：无。边界：到达前景后回到消失点重生。 */
  function updateRoad(state, config, deltaSeconds) {
    state.clock += deltaSeconds;
    var mode = config.mode === 'trails' ? 'trails' : 'spray';
    var speed = numberConfig(config.speed, 0.7, 0.05, 3);
    for (var index = 0; index < state.items.length; index += 1) {
      var item = state.items[index];
      var flow = mode === 'trails'
        ? item.speed * speed * deltaSeconds * (0.16 + item.progress * 0.22)
        : item.speed * speed * deltaSeconds * (item.kind === 'kick' ? 0.3 : 0.18);
      item.progress += flow;
      item.phase += deltaSeconds * (mode === 'trails' ? (0.8 + item.speed * 0.5) : (0.55 + item.speed * 0.35));
      item.life -= deltaSeconds * (mode === 'trails' ? 0.08 : (item.kind === 'kick' ? 0.22 : 0.1));
      if (item.progress > 1.08 || item.life <= 0) {
        state.items[index] = createRoadItem(mode, {
          progress: random(0.01, 0.14),
          life: mode === 'trails' ? random(0.85, 1) : random(0.65, 1),
        });
      }
    }
  }

  /** 功能：绘制单组车灯拖影、灯芯与湿路反光。入参：context、灯点坐标、颜色、强度、拖影长度。返回：无。边界：强度过低时跳过。 */
  function drawCarLightTrail(context, x, y, originX, horizon, color, hotColor, intensity, trailLength, headSize) {
    if (intensity <= 0.01) return;
    var tailY = Math.max(horizon + 4, y - trailLength);
    var tailX = lerp(originX, x, clamp((tailY - horizon) / Math.max(1, y - horizon), 0, 1));
    // 拖影光带
    var streak = context.createLinearGradient(tailX, tailY, x, y);
    streak.addColorStop(0, rgba(color, 0));
    streak.addColorStop(0.45, rgba(color, intensity * 0.22));
    streak.addColorStop(0.82, rgba(color, intensity * 0.55));
    streak.addColorStop(1, rgba(hotColor, intensity * 0.9));
    context.strokeStyle = streak;
    context.lineWidth = Math.max(0.7, headSize * 0.55);
    context.beginPath();
    context.moveTo(tailX, tailY);
    context.lineTo(x, y);
    context.stroke();
    // 灯芯 bloom
    var bloom = context.createRadialGradient(x, y, 0, x, y, headSize * 2.4);
    bloom.addColorStop(0, rgba(hotColor, intensity * 0.95));
    bloom.addColorStop(0.28, rgba(color, intensity * 0.45));
    bloom.addColorStop(1, rgba(color, 0));
    context.fillStyle = bloom;
    context.fillRect(x - headSize * 2.4, y - headSize * 2.4, headSize * 4.8, headSize * 4.8);
    // 湿路纵向反光
    var reflectLen = trailLength * 0.55 + headSize * 4;
    var reflect = context.createLinearGradient(x, y, x, Math.min(engine.height, y + reflectLen));
    reflect.addColorStop(0, rgba(hotColor, intensity * 0.28));
    reflect.addColorStop(0.35, rgba(color, intensity * 0.12));
    reflect.addColorStop(1, rgba(color, 0));
    context.fillStyle = reflect;
    context.fillRect(x - headSize * 0.7, y, headSize * 1.4, reflectLen);
  }

  /** 功能：绘制沿消失点扩张的水雾或真实车灯光轨。入参：state、config。返回：无。边界：强度按背景道路得分调节；夜行模式含远近白灯与红尾灯。 */
  function drawRoad(state, config) {
    var context = engine.ctx;
    var scene = engine.sceneProfile;
    var mode = config.mode === 'trails' ? 'trails' : 'spray';
    var opacity = numberConfig(config.opacity, 0.5, 0.05, 1) * (0.55 + scene.roadScore * 0.55);
    var baseColor = blendColor(config.color || '176,202,224', scene.accentColor, mode === 'trails' ? 0.42 : 0.24);
    var originX = scene.vanishingX * engine.width;
    var horizon = scene.horizonY * engine.height;
    context.save();
    if (mode === 'spray') {
      var spraySpread = numberConfig(config.spread, 0.98, 0.4, 1.3);
      var wetColor = blendColor(baseColor, '200,220,236', 0.25);
      context.globalCompositeOperation = 'source-over';
      // 轻微模糊即可：大 blur + screen 容易糊成白蒙
      context.filter = 'blur(1.6px)';
      context.lineCap = 'round';

      for (var sprayIndex = 0; sprayIndex < state.items.length; sprayIndex += 1) {
        var sprayItem = state.items[sprayIndex];
        var sprayProgress = clamp(sprayItem.progress, 0, 1.08);
        var depth = sprayProgress * sprayProgress;
        var laneNorm = sprayItem.lane != null ? sprayItem.lane : sprayItem.side * 0.55;
        var roadHalf = engine.width * (0.07 + depth * 0.46) * spraySpread;
        var sprayY = lerp(horizon + 4, engine.height * 0.995, depth) - (sprayItem.lift || 0) * depth * engine.height * 0.028;
        var sprayX = originX + laneNorm * roadHalf;
        sprayX += Math.sin(sprayItem.phase * 1.25) * sprayProgress * (4 + Math.abs(laneNorm) * 7);
        sprayX = clamp(sprayX, engine.width * 0.015, engine.width * 0.985);

        var kind = sprayItem.kind || 'speck';
        var mist = sprayItem.mist || 1;
        var sprayAlpha = opacity * sprayItem.life * mist;

        if (kind === 'streak') {
          // 贴地细长水汽条：沿透视方向拉丝，几乎不抬离路面
          var streakLen = (18 + sprayProgress * 70) * sprayItem.width;
          var backY = Math.max(horizon + 2, sprayY - streakLen);
          var backX = lerp(originX, sprayX, clamp((backY - horizon) / Math.max(1, sprayY - horizon), 0, 1));
          var streak = context.createLinearGradient(backX, backY, sprayX, sprayY);
          streak.addColorStop(0, rgba(wetColor, 0));
          streak.addColorStop(0.55, rgba(wetColor, sprayAlpha * (0.1 + sprayProgress * 0.16)));
          streak.addColorStop(1, rgba(blendColor(wetColor, '230,240,250', 0.2), sprayAlpha * (0.18 + sprayProgress * 0.22)));
          context.strokeStyle = streak;
          context.lineWidth = Math.max(0.8, 1.1 + sprayProgress * 2.4 * sprayItem.width);
          context.beginPath();
          context.moveTo(backX, backY);
          context.lineTo(sprayX, sprayY);
          context.stroke();
          continue;
        }

        if (kind === 'kick') {
          // 近景少量扬起水珠/碎雾，体积小、边缘清楚
          var kickR = (2.2 + sprayProgress * 7.5) * mist * sprayItem.width;
          var kick = context.createRadialGradient(sprayX, sprayY, 0, sprayX, sprayY, kickR * 2.1);
          kick.addColorStop(0, rgba('236,244,252', sprayAlpha * (0.28 + sprayProgress * 0.3)));
          kick.addColorStop(0.45, rgba(wetColor, sprayAlpha * 0.16));
          kick.addColorStop(1, rgba(wetColor, 0));
          context.fillStyle = kick;
          context.fillRect(sprayX - kickR * 2.1, sprayY - kickR * 2.4, kickR * 4.2, kickR * 4.8);
          continue;
        }

        // speck：贴地小点/碎雾，构成主体细节
        var speckR = (1.2 + sprayProgress * 4.2) * mist * sprayItem.width;
        context.fillStyle = rgba(wetColor, sprayAlpha * (0.16 + sprayProgress * 0.28));
        context.beginPath();
        context.ellipse(sprayX, sprayY, speckR * 1.8, speckR * 0.55, 0, 0, Math.PI * 2);
        context.fill();
      }
      context.restore();
      return;
    }

    context.globalCompositeOperation = 'screen';
    context.lineCap = 'round';
    var spread = numberConfig(config.spread, 0.92, 0.35, 1.25);
    // 宽幅道路氛围：覆盖接近整幅前景路面，而不是只留中间一条
    var ambience = context.createLinearGradient(originX, horizon, originX, engine.height);
    ambience.addColorStop(0, rgba(baseColor, 0));
    ambience.addColorStop(0.55, rgba(baseColor, opacity * 0.045));
    ambience.addColorStop(1, rgba(baseColor, 0));
    context.fillStyle = ambience;
    context.fillRect(originX - engine.width * 0.48 * spread, horizon, engine.width * 0.96 * spread, engine.height - horizon);

    for (var index = 0; index < state.items.length; index += 1) {
      var item = state.items[index];
      var progress = clamp(item.progress, 0, 1.08);
      var depth = progress * progress;
      // 按透视把车道展开到接近全宽：lane∈[-3,3] → 归一化后乘路面半宽
      var laneNorm = (item.lane + (item.laneOffset || 0)) / 3;
      var roadHalf = engine.width * (0.08 + depth * 0.46) * spread;
      var y = lerp(horizon + 4, engine.height * 0.99, depth);
      var x = originX + laneNorm * roadHalf;
      var sway = Math.sin(item.phase * 1.4) * progress * (4 + Math.abs(laneNorm) * 6);
      x += sway;
      x = clamp(x, engine.width * 0.02, engine.width * 0.98);
      var flicker = item.blink ? (0.72 + Math.sin(item.phase * 18) * 0.28) : (0.9 + Math.sin(item.phase * 3.2) * 0.08);
      var intensity = opacity * item.life * item.brightness * flicker * (0.55 + progress * 0.85);
      var headSize = (1.8 + progress * 7.5) * (0.85 + item.pairGap * 0.25);
      var trailLength = (28 + progress * 150) * item.trail;
      var pairOffset = (4 + progress * engine.width * 0.016) * item.pairGap;
      var isHead = item.kind !== 'tail';
      var bodyColor = isHead ? blendColor(baseColor, '210,230,255', 0.35) : '220,64,54';
      var hotColor = isHead ? '255,248,230' : '255,120,90';
      // 双灯：近处更明显，远处合并成一点
      if (progress > 0.18) {
        drawCarLightTrail(context, x - pairOffset * 0.5, y, originX, horizon, bodyColor, hotColor, intensity * 0.92, trailLength, headSize * 0.85);
        drawCarLightTrail(context, x + pairOffset * 0.5, y, originX, horizon, bodyColor, hotColor, intensity, trailLength * 0.96, headSize);
      } else {
        drawCarLightTrail(context, x, y, originX, horizon, bodyColor, hotColor, intensity * 0.8, trailLength * 0.7, headSize * 0.65);
      }
    }
    context.restore();
  }

  EFFECTS.rain = { initialize: initializeRain, update: updateRain, draw: drawRain };
  EFFECTS.fog = { initialize: initializeFog, update: updateFog, draw: drawFog };
  EFFECTS.particles = { initialize: initializeParticles, update: updateParticles, draw: drawParticles };
  EFFECTS.snow = { initialize: initializeSnow, update: updateSnow, draw: drawSnow };
  EFFECTS.stars = { initialize: initializeStars, update: updateStars, draw: drawStars };
  EFFECTS.matrix = { initialize: initializeMatrix, update: updateMatrix, draw: drawMatrix };
  EFFECTS.road = { initialize: initializeRoad, update: updateRoad, draw: drawRoad };

  /** 功能：按当前类型和配置重建渲染状态。入参：无。返回：无。边界：未知类型时清空状态。 */
  function initializeCurrentEffect() {
    var renderer = EFFECTS[engine.effect];
    engine.state = renderer && engine.ctx ? renderer.initialize(engine.config) : null;
  }

  /** 功能：渲染下一帧。入参：timestamp。返回：无。边界：暂停或无状态时停止调度。 */
  function renderFrame(timestamp) {
    engine.animationId = null;
    if (!isCurrentEngine()) {
      destroyCanvas();
      return;
    }
    if (engine.paused || engine.effect === 'none' || !engine.ctx || !engine.state) return;
    var startedAt = performance.now();
    var deltaSeconds = engine.lastFrameAt ? clamp((timestamp - engine.lastFrameAt) / 1000, 0, MAX_DELTA_SECONDS) : 1 / 60;
    engine.lastFrameAt = timestamp;
    engine.pointerX = lerp(engine.pointerX, engine.pointerTargetX, deltaSeconds * 6);
    engine.pointerY = lerp(engine.pointerY, engine.pointerTargetY, deltaSeconds * 6);
    var renderer = EFFECTS[engine.effect];
    engine.ctx.clearRect(0, 0, engine.width, engine.height);
    renderer.update(engine.state, engine.config, deltaSeconds);
    renderer.draw(engine.state, engine.config);
    adaptQuality(performance.now() - startedAt);
    engine.animationId = requestAnimationFrame(renderFrame);
  }

  /** 功能：在需要时启动唯一帧循环。入参：无。返回：无。边界：已有循环、暂停或减弱动画时不重复调度。 */
  function requestRenderLoop() {
    if (!isCurrentEngine()) return;
    if (engine.animationId || engine.paused || engine.reducedMotion || engine.effect === 'none') return;
    engine.animationId = requestAnimationFrame(renderFrame);
  }

  /** 功能：启动或切换效果。入参：effect、config。返回：是否启动成功。边界：未知类型与减弱动画偏好会安全停止。 */
  function startEffect(effect, config) {
    if (!isCurrentEngine()) return false;
    var nextEffect = typeof effect === 'string' ? effect : 'none';
    if (!EFFECTS[nextEffect] || engine.reducedMotion) { stopEffect(); return false; }
    if (!createCanvas()) return false;
    var preset = resolvePreset(nextEffect, config);
    engine.effect = nextEffect;
    engine.preset = preset ? preset.id : 'none';
    engine.config = mergePresetConfig(preset, config);
    engine.sceneProfile = readSceneProfile(engine.config);
    engine.lastFrameAt = 0;
    // 面板触发时 Codex 可能暂时在后台；新效果必须保留首帧，等待浏览器恢复 rAF，
    // 不能依赖某些 Electron 场景下可能漏发的 visibilitychange 事件来解除暂停。
    engine.paused = false;
    engine.canvas.style.opacity = '1';
    setLightningForeground(false);
    document.documentElement.setAttribute('data-ds-canvas-effect', nextEffect);
    initializeCurrentEffect();
    requestRenderLoop();
    return true;
  }

  /** 功能：按预设标识启动效果。入参：presetId、sceneProfile。返回：是否启动成功。边界：未知预设返回 false。 */
  function startPreset(presetId, sceneProfile) {
    var preset = PRESET_BY_ID[presetId];
    if (!preset) return false;
    var config = mergePresetConfig(preset, { sceneProfile: sceneProfile });
    return startEffect(preset.type, config);
  }

  /** 功能：停止动态效果并清理状态。入参：无。返回：无。边界：重复调用不会影响页面其他节点。 */
  function stopEffect() {
    engine.effect = 'none';
    engine.preset = 'none';
    engine.config = {};
    engine.sceneProfile = null;
    engine.lastFrameAt = 0;
    document.documentElement.removeAttribute('data-ds-canvas-effect');
    setLightningForeground(false);
    destroyCanvas();
  }

  /** 功能：从 HTML 属性同步当前效果。入参：无。返回：无。边界：CSS 专用效果只停止 Canvas。 */
  function syncFromDocument() {
    var effect = document.documentElement.getAttribute('data-ds-effect') || 'none';
    if (!EFFECTS[effect]) { stopEffect(); return; }
    startEffect(effect, readDocumentConfig());
  }

  /** 功能：在本地图像分析完成后刷新场景轮廓。入参：无。返回：无。边界：无活动效果时不创建画布。 */
  function refreshSceneProfile() {
    if (engine.effect === 'none') return;
    var profile = readSceneProfile(engine.config);
    if (JSON.stringify(profile) === JSON.stringify(engine.sceneProfile)) return;
    engine.sceneProfile = profile;
    initializeCurrentEffect();
  }

  /** 功能：处理文档可见性变化。入参：无。返回：无。边界：恢复时从新帧时间起算。 */
  function handleVisibilityChange() {
    if (!isCurrentEngine()) return;
    engine.paused = document.visibilityState === 'hidden';
    if (engine.paused) { if (engine.animationId) cancelAnimationFrame(engine.animationId); engine.animationId = null; return; }
    engine.lastFrameAt = 0;
    requestRenderLoop();
  }

  /** 功能：记录指针归一化位置。入参：event。返回：无。边界：异常视口尺寸回退中心。 */
  function handlePointerMove(event) {
    engine.pointerTargetX = clamp(event.clientX / Math.max(1, engine.width), 0, 1);
    engine.pointerTargetY = clamp(event.clientY / Math.max(1, engine.height), 0, 1);
  }

  /** 功能：输出运行诊断。入参：无。返回：效果、预设、场景轮廓和运行状态。边界：未启动时 active 为 false。 */
  function getDiagnostics() {
    return {
      effect: engine.effect,
      preset: engine.preset,
      sceneProfile: engine.sceneProfile,
      rainModel: engine.effect === 'rain' && engine.state ? engine.state.rainModel : null,
      fogModel: engine.effect === 'fog' && engine.state ? engine.state.fogModel : null,
      paused: engine.paused,
      quality: engine.quality,
      width: engine.width,
      height: engine.height,
      active: Boolean(engine.canvas && engine.state),
    };
  }

  /** 功能：返回已注册预设目录。入参：无。返回：预设基本信息数组。边界：返回副本避免外部修改内部配置。 */
  function getPresets() {
    return PRESETS.map(function (preset) { return { id: preset.id, type: preset.type }; });
  }

  /** 功能：安装窗口、可见性与属性监听。入参：无。返回：无。边界：缺少可选浏览器 API 时仍可运行。 */
  function installListeners() {
    window.addEventListener('resize', resizeCanvas, { passive: true });
    window.addEventListener('pointermove', handlePointerMove, { passive: true });
    document.addEventListener('visibilitychange', handleVisibilityChange);
    if (typeof MutationObserver !== 'undefined') {
      var observer = new MutationObserver(function (mutations) {
        for (var index = 0; index < mutations.length; index += 1) {
          var attribute = mutations[index].attributeName;
          if (attribute === 'data-ds-effect' || attribute === 'data-ds-effect-config') { syncFromDocument(); break; }
          if (attribute === 'data-dream-art-ready') refreshSceneProfile();
        }
      });
      observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-ds-effect', 'data-ds-effect-config', 'data-dream-art-ready'] });
    }
    if (window.matchMedia) {
      var media = window.matchMedia('(prefers-reduced-motion: reduce)');
      engine.reducedMotion = Boolean(media.matches);
      if (typeof media.addEventListener === 'function') media.addEventListener('change', function (event) { engine.reducedMotion = Boolean(event.matches); if (engine.reducedMotion) stopEffect(); else syncFromDocument(); });
    }
  }

  window.dynamicEffects = { start: startEffect, stop: stopEffect, setEffect: startEffect, startPreset: startPreset, getPresets: getPresets, getDiagnostics: getDiagnostics };
  installListeners();
  syncFromDocument();
})();
