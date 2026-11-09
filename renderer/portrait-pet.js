// Character controls shared by the local Live2D model, Canvas fallback and custom images.
(function () {
  'use strict';
  const api = window.electronAPI;
  const layer = document.getElementById('portrait-stage');
  const image = document.getElementById('custom-pet-image');
  const root = document.createElement('div');
  root.id = 'portrait-pet';
  root.innerHTML = '<div class="portrait-motion"><div class="portrait-breath"><div class="portrait-voice"></div></div></div><div class="portrait-sparkles" aria-hidden="true"><i>✦</i><i>✧</i><i>✦</i></div><div class="portrait-whisper" hidden aria-live="polite"></div><div class="portrait-wait" hidden aria-label="正在等待回复"><span></span><span></span><span></span></div>';
  layer.appendChild(root);
  root.querySelector('.portrait-voice').appendChild(image);
  const wave = new window.PortraitWave(image);
  const blink = new window.PortraitBlink(image);
  const mouth = new window.PortraitMouth(image);
  const layered = new window.PortraitLive2D(image, onLayeredChange);
  image.alt = '智小理';
  const motion = root.querySelector('.portrait-motion');
  const whisper = root.querySelector('.portrait-whisper');
  const wait = root.querySelector('.portrait-wait');
  let currentURL = '';
  let pixels = null;
  let imageWidth = 0;
  let imageHeight = 0;
  let actionTimer = null;
  let whisperTimer = null;
  let gesture = null;
  let dragFrame = null, dragDX = 0, dragDY = 0;
  const lastTouchIndex = { head: -1, hand: -1, body: -1 };

  const TOUCH_LINES = {
    head: [
      '摸摸头，今天也要元气满满哦～',
      '嘿嘿，智小理随时待命！',
      '有什么校园问题或作业想查，尽管问我呀～',
      '发丝都被你揉乱啦，不过还是很开心～',
    ],
    body: [
      '收到！智小理精神百倍～',
      '今天想查课表、看学习通作业，还是办校园业务呀？',
      '噔噔！充能完毕，随时陪你出发～',
      '在呢在呢，戳我一下就有好运气哦 ✦',
    ],
  };

  function getHandLines() {
    const hour = new Date().getHours();
    const timeGreeting = hour >= 5 && hour < 11
      ? '早安呀！新的一天，智小理陪你一起加油～'
      : hour >= 11 && hour < 14
        ? '中午好～忙完别忘了好好吃午饭、休息一会儿哦！'
        : hour >= 14 && hour < 18
          ? '下午好呀！挥挥手，累了就伸个懒腰吧～'
          : hour >= 18 && hour < 23
            ? '晚上好～今天辛苦啦，还有什么任务需要收尾吗？'
            : '夜深啦，早点休息哦，明天的事交给明天的我们～';
    return [
      timeGreeting,
      '击个掌！祝你今天上课、办事都顺顺利利～',
      '嗨～叫我一声，随时陪你同行！',
    ];
  }

  function pickTouchLine(zone) {
    const pool = zone === 'hand' ? getHandLines() : (TOUCH_LINES[zone] || TOUCH_LINES.body);
    let idx = Math.floor(Math.random() * pool.length);
    if (pool.length > 1 && idx === lastTouchIndex[zone]) idx = (idx + 1) % pool.length;
    lastTouchIndex[zone] = idx;
    return pool[idx];
  }

  function showWhisper(text, duration = 3200) {
    if (!whisper || !text) return;
    clearTimeout(whisperTimer);
    whisper.textContent = text;
    whisper.hidden = false;
    whisperTimer = setTimeout(() => { whisper.hidden = true; }, duration);
  }

  function hideWhisper() {
    clearTimeout(whisperTimer);
    whisperTimer = null;
    if (whisper) whisper.hidden = true;
  }

  function flushDrag() {
    if (dragFrame !== null) cancelAnimationFrame(dragFrame);
    dragFrame = null;
    if (dragDX || dragDY) api.windowDrag(dragDX, dragDY);
    dragDX = 0; dragDY = 0;
  }
  let waiting = false;
  let currentScale = 1;
  let lastAction = -Infinity;
  let voiceResetTimer = null;
  let layeredPreferred = true;
  let actionPriority = 0;
  let actionUntil = 0;
  let feedbackUntil = 0;
  let speechPlaying = false;

  function clearActionVisuals() {
    clearTimeout(actionTimer);
    actionTimer = null;
    actionPriority = 0;
    actionUntil = 0;
    wave.stop();
    motion.classList.remove('action-bounce', 'action-sway', 'action-nod');
    root.classList.remove('show-sparkles');
  }
  function manualBlocked() {
    return waiting || speechPlaying || window._windowDragActive || performance.now() < feedbackUntil;
  }

  function onLayeredChange(active) {
    root.classList.toggle('layered', active);
    wave.stop();
    blink.stop();
    blink.eyes = null;
    mouth.reset();
    clearActionVisuals();
    feedbackUntil = 0;
    if (active) { layered.setState(waiting ? 'attentive' : 'neutral'); layered.setSpeaking(speechPlaying); }
    else if (image.complete && image.naturalWidth) {
      blink.prepare(); mouth.prepare(); blink.setState(waiting ? 'attentive' : 'neutral');
    }
  }
  function syncRendering() {
    // Custom images always retain their own image, never the bundled PSD parts.
    layered.setEnabled(layeredPreferred && currentURL === blink.portraitURL);
  }
  function face() { return layered.active ? layered : blink; }

  function setImage(url) {
    if (!url || url === currentURL) return;
    currentURL = url;
    layered.setEnabled(false);
    wave.stop();
    pixels = null;
    blink.stop();
    blink.eyes = null;
    mouth.reset();
    imageWidth = 0;
    imageHeight = 0;
    image.classList.remove('portrait-loaded');
    image.src = url;
    syncRendering();
  }
  image.addEventListener('load', () => {
    imageWidth = image.naturalWidth;
    imageHeight = image.naturalHeight;
    // Cache transparency only for pointer hit testing; the source image is unchanged.
    try {
      const mask = document.createElement('canvas');
      mask.width = imageWidth;
      mask.height = imageHeight;
      const context = mask.getContext('2d', { willReadFrequently: true });
      context.drawImage(image, 0, 0);
      pixels = context.getImageData(0, 0, imageWidth, imageHeight).data;
    } catch (_) { pixels = null; }
    image.classList.add('portrait-loaded');
    if (!layered.active) { blink.prepare(); mouth.prepare(); }
  });
  image.addEventListener('error', () => {
    window.dispatchEvent(new CustomEvent('portrait-error', { detail: '角色图片暂时无法加载，请在设置中重新选择。' }));
  });

  function portraitPoint(x, y) {
    if (layered.active) return layered.point(x, y);
    if (!imageWidth || !imageHeight) return null;
    const rect = image.getBoundingClientRect();
    const scale = Math.min(rect.width / imageWidth, rect.height / imageHeight);
    if (!Number.isFinite(scale) || scale <= 0) return null;
    const left = rect.left + (rect.width - imageWidth * scale) / 2;
    const top = rect.top + (rect.height - imageHeight * scale) / 2;
    const px = Math.floor((x - left) / scale);
    const py = Math.floor((y - top) / scale);
    if (px < 0 || py < 0 || px >= imageWidth || py >= imageHeight) return null;
    if (wave.active ? !wave.hitTest(px, py) : pixels && pixels[(py * imageWidth + px) * 4 + 3] <= 40) return null;
    return { x: px, y: py };
  }
  function hitPortrait(x, y) {
    return portraitPoint(x, y) !== null;
  }
  function touchZone(point) {
    if (layered.active) return point.zone;
    // The head includes the face and crown, not the long hair beside the body.
    // Replacement portraits retain the existing whole-image bounce interaction.
    if (image.src !== blink.portraitURL) return 'body';
    if (((point.x - 846) / 65) ** 2 + ((point.y - 930) / 85) ** 2 <= 1) return 'hand';
    const headDistance = ((point.x - 540) / 335) ** 2 + ((point.y - 275) / 265) ** 2;
    return headDistance <= 1 ? 'head' : 'body';
  }
  function contains(element, x, y) {
    const rect = element.getBoundingClientRect();
    return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
  }
  function hitUI(x, y) {
    const guide = document.getElementById('setup-guide');
    if (guide && !guide.hidden && contains(guide, x, y)) return true;
    const dockVisible = document.body.classList.contains('dock-awake') ||
      Boolean(document.activeElement?.closest?.('#chat-area, #chat-controls'));
    if (dockVisible) {
      if (contains(document.getElementById('chat-area'), x, y)) return true;
      if (contains(document.getElementById('chat-controls'), x, y)) return true;
    }
    for (const element of document.querySelectorAll('.speech-bubble:not(.leaving), #window-drag-handle.visible, .window-zoom-btn.visible')) {
      if (contains(element, x, y)) return true;
    }
    return false;
  }
  document.addEventListener('mousemove', event => {
    if (window._windowDragActive) return;
    face().followPointer(event.clientX, event.clientY);
    const active = hitUI(event.clientX, event.clientY) || hitPortrait(event.clientX, event.clientY);
    api.setIgnoreMouse(!active);
  });
  document.addEventListener('mouseleave', () => {
    face().resetGaze();
    if (!window._windowDragActive) api.setIgnoreMouse(true);
  });

  function act(name = 'bounce', { sparkles = true, force = false, source = 'manual', expression = null, duration = 1800 } = {}) {
    const now = performance.now();
    const priority = source === 'business' ? 3 : source === 'reply' ? 2 : 1;
    if (source === 'manual' && manualBlocked()) return false;
    if (now < actionUntil && actionPriority > priority) return false;
    if (!force && now - lastAction < 500) return false;
    if (layered.active && !layered.gesture(name, { priority })) return false;
    lastAction = now;
    clearActionVisuals();
    actionPriority = priority;
    actionUntil = now + 950;
    // Recreate the CSS animation, including consecutive clicks on the same action.
    void motion.offsetWidth;
    if (!layered.active) motion.classList.add(`action-${['bounce', 'sway', 'nod'].includes(name) ? name : 'bounce'}`);
    const targetExpression = expression || (name === 'bounce' ? 'happy' : name === 'sway' ? 'curious' : 'gentle');
    face().setExpression(targetExpression, { duration, priority });
    if (sparkles) root.classList.add('show-sparkles');
    actionTimer = setTimeout(() => {
      motion.classList.remove('action-bounce', 'action-sway', 'action-nod');
      root.classList.remove('show-sparkles');
      actionPriority = 0;
      actionUntil = 0;
    }, 950);
    return true;
  }
  function reactToTouch(zone) {
    if (manualBlocked()) return;
    if (zone === 'hand') {
      if (waveHello()) showWhisper(pickTouchLine('hand'), 3400);
    } else if (zone === 'head') {
      // One cooldown covers the nod and blink, including repeated head clicks.
      if (act('nod', { sparkles: false, expression: 'gentle', duration: 2000 })) {
        face().blink();
        showWhisper(pickTouchLine('head'), 3200);
      }
    } else if (act('bounce', { sparkles: true, expression: 'happy', duration: 2000 })) {
      showWhisper(pickTouchLine('body'), 3200);
    }
  }
  function waveHello() {
    const now = performance.now();
    if (manualBlocked() || now - lastAction < 500 || now < actionUntil && actionPriority > 1) return false;
    if (layered.active && !layered.gesture('wave', { priority: 1 })) return false;
    lastAction = now;
    clearActionVisuals();
    actionPriority = 1; actionUntil = now + 2400;
    face().resetGaze();
    if (layered.active) {
      layered.setExpression('gentle', { duration: 2500 });
    } else void wave.play();
    return true;
  }
  root.addEventListener('pointerdown', event => {
    if (event.button !== 0 || !event.isPrimary || gesture) return;
    const point = portraitPoint(event.clientX, event.clientY);
    if (!point) return;
    api.setPetWalking(0);
    event.preventDefault();
    root.setPointerCapture(event.pointerId);
    gesture = { pointerId: event.pointerId, imageURL: currentURL, zone: touchZone(point),
      x: event.screenX, y: event.screenY, startX: event.screenX, startY: event.screenY, moved: false };
    api.setIgnoreMouse(false);
    window.showWindowDragHandle?.();
  });
  root.addEventListener('pointermove', event => {
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    if (!gesture.moved && Math.hypot(event.screenX - gesture.startX, event.screenY - gesture.startY) < 5) return;
    if (!gesture.moved) {
      clearActionVisuals();
      hideWhisper();
      if (layered.active) layered.cancelGesture();
      face().resetGaze();
      gesture.moved = true;
      window._windowDragActive = true;
      root.classList.add('dragging');
    }
    const dx = event.screenX - gesture.x;
    const dy = event.screenY - gesture.y;
    gesture.x = event.screenX;
    gesture.y = event.screenY;
    if (!dx && !dy) return;
    if (dragFrame === null) {
      api.windowDrag(dx, dy);
      dragFrame = requestAnimationFrame(flushDrag);
    } else {
      dragDX += dx;
      dragDY += dy;
    }
  });
  function endGesture(event) {
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    flushDrag();
    const clicked = !gesture.moved && event.type === 'pointerup' && currentURL === gesture.imageURL &&
      Math.hypot(event.screenX - gesture.startX, event.screenY - gesture.startY) < 5;
    const zone = gesture.zone;
    gesture = null;
    window._windowDragActive = false;
    root.classList.remove('dragging');
    if (clicked) {
      window.toggleChatDock?.();
      reactToTouch(zone);
    }
  }
  root.addEventListener('pointerup', endGesture);
  root.addEventListener('pointercancel', endGesture);
  root.addEventListener('lostpointercapture', endGesture);
  root.addEventListener('contextmenu', event => {
    if (!hitPortrait(event.clientX, event.clientY)) return;
    event.preventDefault();
    api.showContextMenu();
  });
  root.addEventListener('wheel', event => {
    if (!hitPortrait(event.clientX, event.clientY)) return;
    event.preventDefault();
    currentScale = Math.max(0.6, Math.min(1.8, currentScale * (event.deltaY < 0 ? 1.06 : 1 / 1.06)));
    api.windowResize(currentScale);
    window.syncWindowScale?.(currentScale);
  }, { passive: false });

  window.setCustomImage = url => setImage(url);
  window.clearCustomImage = () => setImage(new URL('../assets/zhixiaoli/portrait.png', window.location.href).href);
  window.isOverModelOrImage = hitPortrait;
  window.setPetState = state => {
    const nextWaiting = state === 'processing';
    if (nextWaiting && !waiting) {
      api.setPetWalking(0);
      clearActionVisuals();
      hideWhisper();
      feedbackUntil = 0;
      lastAction = -Infinity;
      if (layered.active) layered.clearPresentation();
      else blink.setExpression('attentive');
      window.setPetSpeaking?.(false);
      window.setLipSync?.(0);
    }
    wait.hidden = !nextWaiting;
    root.classList.toggle('waiting', nextWaiting);
    face().setState(nextWaiting ? 'attentive' : 'neutral');
    if (state === 'replying' && performance.now() >= feedbackUntil) act('nod', { sparkles: false, force: true, source: 'reply' });
    if (waiting && !nextWaiting) root.classList.remove('waiting');
    waiting = nextWaiting;
  };
  // Semantic reply -> pet expression & gesture linkage (does not alter business tool feedback badges).
  window.showPetReplyReaction = ({ answer = '', tools = [], warning = '', error = '' } = {}) => {
    window.setPetState('idle');
    if (performance.now() < feedbackUntil) return;
    const text = String(answer || '').trim();
    const needsChoice = Array.isArray(tools) && tools.some(t => t.requiresUserInput);
    const toolFailed = Array.isArray(tools) && tools.some(t => !t.ok && !t.requiresUserInput && !t.skipped);

    if (error || warning || toolFailed) {
      act(error ? 'sway' : 'nod', { sparkles: false, force: true, source: 'reply', expression: 'concerned', duration: 2400 });
      return;
    }
    if (needsChoice || (text.length < 180 && (/[？?]\s*$/.test(text) || /(请问|哪一门|哪个课程|请确认|请选择)/.test(text)))) {
      act('sway', { sparkles: false, force: true, source: 'reply', expression: 'curious', duration: 2400 });
      return;
    }
    if (/(未交|待提交|尚未提交|截止时间|即将截止|已逾期|抓紧时间|注意截止)/.test(text)) {
      act('nod', { sparkles: false, force: true, source: 'reply', expression: 'concerned', duration: 2300 });
      return;
    }
    if (/(太棒|恭喜|已完成|全部提交|没有待交|没有未交|暂无待交|今天没课|今日无课|没有课程安排|好好休息|周末愉快|搞定|顺利)/.test(text)) {
      act('bounce', { sparkles: true, force: true, source: 'reply', expression: 'happy', duration: 2400 });
      return;
    }
    act('nod', { sparkles: false, force: true, source: 'reply', expression: 'gentle', duration: 2000 });
  };
  window.showPetBusinessFeedback = value => {
    const feedback = window.CampusFeedback.describe(value);
    if (!feedback) return false;
    const celebrate = feedback.status === 'success' && feedback.operation === 'booking';
    const action = celebrate ? 'bounce' : feedback.status === 'failed' ? 'sway' : 'nod';
    // A result must not be dropped because a manual interaction just happened.
    feedbackUntil = performance.now() + 2300;
    const expression = celebrate ? 'happy' : feedback.status === 'failed' ? 'concerned' : 'gentle';
    act(action, { sparkles: celebrate, force: true, source: 'business', expression, duration: 2300 });
    return true;
  };
  // Playback amplitude drives a small mouth opening as well as the body pulse.
  window.setPetSpeaking = active => {
    speechPlaying = Boolean(active);
    if (speechPlaying) api.setPetWalking(0);
    root.classList.toggle('speaking', speechPlaying);
    if (layered.active) layered.setSpeaking(speechPlaying);
    if (!speechPlaying) {
      clearTimeout(voiceResetTimer);
      root.style.setProperty('--voice-energy', '0');
    }
  };
  window.setLipSync = level => {
    const amplitude = Math.max(0, Math.min(1, Number(level) || 0));
    if (layered.active) layered.setLevel(amplitude);
    else mouth.setLevel(amplitude);
    root.style.setProperty('--voice-energy', String(Math.min(.45, amplitude)));
    clearTimeout(voiceResetTimer);
    if (amplitude > 0) voiceResetTimer = setTimeout(() => window.setLipSync(0), 220);
  };
  api.onPortraitAction(name => {
    if (name === 'mouth-preview') {
      if (!manualBlocked() && layered.live) layered.previewMouth();
      return;
    }
    if (name === 'walk-left' || name === 'walk-right' || name === 'walk-stop') {
      if (name === 'walk-stop') { api.setPetWalking(0); return; }
      if (!manualBlocked() && layered.available) {
        hideWhisper();
        api.setPetWalking(name === 'walk-left' ? -1 : 1);
      }
      return;
    }
    if (name !== 'reset' && manualBlocked()) return;
    if (name === 'wave') {
      waveHello();
    } else if (name.startsWith('face-')) {
      face().setExpression(name.slice(5), { duration: 2800 });
    } else if (name === 'blink') {
      face().setExpression('gentle', { duration: 1300 });
      face().blink();
    }
    else if (name === 'reset') {
      clearActionVisuals();
      hideWhisper();
      feedbackUntil = 0;
      if (layered.active) layered.reset();
      if (layered.active) layered.setSpeaking(speechPlaying);
      face().setExpression(waiting ? 'attentive' : 'neutral');
      face().resetGaze();
    } else act(name);
  });
  api.onConfigUpdated(config => {
    currentScale = Number(config.window?.scale) || currentScale;
    layeredPreferred = config.ui?.layered_portrait !== false;
    syncRendering();
  });
  api.onPetWalking(state => {
    if (state.walking) hideWhisper();
    layered.setMoving(state.walking, state.direction);
  });
  api.getConfig().then(config => {
    currentScale = Number(config.window?.scale) || 1;
    layeredPreferred = config.ui?.layered_portrait !== false;
    if (!currentURL) setImage(config.ui.custom_image || new URL('../assets/zhixiaoli/portrait.png', location.href).href);
    else syncRendering();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      clearActionVisuals();
      hideWhisper();
      feedbackUntil = 0;
      window.setPetSpeaking(false);
      window.setLipSync(0);
    }
  });
  window.addEventListener('pagehide', () => {
    layered.destroy();
    wave.destroy();
    blink.destroy();
    mouth.destroy();
    clearTimeout(actionTimer);
    clearTimeout(whisperTimer);
    clearTimeout(voiceResetTimer);
  }, { once: true });
})();
