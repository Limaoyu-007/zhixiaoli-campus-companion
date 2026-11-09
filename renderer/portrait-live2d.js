// Local Cubism portrait with the existing Canvas portrait as a loading/error fallback.
(function () {
  'use strict';
  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));

  // Exact critically damped spring step: smooth inertia without frame-rate overshoot.
  function followSpring(position, velocity, target, dt, frequency) {
    const displacement = position - target;
    const momentum = velocity + frequency * displacement;
    const decay = Math.exp(-frequency * dt);
    return {
      position: target + (displacement + momentum * dt) * decay,
      velocity: (velocity - frequency * momentum * dt) * decay,
    };
  }

  // Multi-parameter expression targets combining ZxlExpression, mouth form, eyelid openness and head tilt.
  const EXPRESSIONS = {
    neutral:   { zxl: 0,    mouthForm: 0,     eyeL: 1,    eyeR: 1,    tiltZ: 0,   pitchY: 0 },
    attentive: { zxl: -0.4, mouthForm: 0.15,  eyeL: 0.96, eyeR: 0.96, tiltZ: 3.5, pitchY: -2.5 },
    happy:     { zxl: 2.0,  mouthForm: 0.85,  eyeL: 0.72, eyeR: 0.72, tiltZ: 6.5, pitchY: 3.0 },
    gentle:    { zxl: 1.2,  mouthForm: 0.55,  eyeL: 0.85, eyeR: 0.85, tiltZ: 4.0, pitchY: 1.5 },
    curious:   { zxl: -1.0, mouthForm: -0.25, eyeL: 1.0,  eyeR: 0.78, tiltZ: -11, pitchY: 2.5 },
    concerned: { zxl: -2.0, mouthForm: -0.65, eyeL: 0.86, eyeR: 0.86, tiltZ: -5.5, pitchY: -4.5 },
  };

  function loadImage(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('口型贴图加载失败'));
      img.src = url;
    });
  }

  // Feather the outer skin patch of mouth.png so the original smile stroke blends seamlessly on the 3D face mesh.
  function buildFeatheredMouthSprite(img) {
    const w = img.naturalWidth || 32, h = img.naturalHeight || 23;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const imageData = ctx.getImageData(0, 0, w, h);
    const data = imageData.data;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const dx = (x - 15) / 14.2;
        const dy = (y - 9.5) / 5.8;
        const dist = Math.hypot(dx, dy);
        const edge = clamp((1 - dist) / 0.32, 0, 1);
        const feather = edge * edge * (3 - 2 * edge);
        data[i + 3] = Math.round(data[i + 3] * feather);
      }
    }
    ctx.putImageData(imageData, 0, 0);
    return canvas;
  }

  window.PortraitLive2D = class {
    constructor(image, onChange) {
      this.image = image;
      this.onChange = onChange;
      this.enabled = false;
      this.ready = false;
      this.models = {};
      this.bounds = {};
      this.destroyed = false;
      this.direction = -1;
      this.walking = false;
      this.blend = 0;
      this.phase = 0;
      this.level = 0;
      this.voiceLevel = 0;
      this.voiceGate = false;
      this.voiceAt = -Infinity;
      this.voiceEnergyAt = -Infinity;
      this.speechPulse = 0;
      this.lastSpeechAccent = -Infinity;
      this.state = 'neutral';
      this.expression = 'neutral';
      this.expressionUntil = 0;
      this.expressionPriority = 0;
      this.expressionPose = { ...EXPRESSIONS.neutral };
      this.gaze = { x: 0, y: 0 };
      this.gazeTarget = { x: 0, y: 0 };
      this.headPose = { yaw: 0, pitch: 0, roll: 0 };
      this.headVelocity = { yaw: 0, pitch: 0, roll: 0 };
      this.hairSway = 0;
      this.hairVelocity = 0;
      this.pointerAt = -Infinity;
      this.pointerTracking = false;
      this.returning = false;
      this.returnUntil = 0;
      this.headRespondAt = 0;
      this.lookDirection = 0;
      this.glanceUntil = 0;
      this.nextGlance = performance.now() + 4200;
      this.blinkAt = performance.now() + 2200;
      this.doubleBlinkPending = false;
      this.lastMouthOpen = -1;
      this.lastMouthForm = -99;
      this.lastFrame = performance.now();
      this.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
      this.fallback = new window.PortraitLayered(image, () => this.changed());
      this.canvas = document.createElement('canvas');
      this.canvas.className = 'portrait-live2d';
      this.canvas.hidden = true;
      image.parentNode.appendChild(this.canvas);
      this.visibility = () => {
        if (document.hidden) {
          this.setMoving(false);
          window.electronAPI.setPetWalking(0);
          this.resetDynamics();
        }
        this.sync();
      };
      document.addEventListener('visibilitychange', this.visibility);
      this.load();
    }
    get active() { return this.live || this.fallback.active; }
    get available() { return this.live && Boolean(this.models.side); }
    get live() { return this.enabled && this.ready && Boolean(this.models.front); }
    changed() {
      const state = `${this.active}:${this.live}`;
      if (state === this.lastNotified) return;
      this.lastNotified = state;
      this.onChange(this.active);
    }
    resetDynamics() {
      this.gaze = { x: 0, y: 0 };
      this.gazeTarget = { x: 0, y: 0 };
      this.headPose = { yaw: 0, pitch: 0, roll: 0 };
      this.headVelocity = { yaw: 0, pitch: 0, roll: 0 };
      this.hairSway = 0;
      this.hairVelocity = 0;
      this.pointerTracking = false;
      this.returning = false;
      this.glanceUntil = 0;
      this.speechPulse = 0;
    }
    async load() {
      try {
        if (!window.PIXI?.live2d || !window.Live2DCubismCore) throw new Error('Live2D 运行库缺失');
        // Reserve the shared WASM heap before either model is created. Growing
        // it for the second model invalidates typed-array views held by the first.
        if (!window.__portraitCoreMemoryInitialized) {
          Live2DCubismCore.Memory.initializeAmountOfMemory(128 * 1024 * 1024);
          window.__portraitCoreMemoryInitialized = true;
        }
        this.app = new PIXI.Application({ view: this.canvas, backgroundAlpha: 0, antialias: true,
          resolution: Math.min(devicePixelRatio || 1, 2), autoDensity: true, autoStart: false,
          preserveDrawingBuffer: true });
        for (const [kind, file] of Object.entries({ front: 'front/zhixiaoli-v3.model3.json', side: 'side-walk/zhixiaoli-side-walk.model3.json' })) {
          try {
            const url = new URL('../assets/zhixiaoli/live2d/' + file, location.href).href;
            const model = await PIXI.live2d.Live2DModel.from(url, { autoInteract: false, autoUpdate: false });
            if (this.destroyed) { model.destroy(); return; }
            this.model = model;
            // Core 5.3 moved render orders from Drawables to Model. The bundled
            // Cubism 4 renderer can use that array for models without offscreens.
            const core = model.internalModel.coreModel;
            const native = core._model;
            if (kind === 'front') {
              const repairURL = new URL('mouth-uv.json', url);
              const response = await fetch(repairURL);
              if (!response.ok) throw new Error('正面口腔纹理映射配置缺失');
              const repair = await response.json();
              const index = native.drawables.ids.indexOf(repair.drawable);
              const uvs = native.drawables.vertexUvs[index];
              if (!uvs || uvs.length !== (repair.columns + 1) * (repair.rows + 1) * 2)
                throw new Error('口腔网格与纹理映射配置不匹配');

              const mouthImgURL = new URL('../assets/zhixiaoli/layered/mouth.png', location.href).href;
              const mouthImg = await loadImage(mouthImgURL);
              this.mouthSprite = buildFeatheredMouthSprite(mouthImg);
              this.mouthCanvas = document.createElement('canvas');
              this.mouthCanvas.width = 128;
              this.mouthCanvas.height = 128;
              this.mouthTexture = PIXI.Texture.from(this.mouthCanvas);

              // Bind ArtMeshMouth to a dedicated 128x128 dynamic mouth texture slot
              // so closed state renders the original delicate chibi smile instead of a squashed brown ellipse.
              const mouthSlot = model.textures.length;
              model.textures.push(this.mouthTexture);
              native.drawables.textureIndices[index] = mouthSlot;
              let offset = 0;
              for (let row = 0; row <= repair.rows; row++) for (let col = 0; col <= repair.columns; col++) {
                uvs[offset++] = col / repair.columns;
                uvs[offset++] = 1 - row / repair.rows;
              }
            }
            model.portraitParameterIndices = new Map(native.parameters.ids.map((id, index) => [id, index]));
            if (!native.drawables.renderOrders) {
              if (native.offscreens?.count > 0 || !native.renderOrders)
                throw new Error('当前模型包含旧渲染器不支持的离屏绘制结构');
              core.getDrawableRenderOrders = () => native.renderOrders;
            }
            this.app.stage.addChild(model);
            this.models[kind] = model;
            if (kind === 'front') this.updateMouthTexture(0, 0, true);
            // Fit the visible artwork, not the export canvas: this model's artwork
            // is offset from the canvas origin assumed by the legacy renderer.
            this.bounds[kind] = this.measureArtwork();
            model.internalModel.on('beforeModelUpdate', () => { if (this.model === model) this.animateParameters(); });
            model.visible = false;
          } catch (error) {
            if (kind === 'front') throw error;
            this.models.side?.destroy();
            delete this.models.side;
            delete this.bounds.side;
            console.warn('Side walk model unavailable; front portrait remains active', error);
            window.dispatchEvent(new CustomEvent('portrait-error', { detail: '侧面行走模型加载失败，正面形象仍可使用。' }));
          }
        }
        this.selectModel();
        this.app.ticker.maxFPS = 60;
        this.app.ticker.add(() => this.model.update(this.app.ticker.deltaMS));
        this.observer = new ResizeObserver(() => this.resize());
        this.observer.observe(this.image.parentNode);
        this.resize();
        this.model.update(0);
        this.app.render(); // Fail during loading, so a render error activates fallback.
        this.ready = true;
        this.sync();
      } catch (error) {
        if (this.destroyed) return;
        console.error('Live2D portrait load failed', error);
        this.app?.destroy(false, { children: true, texture: true, baseTexture: true });
        this.app = null;
        this.model = null;
        this.models = {};
        this.bounds = {};
        this.ready = false;
        this.sync();
        window.dispatchEvent(new CustomEvent('portrait-error', { detail: 'Live2D 形象加载失败，已使用原形象。' }));
      }
    }
    updateMouthTexture(open, form, force = false) {
      if (!this.mouthCanvas || !this.mouthTexture) return;
      if (!force && Math.abs(open - this.lastMouthOpen) < 0.01 && Math.abs(form - this.lastMouthForm) < 0.02) return;
      this.lastMouthOpen = open;
      this.lastMouthForm = form;

      const c = this.mouthCanvas.getContext('2d');
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.clearRect(0, 0, 128, 128);
      c.save();
      // ArtMeshMouth at ParamMouthOpenY=1 spans 31.5 x 16.8 source pixels centered at (380.5, 246.5).
      c.translate(64, 64);
      c.scale(128 / 31.5, 128 / 16.8);

      const closedAlpha = clamp(1 - open * 1.15, 0, 1);
      if (closedAlpha > 0.01 && this.mouthSprite) {
        c.save();
        c.globalAlpha = closedAlpha;
        const slices = 16;
        const sliceW = 32 / slices;
        for (let i = 0; i < slices; i++) {
          const sx = i * sliceW;
          const nx = ((sx + sliceW * 0.5) - 15) / 10;
          const bendY = -form * 1.15 * nx * nx + form * 0.35;
          c.drawImage(this.mouthSprite, sx, 0, sliceW, 23, -16.5 + sx, -11.5 + bendY, sliceW + 0.15, 23);
        }
        c.restore();
      }

      if (open > 0.015) {
        const cavityAlpha = clamp(open * 1.35, 0, 1);
        const halfWidth = 3.3 + Math.sqrt(open) * 2.1 + form * 0.5;
        const depth = 0.65 + open * 4.5;
        const cornerLift = -form * 0.5;
        c.save();
        c.globalAlpha = cavityAlpha;
        c.translate(-0.5, -1.2);
        c.beginPath();
        c.moveTo(-halfWidth, cornerLift - 0.3);
        c.bezierCurveTo(-halfWidth * 0.5, -depth * 0.65, halfWidth * 0.5, -depth * 0.65, halfWidth, cornerLift - 0.3);
        c.bezierCurveTo(halfWidth * 0.85, depth, -halfWidth * 0.85, depth, -halfWidth, cornerLift - 0.3);
        c.closePath();
        c.fillStyle = '#754454';
        c.fill();
        c.save();
        c.clip();
        c.fillStyle = '#d491a0';
        c.beginPath();
        c.ellipse(0.4, depth * 0.85, halfWidth * 0.58, depth * 0.3, 0, 0, Math.PI * 2);
        c.fill();
        c.restore();
        c.restore();
      }
      c.restore();

      this.mouthTexture.baseTexture.update();
      const gl = this.app?.renderer?.gl;
      const front = this.models.front;
      if (gl && front) {
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, front.internalModel.textureFlipY);
        this.app.renderer.texture.bind(this.mouthTexture.baseTexture, 0);
      }
    }
    setEnabled(value) {
      if (!value && this.walking) window.electronAPI.setPetWalking(0);
      this.enabled = Boolean(value);
      if (!this.enabled) this.walking = false;
      this.sync();
    }
    sync() {
      if (this.destroyed) return;
      this.selectModel();
      const live = this.live;
      this.fallback.setEnabled(this.enabled && !live);
      this.canvas.hidden = !live;
      this.image.closest('#portrait-pet')?.classList.toggle('live2d', live);
      if (live && !document.hidden) { this.resize(); this.lastFrame = performance.now(); this.app.start(); }
      else { this.app?.stop(); }
      this.changed();
    }
    selectModel() {
      const kind = this.walking ? 'side' : 'front';
      if (!this.models[kind]) return;
      this.model = this.models[kind];
      this.artBounds = this.bounds[kind];
      for (const [name, model] of Object.entries(this.models)) model.visible = name === kind;
    }
    resize() {
      if (!this.model) return;
      const rect = this.image.parentNode.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      if (this.viewportWidth !== rect.width || this.viewportHeight !== rect.height) {
        this.app.renderer.resize(rect.width, rect.height);
        this.viewportWidth = rect.width;
        this.viewportHeight = rect.height;
      }
      const b = this.artBounds;
      if (!b) return;
      // Reserve space for the swing of the feet, hands and hair.
      const scale = Math.min(rect.width * .86 / b.width, rect.height * .90 / b.height);
      this.baseScale = scale;
      this.model.pivot.set(b.x + b.width / 2, b.y + b.height);
      this.model.scale.set(scale * (this.walking && this.direction > 0 ? -1 : 1), scale);
      this.model.position.set(rect.width / 2, rect.height * .95);
    }
    measureArtwork() {
      const internal = this.model.internalModel, core = internal.coreModel;
      let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
      for (let i = 0; i < core.getDrawableCount(); i++) {
        if (core.getDrawableOpacity(i) <= .05) continue;
        const vertices = internal.getDrawableVertices(i);
        for (let j = 0; j < vertices.length; j += 2) {
          const p = internal.localTransform.apply(new PIXI.Point(vertices[j], vertices[j + 1]));
          left = Math.min(left, p.x); right = Math.max(right, p.x);
          top = Math.min(top, p.y); bottom = Math.max(bottom, p.y);
        }
      }
      if (![left, top, right, bottom].every(Number.isFinite) || right <= left || bottom <= top)
        throw new Error('模型可见绘制区域无效');
      return { x: left, y: top, width: right - left, height: bottom - top };
    }
    setMoving(walking, direction = this.direction) {
      const wasWalking = this.walking;
      this.walking = Boolean(walking) && this.available;
      if (direction && Math.sign(direction) !== this.direction) { this.direction = Math.sign(direction); this.resize(); }
      if (wasWalking !== this.walking) {
        this.cancelGesture();
        this.blend = 0;
        this.phase = 0;
        this.sync();
      }
    }
    updateAttention(now, reduced) {
      if (reduced || window._windowDragActive || this.walking) {
        if (this.pointerTracking || this.glanceUntil) this.resetGaze();
        return;
      }
      if (this.pointerTracking && now - this.pointerAt > 2200) this.resetGaze();
      if (this.returning) {
        const centered = Math.abs(this.gaze.x) + Math.abs(this.gaze.y) +
          Math.abs(this.headPose.yaw) + Math.abs(this.headPose.pitch) < 0.04;
        if (now > this.returnUntil && centered) {
          this.returning = false;
          this.nextGlance = now + 3600 + Math.random() * 2600;
        }
        return;
      }
      if (this.pointerTracking) return;
      if (this.glanceUntil && now > this.glanceUntil) { this.resetGaze(); return; }
      if (!this.glanceUntil && now > this.nextGlance) {
        this.gazeTarget = { x: (Math.random() - 0.5) * 0.42, y: (Math.random() - 0.5) * 0.18 };
        this.glanceUntil = now + 750 + Math.random() * 550;
        this.headRespondAt = now + 95;
      }
    }
    updateSpeech(now, dt) {
      if (!this.speaking || now - this.voiceAt > 240) {
        this.level = 0;
        this.voiceGate = false;
      }
      const target = this.voiceGate ? Math.pow(clamp((this.level - 0.04) / 0.65, 0, 1), 0.68) : 0;
      const rate = target > this.voiceLevel ? 24 : 14;
      this.voiceLevel += (target - this.voiceLevel) * (1 - Math.exp(-dt * rate));
      if (this.voiceLevel < 0.005) this.voiceLevel = 0;
      if (this.speaking && this.voiceLevel > 0.34 && now - this.lastSpeechAccent > 520 && !this.action && now >= (this.nodUntil || 0)) {
        this.lastSpeechAccent = now;
        this.speechPulse = 0.22 + Math.min(0.28, this.voiceLevel * 0.3);
      }
      this.speechPulse *= Math.exp(-dt * 6.5);
    }
    animateParameters() {
      const now = performance.now(), dt = clamp((now - this.lastFrame) / 1000, 0.001, 0.1);
      this.lastFrame = now;
      const reduced = Boolean(this.reducedMotion?.matches);
      this.updateAttention(now, reduced);
      this.updateSpeech(now, dt);

      // 1. Eye tracking leads first; head follows after a short natural delay with spring inertia.
      const eyeFollow = 1 - Math.exp(-dt * (this.returning ? 6.5 : 13));
      this.gaze.x += (this.gazeTarget.x - this.gaze.x) * eyeFollow;
      this.gaze.y += (this.gazeTarget.y - this.gaze.y) * eyeFollow;

      // 2. Smooth multi-parameter expression interpolation.
      const transient = now < this.expressionUntil;
      const exprName = transient ? this.expression : this.state;
      const exprTarget = { ...(EXPRESSIONS[exprName] || EXPRESSIONS.neutral) };
      if (exprName === 'attentive' && !reduced) {
        exprTarget.tiltZ = Math.sin(now / 950) * 4.2;
      }
      const exprBlend = 1 - Math.exp(-dt * (transient ? 7.2 : 4.2));
      for (const key of Object.keys(exprTarget)) {
        this.expressionPose[key] += (exprTarget[key] - this.expressionPose[key]) * exprBlend;
      }

      // 3. Gesture curves (nod, bounce, sway, wave) with multi-axis head & body coordination.
      let nodPitch = 0, gestureYaw = 0, gestureRoll = 0, bounceY = 0, containerSway = 0, scaleSquash = 0, hairImpulse = 0;
      if (now < (this.nodUntil || 0)) {
        const p = 1 - (this.nodUntil - now) / 900;
        const env = Math.sin(p * Math.PI);
        nodPitch = -Math.sin(p * Math.PI * 2) * 16 * env;
        gestureRoll = Math.sin(p * Math.PI) * 3.5;
        hairImpulse += Math.cos(p * Math.PI * 2) * 0.25 * env;
      }
      if (this.action) {
        const progress = clamp((now - this.action.started) / this.action.duration, 0, 1);
        const env = Math.sin(progress * Math.PI);
        if (this.action.name === 'bounce') {
          const hop = Math.sin(progress * Math.PI * 2);
          bounceY = -Math.abs(hop) * env * 13;
          scaleSquash = Math.cos(progress * Math.PI * 4) * env * 0.014;
          nodPitch += hop * env * 9;
          gestureRoll += Math.sin(progress * Math.PI * 2) * env * 6;
          hairImpulse += hop * env * 0.45;
        } else if (this.action.name === 'sway') {
          const wave = Math.sin(progress * Math.PI * 2);
          containerSway = wave * env * 0.032;
          gestureRoll += wave * env * 13;
          gestureYaw += wave * env * 8;
          nodPitch += Math.abs(wave) * env * 4;
          hairImpulse += wave * env * 0.55;
        } else if (this.action.name === 'wave') {
          const beat = Math.sin(progress * Math.PI * 3);
          containerSway = beat * env * 0.024;
          bounceY = -Math.abs(Math.sin(progress * Math.PI * 2)) * env * 7;
          gestureRoll += (8 + beat * 9) * env;
          gestureYaw += beat * env * 6;
          nodPitch += Math.sin(progress * Math.PI * 2) * env * 6;
          hairImpulse += beat * env * 0.5;
        }
        if (progress >= 1) this.action = null;
      }

      // 4. Critically-damped head spring following gaze + expression + speech prosody + gestures.
      const headReady = now >= this.headRespondAt;
      const idleFloatYaw = reduced || this.walking ? 0 : Math.sin(now / 2800) * 1.6;
      const idleFloatRoll = reduced || this.walking ? 0 : Math.sin(now / 3400 + 1.1) * 1.8;
      const targetYaw = (headReady ? this.gaze.x * 22 : this.headPose.yaw) + gestureYaw + idleFloatYaw;
      const targetPitch = (headReady ? this.gaze.y * 15 : this.headPose.pitch) +
        this.expressionPose.pitchY + nodPitch - this.speechPulse * 9;
      const targetRoll = (headReady ? this.gaze.x * 6.5 : 0) +
        this.expressionPose.tiltZ + gestureRoll + idleFloatRoll + this.speechPulse * 4;

      const prevYaw = this.headPose.yaw;
      const freq = this.returning ? 5.2 : 6.8;
      const stepYaw = followSpring(this.headPose.yaw, this.headVelocity.yaw, targetYaw, dt, freq);
      const stepPitch = followSpring(this.headPose.pitch, this.headVelocity.pitch, targetPitch, dt, freq);
      const stepRoll = followSpring(this.headPose.roll, this.headVelocity.roll, targetRoll, dt, freq * 0.9);
      this.headPose = { yaw: stepYaw.position, pitch: stepPitch.position, roll: stepRoll.position };
      this.headVelocity = { yaw: stepYaw.velocity, pitch: stepPitch.velocity, roll: stepRoll.velocity };

      // 5. Secondary hair pendulum physics driven by head angular velocity, walking & breeze.
      this.blend += clamp((this.walking ? 1 : 0) - this.blend, -dt * 4, dt * 4);
      if (this.blend > 0.001) this.phase = (this.phase + dt / 1.2) % 1;
      else this.phase = 0;

      const headDeltaRate = (this.headPose.yaw - prevYaw) / dt;
      const breeze = reduced ? 0 : Math.sin(now / 1650) * 0.11 + Math.sin(now / 920) * 0.04;
      const walkHair = this.walking ? Math.sin(this.phase * Math.PI * 2 - 0.35) * 0.34 : 0;
      const hairTarget = clamp(
        -headDeltaRate * 0.011 - this.headPose.roll * 0.018 + hairImpulse + walkHair + breeze,
        -0.95, 0.95
      );
      const hairStep = followSpring(this.hairSway, this.hairVelocity, hairTarget, dt, 7.5);
      this.hairSway = clamp(hairStep.position, -1, 1);
      this.hairVelocity = hairStep.velocity;

      // 6. Natural blink (with occasional double-blink & slight L/R organic offset).
      if (now > this.blinkAt + 190) {
        if (this.doubleBlinkPending) {
          this.doubleBlinkPending = false;
          this.blinkAt = now + 110;
        } else {
          this.doubleBlinkPending = !reduced && Math.random() < 0.22;
          this.blinkAt = now + 2600 + Math.random() * 2400;
        }
      }
      const blinkProgressL = clamp((now - this.blinkAt) / 175, 0, 1);
      const blinkProgressR = clamp((now - (this.blinkAt + 10)) / 175, 0, 1);
      const blinkL = now >= this.blinkAt && blinkProgressL < 1 ? Math.sin(blinkProgressL * Math.PI) : 0;
      const blinkR = now >= this.blinkAt + 10 && blinkProgressR < 1 ? Math.sin(blinkProgressR * Math.PI) : 0;

      const core = this.model.internalModel.coreModel;
      const set = (id, value) => {
        const index = this.model.portraitParameterIndices.get(id);
        if (index !== undefined) core.setParameterValueByIndex(index, value);
      };
      const mirror = this.walking && this.direction > 0 ? -1 : 1;

      set('ZxlWalkBlend', this.blend);
      set('ZxlWalkPhase', this.phase);
      set('ZxlHairSway', this.hairSway);
      set('ParamBreath', reduced ? 0.5 : (Math.sin(now / 1150) + 1) / 2);

      const openL = clamp(this.expressionPose.eyeL * (1 - blinkL), 0, 1);
      const openR = clamp(this.expressionPose.eyeR * (1 - blinkR), 0, 1);
      set('ParamEyeLOpen', openL);
      set('ParamEyeROpen', openR);

      // Counter-relax eyeball slightly as the head catches up so pupils don't stay pinned at the corner.
      const eyeX = clamp(this.gaze.x - (this.headPose.yaw / 30) * 0.22, -1, 1);
      const eyeY = clamp(this.gaze.y - (this.headPose.pitch / 30) * 0.18, -1, 1);
      set('ParamEyeBallX', eyeX * mirror);
      set('ParamEyeBallY', eyeY);

      const previewAge = now - (this.mouthPreviewAt ?? -Infinity);
      const preview = previewAge < 3600 ? [0, 0.5, 1][Math.floor(previewAge / 1200)] : null;
      const mouthOpen = preview === null
        ? (this.speaking ? clamp(this.voiceLevel, 0, 1) : 0)
        : preview;
      const mouthForm = clamp(this.expressionPose.mouthForm + (this.speaking ? this.voiceLevel * 0.2 : 0), -1, 1);
      if (!this.walking) {
        this.updateMouthTexture(mouthOpen, mouthForm);
        // Keep the 3D mouth mesh at its full un-squashed 31.5x16.8 surface so the dynamic texture renders at 1:1 scale.
        set('ParamMouthOpenY', 1);
        set('ParamMouthForm', 0);
      } else {
        set('ParamMouthOpenY', 0);
        set('ParamMouthForm', mouthForm);
      }
      set('ZxlExpression', clamp(this.expressionPose.zxl, -2, 2));

      set('ParamAngleX', clamp(this.headPose.yaw, -28, 28) * mirror);
      set('ParamAngleY', clamp(this.headPose.pitch, -26, 26));
      set('ParamAngleZ', clamp(this.headPose.roll, -26, 26) * mirror);

      if (this.baseScale && this.viewportHeight) {
        const sx = this.baseScale * (1 - scaleSquash) * mirror;
        const sy = this.baseScale * (1 + scaleSquash);
        this.model.scale.set(sx, sy);
        this.model.position.y = this.viewportHeight * 0.95 + bounceY;
        this.model.rotation = containerSway;
      }
    }
    point(x, y) {
      if (!this.live) return this.fallback.point(x, y);
      const rect = this.canvas.getBoundingClientRect();
      if (x < rect.left || y < rect.top || x > rect.right || y > rect.bottom) return null;
      const local = this.model.toModelPosition(new PIXI.Point(x - rect.left, y - rect.top));
      const internal = this.model.internalModel, core = internal.coreModel;
      for (let i = 0; i < core.getDrawableCount(); i++) {
        if (core.getDrawableOpacity(i) <= .05) continue;
        const b = internal.getDrawableBounds(i);
        if (local.x >= b.x && local.x <= b.x + b.width && local.y >= b.y && local.y <= b.y + b.height) {
          const rx = (x - rect.left) / rect.width;
          const ry = (y - rect.top) / rect.height;
          const zone = ry < 0.38 ? 'head' : (ry > 0.48 && ry < 0.72 && rx > 0.62 ? 'hand' : 'body');
          return { x: local.x, y: local.y, zone };
        }
      }
      return null;
    }
    followPointer(x, y) {
      if (!this.live) return this.fallback.followPointer(x, y);
      if (this.reducedMotion?.matches || window._windowDragActive || this.walking) return;
      const r = this.canvas.getBoundingClientRect();
      const local = this.model.toModelPosition(new PIXI.Point(x - r.left, y - r.top));
      const b = this.artBounds;
      const origin = this.model.internalModel.localTransform.apply(local);
      const rawX = clamp((origin.x - b.x - b.width / 2) / (b.width / 2), -1, 1);
      const next = {
        x: Math.abs(rawX) < 0.03 ? 0 : Math.sign(rawX) * (Math.abs(rawX) - 0.03) / 0.97,
        y: clamp(-(origin.y - b.y - b.height * 0.25) / (b.height * 0.4), -1, 1),
      };
      const now = performance.now();
      const dir = Math.abs(next.x) > 0.28 ? Math.sign(next.x) : 0;
      if (!this.pointerTracking || this.returning) this.headRespondAt = now + 80;
      else if (dir && this.lookDirection && dir !== this.lookDirection) this.headRespondAt = now + 50;
      if (dir) this.lookDirection = dir;
      this.gazeTarget = next;
      this.pointerAt = now;
      this.pointerTracking = true;
      this.returning = false;
      this.glanceUntil = 0;
    }
    resetGaze() {
      const now = performance.now();
      this.gazeTarget = { x: 0, y: 0 };
      this.pointerAt = -Infinity;
      this.pointerTracking = false;
      this.lookDirection = 0;
      this.glanceUntil = 0;
      if (!this.returning) {
        this.returning = true;
        this.returnUntil = now + 950;
        this.headRespondAt = now + 35;
      }
      this.fallback.resetGaze();
    }
    setState(state) {
      if (EXPRESSIONS[state]) this.state = state;
      this.fallback.setState(state);
    }
    setSpeaking(value) {
      this.speaking = Boolean(value);
      if (!this.speaking) {
        this.level = 0;
        this.voiceGate = false;
      }
      this.fallback.setSpeaking(value);
    }
    previewMouth() { this.mouthPreviewAt = performance.now(); }
    setLevel(value) {
      this.level = clamp(Number(value) || 0, 0, 1);
      this.voiceAt = performance.now();
      if (this.level >= 0.08) {
        this.voiceGate = true;
        this.voiceEnergyAt = this.voiceAt;
      } else if (this.level <= 0.04 && this.voiceAt - this.voiceEnergyAt > 45) {
        this.voiceGate = false;
      }
      this.fallback.setLevel(value);
    }
    setExpression(name, options = {}) {
      if (EXPRESSIONS[name]) {
        const now = performance.now();
        const priority = options.priority || 1;
        if (now >= this.expressionUntil || priority >= this.expressionPriority) {
          this.expression = name;
          this.expressionUntil = now + (options.duration || 1800);
          this.expressionPriority = priority;
        }
      }
      this.fallback.setExpression(name, options);
    }
    blink() {
      this.blinkAt = performance.now();
      this.doubleBlinkPending = false;
      if (!this.live) this.fallback.blink();
    }
    gesture(name, options = {}) {
      if (!this.live) return this.fallback.gesture(name, options);
      if (!['nod', 'bounce', 'sway', 'wave'].includes(name)) return false;
      const now = performance.now();
      const priority = options.priority || 1;
      if (this.action && now < this.action.started + this.action.duration && this.action.priority > priority) return false;
      this.cancelGesture();
      if (name === 'nod') this.nodUntil = now + 900;
      else this.action = { name, priority, started: now, duration: name === 'wave' ? 1400 : 950 };
      return true;
    }
    cancelGesture() {
      this.nodUntil = 0;
      this.action = null;
      for (const model of Object.values(this.models)) {
        model.rotation = 0;
        if (this.baseScale) model.scale.set(this.baseScale * (this.walking && this.direction > 0 ? -1 : 1), this.baseScale);
      }
      if (this.model && this.viewportHeight) this.model.position.y = this.viewportHeight * .95;
      this.fallback.cancelGesture();
    }
    clearPresentation() {
      this.cancelGesture();
      this.expressionUntil = 0;
      this.expressionPriority = 0;
      this.mouthPreviewAt = undefined;
      this.fallback.clearPresentation();
    }
    reset() {
      this.setMoving(false);
      window.electronAPI.setPetWalking(0);
      this.clearPresentation();
      this.resetDynamics();
      this.resetGaze();
      this.fallback.reset();
    }
    destroy() {
      this.destroyed = true;
      window.electronAPI.setPetWalking(0);
      document.removeEventListener('visibilitychange', this.visibility);
      this.observer?.disconnect();
      this.fallback.destroy();
      this.app?.destroy(false, { children: true, texture: true, baseTexture: true });
      this.canvas.remove();
    }
  };
})();
