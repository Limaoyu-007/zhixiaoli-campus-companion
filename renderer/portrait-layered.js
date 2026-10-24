// PSD mesh motion preview. This is a local Canvas rig, not a Cubism/moc3 model.
// All geometry uses the original 768 x 768 PSD coordinates.
(function () {
  'use strict';
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const ease = value => { const t = clamp(value, 0, 1); return t * t * (3 - 2 * t); };
  const makeCanvas = (width, height) => Object.assign(document.createElement('canvas'), { width, height });
  const expressions = {
    neutral: { leftY: 0, rightY: 0, leftAngle: 0, rightAngle: 0, leftLid: 0, rightLid: 0, smile: 0 },
    attentive: { leftY: -1.6, rightY: -1.4, leftAngle: -.008, rightAngle: .008, leftLid: 0, rightLid: 0, smile: .05 },
    happy: { leftY: -1.3, rightY: -1.3, leftAngle: -.035, rightAngle: .035, leftLid: .18, rightLid: .18, smile: .7 },
    gentle: { leftY: -.5, rightY: -.5, leftAngle: -.025, rightAngle: .025, leftLid: .09, rightLid: .09, smile: .35 },
    curious: { leftY: -2.5, rightY: .4, leftAngle: -.06, rightAngle: -.025, leftLid: .015, rightLid: .09, smile: 0 },
    concerned: { leftY: -.4, rightY: -.4, leftAngle: -.07, rightAngle: .07, leftLid: .06, rightLid: .06, smile: -.15 },
  };
  // Exact critically damped spring step: no frame-rate-dependent Euler overshoot.
  function followSpring(position, velocity, target, seconds, frequency) {
    const displacement = position - target;
    const momentum = velocity + frequency * displacement;
    const decay = Math.exp(-frequency * seconds);
    return { position: target + (displacement + momentum * seconds) * decay,
      velocity: (velocity - frequency * momentum * seconds) * decay };
  }

  window.PortraitLayered = class PortraitLayered {
    constructor(image, onChange) {
      this.image = image;
      this.onChange = onChange;
      this.canvas = makeCanvas(768, 768);
      this.canvas.className = 'portrait-layered';
      this.canvas.hidden = true;
      this.canvas.setAttribute('aria-label', '智小理分层动作预览');
      image.parentElement.appendChild(this.canvas);
      this.context = this.canvas.getContext('2d', { willReadFrequently: true });
      this.parts = new Map();
      this.active = false;
      this.enabled = false;
      this.ready = false;
      this.destroyed = false;
      this.frame = null;
      this.inFrame = false;
      this.lastFrame = 0;
      this.gaze = { x: 0, y: 0 };
      this.headPose = { yaw: 0, pitch: 0, roll: 0 };
      this.headVelocity = { yaw: 0, pitch: 0, roll: 0 };
      this.headGoal = { yaw: 0, pitch: 0, roll: 0 };
      this.rootSpeed = 0;
      this.hairRigs = {};
      this.target = { x: 0, y: 0 };
      this.pointerAt = -Infinity;
      this.pointerTracking = false;
      this.returning = false;
      this.returnUntil = 0;
      this.headRespondAt = 0;
      this.lookDirection = 0;
      this.glanceUntil = 0;
      this.nextGlance = performance.now() + 4500;
      this.nextBlink = performance.now() + 1800;
      this.blinkStarted = null;
      this.voice = 0;
      this.voiceTarget = 0;
      this.voiceAt = 0;
      this.voiceGate = false;
      this.voiceEnergyAt = -Infinity;
      this.speaking = false;
      this.speechPulse = 0;
      this.lastSpeechAccent = -Infinity;
      this.state = 'neutral';
      this.expressionPose = { ...expressions.neutral };
      this.settling = false;
      this.expression = 'neutral';
      this.expressionUntil = 0;
      this.expressionPriority = 0;
      this.action = null;
      this.motionPose = { bounce: 0, tilt: 0, nod: 0, wave: 0 };
      this.motion = window.matchMedia('(prefers-reduced-motion: reduce)');
      this.visibilityChanged = () => {
        this.pause();
        this.resetGaze(true);
        this.resetDynamics();
        this.blinkStarted = null;
        this.clearPresentation(true);
        this.nextBlink = performance.now() + 1800;
        if (!document.hidden && this.active) this.animate();
      };
      this.preferenceChanged = () => { this.resetGaze(); this.animate(); };
      document.addEventListener('visibilitychange', this.visibilityChanged);
      this.motion.addEventListener('change', this.preferenceChanged);
      this.load();
    }

    async load() {
      try {
        const rig = window.ZhixiaoliLayeredRig;
        if (!rig || rig.width !== 768 || rig.height !== 768) throw new Error('分层素材清单无法读取。');
        await Promise.all(rig.parts.map(part => new Promise((resolve, reject) => {
          const image = new Image();
          image.onload = () => { this.parts.set(part.id, { ...part, image }); resolve(); };
          image.onerror = () => reject(new Error('分层素材加载失败：' + part.id));
          image.src = new URL('../assets/zhixiaoli/layered/' + part.file, location.href).href;
        })));
        if (this.destroyed) return;
        this.eyes = ['left', 'right'].map(side => {
          const white = this.parts.get('eyewhite-' + side);
          return { side, white, surface: makeCanvas(white.width, white.height) };
        });
        this.faceRect = { x: 280, y: 78, width: 194, height: 204 };
        this.faceSurface = makeCanvas(this.faceRect.width, this.faceRect.height);
        this.faceMesh = new window.PortraitMesh(this.faceRect, 10, 12);
        for (const [id, rootY, amplitude, columns, rows] of [
          ['back-hair', 100, 2.3, 12, 18], ['front-hair', 105, 1, 10, 14],
        ]) {
          const part = this.parts.get(id);
          this.hairRigs[id] = { rootY, amplitude, mesh: new window.PortraitMesh(part, columns, rows),
            chains: [0, 1].map(() => Array.from({ length: 4 }, () => ({ offset: 0, velocity: 0 }))) };
        }
        this.ready = true;
        this.sync();
      } catch (error) {
        if (this.destroyed) return;
        this.loadError = error.message;
        this.sync();
      }
    }

    setEnabled(enabled) {
      this.enabled = Boolean(enabled);
      this.sync();
    }

    sync() {
      const next = this.enabled && this.ready && !this.destroyed;
      if (next === this.active) {
        if (this.enabled && this.loadError && !this.errorReported) this.reportError();
        return;
      }
      this.pause();
      this.active = next;
      this.canvas.hidden = !next;
      this.clearPresentation(true);
      this.blinkStarted = null;
      this.resetDynamics();
      this.resetGaze(true);
      this.onChange(next);
      if (next) { this.nextBlink = performance.now() + 1400; this.animate(); }
      else if (this.enabled && this.loadError && !this.errorReported) this.reportError();
    }

    reportError() {
      this.errorReported = true;
      window.dispatchEvent(new CustomEvent('portrait-error', {
        detail: '分层形象暂时无法加载，已保留原立绘。' + this.loadError,
      }));
    }

    followPointer(x, y) {
      if (!this.active || this.motion.matches || window._windowDragActive) return;
      const bounds = this.canvas.getBoundingClientRect();
      const scale = Math.min(bounds.width / 768, bounds.height / 768);
      if (!scale) return;
      const left = bounds.left + (bounds.width - scale * 768) / 2;
      const top = bounds.top + (bounds.height - scale * 768) / 2;
      const px = (x - left) / scale, py = (y - top) / scale;
      const horizontal = clamp((px - 380) / 210, -1, 1);
      const next = { x: Math.abs(horizontal) < .035 ? 0 : Math.sign(horizontal) * (Math.abs(horizontal) - .035) / .965,
        y: clamp((py - 205) / 280, -.8, .8) };
      const now = performance.now();
      const direction = Math.abs(next.x) > .3 ? Math.sign(next.x) : 0;
      // Start the eyes immediately. Delay the head only on acquisition or a real
      // direction reversal, never on every mousemove (which would freeze it).
      if (!this.pointerTracking || this.returning) this.headRespondAt = now + 85;
      else if (direction && this.lookDirection && direction !== this.lookDirection) this.headRespondAt = now + 55;
      if (direction) this.lookDirection = direction;
      this.target = next;
      this.pointerAt = now;
      this.pointerTracking = true;
      this.returning = false;
      this.glanceUntil = 0;
      this.animate();
    }

    resetGaze(immediate = false) {
      const now = performance.now();
      this.target = { x: 0, y: 0 };
      this.pointerAt = -Infinity;
      this.pointerTracking = false;
      this.lookDirection = 0;
      this.glanceUntil = 0;
      if (immediate) {
        this.gaze = { x: 0, y: 0 };
        this.returning = false;
        this.headRespondAt = 0;
        this.nextGlance = now + 4500;
      } else if (!this.returning) {
        this.returning = true;
        this.returnUntil = now + 1000;
        this.headRespondAt = now + 40;
      }
      this.animate();
    }

    resetDynamics() {
      this.headPose = { yaw: 0, pitch: 0, roll: 0 };
      this.headGoal = { yaw: 0, pitch: 0, roll: 0 };
      this.headVelocity = { yaw: 0, pitch: 0, roll: 0 };
      this.rootSpeed = 0;
      for (const rig of Object.values(this.hairRigs)) {
        for (const chain of rig.chains) for (const joint of chain) { joint.offset = 0; joint.velocity = 0; }
      }
    }

    updateAttention(now, reduced) {
      if (reduced || window._windowDragActive) {
        if (this.pointerTracking || this.glanceUntil) this.resetGaze();
        return;
      }
      if (this.pointerTracking && now - this.pointerAt > 2200) this.resetGaze();
      if (this.returning) {
        const centered = Math.abs(this.gaze.x) + Math.abs(this.gaze.y) +
          Math.abs(this.headPose.yaw) + Math.abs(this.headPose.pitch) < .035;
        if (now > this.returnUntil && centered) {
          this.returning = false;
          this.nextGlance = now + 3500 + Math.random() * 2500;
        }
        return;
      }
      if (this.pointerTracking) return;
      if (this.glanceUntil && now > this.glanceUntil) { this.resetGaze(); return; }
      if (!this.glanceUntil && now > this.nextGlance) {
        this.target = { x: (Math.random() - .5) * .28, y: (Math.random() - .5) * .1 };
        this.glanceUntil = now + 650 + Math.random() * 450;
        this.headRespondAt = now + 110;
      }
    }
    setState(state) {
      if (!expressions[state]) return;
      if (state === 'attentive' && this.state !== state) this.clearPresentation();
      this.state = state;
      this.animate();
    }
    setExpression(name, { duration = 0, priority = 1 } = {}) {
      if (!expressions[name]) return false;
      if (this.expressionUntil > performance.now() && this.expressionPriority > priority) return false;
      this.expression = name;
      this.expressionUntil = duration ? performance.now() + duration : 0;
      this.expressionPriority = duration ? priority : 0;
      if (!duration) this.state = name;
      this.animate();
      return true;
    }
    updateExpression(now, dt) {
      const transient = this.expressionUntil > now;
      const target = expressions[transient ? this.expression : this.state] || expressions.neutral;
      if (!transient) { this.expressionUntil = 0; this.expressionPriority = 0; }
      const blend = 1 - Math.exp(-dt / (transient ? 145 : 260));
      for (const key of Object.keys(target)) {
        this.expressionPose[key] += (target[key] - this.expressionPose[key]) * blend;
        if (Math.abs(target[key] - this.expressionPose[key]) > (key.includes('Angle') ? .0003 : .002)) this.settling = true;
      }
    }
    setSpeaking(active) {
      this.speaking = Boolean(active);
      if (!active) { this.voiceTarget = 0; this.voiceGate = false; }
      this.animate();
    }
    setLevel(value) {
      this.voiceTarget = clamp(Number(value) || 0, 0, 1);
      this.voiceAt = performance.now();
      if (this.voiceTarget >= .085) { this.voiceGate = true; this.voiceEnergyAt = this.voiceAt; }
      else if (this.voiceTarget <= .04 && this.voiceAt - this.voiceEnergyAt > 45) this.voiceGate = false;
      this.animate();
    }
    blink() { if (this.active) { this.blinkStarted = performance.now(); this.animate(); } }
    gesture(name, { priority = 1 } = {}) {
      if (!this.active || !['bounce', 'sway', 'nod', 'wave'].includes(name)) return false;
      const now = performance.now();
      if (this.action && now < this.action.start + this.action.duration && this.action.priority > priority) return false;
      this.action = { name, priority, start: now, duration: name === 'wave' ? 2400 : 950 };
      this.animate();
      return true;
    }
    cancelGesture() { this.action = null; this.animate(); }
    clearPresentation(immediate = false) {
      this.action = null;
      this.expressionUntil = 0;
      this.expressionPriority = 0;
      this.voiceTarget = 0;
      this.voiceGate = false;
      this.speaking = false;
      if (immediate) {
        this.voice = 0;
        this.speechPulse = 0;
        this.motionPose = { bounce: 0, tilt: 0, nod: 0, wave: 0 };
        this.expressionPose = { ...(expressions[this.state] || expressions.neutral) };
      }
      this.animate();
    }
    updateSpeech(now, dt) {
      if (now - this.voiceAt > 240) { this.voiceTarget = 0; this.voiceGate = false; }
      const target = this.voiceGate ? Math.pow(clamp((this.voiceTarget - .04) / .65, 0, 1), .65) : 0;
      const previous = this.voice;
      this.voice += (target - this.voice) * (1 - Math.exp(-dt / (target > this.voice ? 45 : 70)));
      if (this.voice < .003 && target === 0) this.voice = 0;
      if (this.speaking && !this.motion.matches && !window._windowDragActive &&
          !this.action && this.voice > .14 && this.voice - previous > .035 && now - this.lastSpeechAccent > 480) {
        this.speechPulse = Math.min(.65, this.voice * .65);
        this.lastSpeechAccent = now;
      }
      this.speechPulse *= Math.exp(-dt / 160);
      if (this.speechPulse < .002) this.speechPulse = 0;
      if (this.speechPulse || Math.abs(target - this.voice) > .003) this.settling = true;
    }
    updateGesture(now, dt, reduced) {
      const target = { bounce: 0, tilt: 0, nod: 0, wave: 0 };
      if (this.action) {
        const p = clamp((now - this.action.start) / this.action.duration, 0, 1);
        const envelope = Math.sin(Math.PI * p);
        if (this.action.name === 'bounce') target.bounce = -9 * envelope;
        if (this.action.name === 'sway') target.tilt = Math.sin(p * Math.PI * 2) * .025 * envelope;
        if (this.action.name === 'nod') target.nod = Math.sin(p * Math.PI * 2) * 2 * envelope;
        if (this.action.name === 'wave') target.wave = envelope * (-.19 + Math.sin(p * Math.PI * 8) * .045);
        if (p >= 1) this.action = null;
      }
      const blend = 1 - Math.exp(-dt / (this.action ? 65 : 150));
      for (const key of Object.keys(target)) {
        const desired = reduced ? target[key] * .2 : target[key];
        this.motionPose[key] += (desired - this.motionPose[key]) * blend;
        if (Math.abs(desired - this.motionPose[key]) > (key === 'tilt' || key === 'wave' ? .0002 : .005)) this.settling = true;
      }
    }
    reset() {
      this.clearPresentation();
      this.blinkStarted = null;
      this.expression = this.state;
      this.expressionUntil = 0;
      this.resetGaze();
      this.animate();
    }

    animate() {
      if (!this.active || this.destroyed || document.hidden || this.frame !== null || this.inFrame) return;
      const tick = now => {
        this.frame = null;
        if (!this.active || this.destroyed || document.hidden) return;
        // One 30fps clock for all parts. Hidden windows never keep animating.
        if (now - this.lastFrame >= 31) {
          const dt = Math.min(100, now - (this.lastFrame || now));
          this.lastFrame = now;
          this.inFrame = true;
          try { this.draw(now, dt); }
          finally { this.inFrame = false; }
        }
        if (!this.motion.matches || this.settling || this.action || this.blinkStarted !== null ||
            this.voice > .005 || this.voiceTarget > .005 || this.expressionUntil > now) {
          this.frame = requestAnimationFrame(tick);
        }
      };
      this.frame = requestAnimationFrame(tick);
    }

    sprite(id, x = 0, y = 0, context = this.context) {
      const part = this.parts.get(id);
      context.drawImage(part.image, part.x + x, part.y + y);
    }

    updateRig(now, dt, reduced) {
      const head = this.headPose, seconds = dt / 1000;
      const previousRoot = head.yaw * 3.2 + Math.sin(head.roll) * 158;
      if (reduced || now >= this.headRespondAt) {
        this.headGoal = { yaw: reduced ? 0 : this.gaze.x,
          pitch: reduced ? 0 : this.gaze.y * .75,
          roll: reduced ? 0 : this.gaze.x * .032 + Math.sin(now / 4300) * .0015 };
      }
      for (const axis of ['yaw', 'pitch', 'roll']) {
        const frequency = this.returning || reduced ? 7.8 : axis === 'roll' ? 8.6 : 10.5;
        const next = followSpring(head[axis], this.headVelocity[axis], this.headGoal[axis], seconds, frequency);
        const limit = axis === 'yaw' ? 1.02 : axis === 'pitch' ? .66 : .038;
        head[axis] = clamp(next.position, -limit, limit);
        this.headVelocity[axis] = head[axis] === next.position ? next.velocity : 0;
        if (Math.abs(this.headGoal[axis] - head[axis]) > .002 || Math.abs(this.headVelocity[axis]) > .004) this.settling = true;
      }
      const root = head.yaw * 3.2 + Math.sin(head.roll) * 158;
      const speed = seconds > 0 ? (root - previousRoot) / seconds : this.rootSpeed;
      const acceleration = seconds > 0 ? clamp((speed - this.rootSpeed) / seconds, -160, 160) : 0;
      this.rootSpeed = speed;
      // Hair reacts to its moving root, including when the head slows to a stop.
      const inertia = reduced ? 0 : clamp(-speed * .24 - acceleration * .009, -7, 7);
      const steps = Math.max(1, Math.ceil(dt / 16)), h = dt / steps / 1000;
      for (const [id, rig] of Object.entries(this.hairRigs)) {
        for (let side = 0; side < rig.chains.length; side++) {
          const chain = rig.chains[side];
          for (let step = 0; step < steps; step++) {
            for (let index = 1; index < chain.length; index++) {
              const joint = chain[index], weight = index / (chain.length - 1);
              const wind = reduced || window._windowDragActive ? 0 : Math.sin(now / 1000 * .95 - weight * 1.05 + side * 1.15 +
                (id === 'front-hair' ? .55 : 0)) * rig.amplitude * weight * weight;
              const driven = wind + chain[index - 1].offset * .55 + inertia * weight * (id === 'front-hair' ? .5 : 1);
              const target = reduced ? 0 : 10 * Math.tanh(driven / 10);
              const stiffness = 95 - index * 16, damping = 2 * Math.sqrt(stiffness) * .88;
              joint.velocity += ((target - joint.offset) * stiffness - joint.velocity * damping) * h;
              const offset = joint.offset + joint.velocity * h;
              joint.offset = clamp(offset, -12, 12);
              if (offset !== joint.offset) joint.velocity = 0;
              if (reduced && (Math.abs(joint.offset) > .015 || Math.abs(joint.velocity) > .015)) this.settling = true;
            }
          }
        }
      }
    }

    warpHead(x, y, depth = 25) {
      const yaw = this.headPose.yaw, pitch = this.headPose.pitch;
      const u = (x - 379) / 100, v = (y - 180) / 110;
      const volume = Math.sqrt(Math.max(0, 1 - u * u));
      // Preserve the lower jaw/neck connection while moving the face's volume.
      const attachment = 1 - ease((y - 237) / 54);
      return { x: x + ((x - 379) * (Math.cos(yaw * .4) - 1) + Math.sin(yaw * .4) * depth * volume) * attachment,
        y: y + (pitch * 6.2 * Math.max(0, 1 - v * v) + yaw * u * 1.3) * attachment };
    }

    hair(id) {
      const part = this.parts.get(id), rig = this.hairRigs[id];
      const bottom = part.y + part.height;
      rig.mesh.draw(this.context, part.image, (x, y) => {
        const point = this.warpHead(x, y, id === 'front-hair' ? 28 : -10);
        const along = clamp((y - rig.rootY) / (bottom - rig.rootY), 0, 1) * 3;
        const segment = Math.min(2, Math.floor(along)), blend = ease(along - segment);
        const offsets = rig.chains.map(chain => chain[segment].offset * (1 - blend) + chain[segment + 1].offset * blend);
        const across = ease((x - 340) / 80);
        const offset = offsets[0] * (1 - across) + offsets[1] * across;
        return { x: point.x + offset, y: point.y + offset * (across - .5) * .15 };
      });
    }

    eye(eye, closed, c = this.context) {
      const { side, white, surface } = eye;
      const iris = this.parts.get('irides-' + side), s = surface.getContext('2d');
      s.clearRect(0, 0, surface.width, surface.height);
      s.drawImage(white.image, 0, 0);
      s.globalCompositeOperation = 'source-atop';
      const lookX = clamp(this.gaze.x - this.headPose.yaw * .25, -1, 1);
      const lookY = clamp(this.gaze.y - this.headPose.pitch * .2, -.8, .8);
      s.drawImage(iris.image, iris.x - white.x + lookX * 2.7,
        iris.y - white.y + lookY * 1.8);
      s.globalCompositeOperation = 'source-over';
      // Reveal the face below the closing eyelid; never vertically squash pupils.
      const top = white.y + closed * white.height;
      c.save();
      c.beginPath();
      c.moveTo(white.x - 4, top + 4 * (1 - closed));
      c.quadraticCurveTo(white.x + white.width / 2, top - 5 * (1 - closed), white.x + white.width + 4, top);
      c.lineTo(white.x + white.width + 4, white.y + white.height + 3);
      c.lineTo(white.x - 4, white.y + white.height + 3);
      c.closePath(); c.clip();
      if (closed < .99) c.drawImage(surface, white.x, white.y);
      c.restore();
      const lash = this.parts.get('eyelash-' + side);
      const anchor = white.y + white.height - 3;
      c.save();
      c.translate(0, anchor); c.scale(1, 1 - closed * .96); c.translate(0, -anchor);
      this.sprite(lash.id, 0, 0, c);
      c.restore();
      // The low-resolution lash texture becomes subpixel-thin when fully shut.
      // Keep a readable curved lid instead of leaving a featureless face.
      if (closed > .5) {
        c.save();
        c.globalAlpha = ease((closed - .5) * 2);
        c.strokeStyle = '#5d4c5f'; c.lineWidth = 1.8; c.lineCap = 'round';
        c.beginPath();
        c.moveTo(white.x + 2, anchor - 1.4);
        c.quadraticCurveTo(white.x + white.width / 2, anchor + 3.2,
          white.x + white.width - 2, anchor - 2.5);
        c.stroke(); c.restore();
      }
    }

    brow(side, c = this.context) {
      const part = this.parts.get('eyebrow-' + side);
      const y = this.expressionPose[side + 'Y'], angle = this.expressionPose[side + 'Angle'];
      const cx = part.x + part.width / 2, cy = part.y + part.height / 2;
      c.save(); c.translate(cx, cy + y); c.rotate(angle); c.translate(-cx, -cy);
      this.sprite(part.id, 0, 0, c); c.restore();
    }

    drawMouth(c) {
      const open = ease((this.voice - .015) / .18);
      c.save(); c.globalAlpha = 1 - open;
      this.sprite('mouth', 0, 0, c); c.restore();
      if (open <= .001) return;
      // Hand-drawn simple mouth. The PSD still supplies no oral cavity/phonemes.
      const halfWidth = 3.3 + Math.sqrt(this.voice) * 2 + this.expressionPose.smile * .5;
      const depth = .65 + this.voice * 4.8;
      c.save(); c.globalAlpha = open; c.translate(380, 247);
      c.beginPath(); c.moveTo(-halfWidth, -.3);
      c.bezierCurveTo(-halfWidth * .5, -depth * .65, halfWidth * .5, -depth * .65, halfWidth, -.3);
      c.bezierCurveTo(halfWidth * .85, depth, -halfWidth * .85, depth, -halfWidth, -.3);
      c.closePath(); c.fillStyle = '#754454'; c.fill(); c.clip();
      c.fillStyle = '#d491a0'; c.beginPath();
      c.ellipse(.4, depth * .85, halfWidth * .58, depth * .3, 0, 0, Math.PI * 2); c.fill();
      c.restore();
    }

    composeFace(closed) {
      const c = this.faceSurface.getContext('2d'), rect = this.faceRect;
      c.setTransform(1, 0, 0, 1, -rect.x, -rect.y);
      c.clearRect(rect.x, rect.y, rect.width, rect.height);
      this.sprite('face', 0, 0, c);
      this.drawMouth(c);
      for (const eye of this.eyes) {
        const lid = this.expressionPose[eye.side + 'Lid'];
        this.eye(eye, closed + lid * (1 - closed), c);
      }
      this.brow('left', c); this.brow('right', c);
    }

    draw(now, dt) {
      const c = this.context, reduced = this.motion.matches, t = now / 1000;
      this.settling = false;
      this.updateAttention(now, reduced);
      const smoothing = 1 - Math.exp(-dt / (this.returning || reduced ? 150 : 80));
      this.gaze.x += ((reduced ? 0 : this.target.x) - this.gaze.x) * smoothing;
      this.gaze.y += ((reduced ? 0 : this.target.y) - this.gaze.y) * smoothing;
      if (Math.abs((reduced ? 0 : this.target.x) - this.gaze.x) > .005 ||
          Math.abs((reduced ? 0 : this.target.y) - this.gaze.y) > .005) this.settling = true;
      this.updateRig(now, dt, reduced);
      this.updateSpeech(now, dt);
      this.updateExpression(now, dt);
      this.updateGesture(now, dt, reduced);
      if (!reduced && this.blinkStarted === null && now >= this.nextBlink) this.blinkStarted = now;
      let closed = 0;
      if (this.blinkStarted !== null) {
        const age = now - this.blinkStarted;
        closed = age < 85 ? ease(age / 85) : age < 125 ? 1 : 1 - ease((age - 125) / 170);
        if (age > 295) { this.blinkStarted = null; this.nextBlink = now + 3200 + Math.random() * 3600; }
      }
      this.composeFace(closed);
      const breath = reduced ? 0 : Math.sin(t * Math.PI * 2 / 4.8);
      const { bounce, tilt, wave } = this.motionPose;
      const nod = this.motionPose.nod + (this.speaking && !reduced && !this.action ? this.speechPulse : 0);
      c.clearRect(0, 0, 768, 768);
      c.save();
      c.translate(384, 744 + bounce); c.rotate(tilt); c.scale(.94, .94); c.translate(-384, -768);
      this.baseMatrix = c.getTransform();
      c.save();
      this.headTransform(breath, nod);
      this.hair('back-hair');
      c.restore();
      this.sprite('footwear-left'); this.sprite('footwear-right');
      this.sprite('legwear-left'); this.sprite('legwear-right');
      c.save();
      c.translate(384, 420); c.scale(1 + breath * .0015, 1 + breath * .003); c.translate(-384, -420);
      this.sprite('bottomwear'); this.sprite('neck'); this.sprite('topwear');
      for (const side of ['left', 'right']) {
        const right = side === 'right', px = right ? 439 : 326;
        c.save(); c.translate(px, 304);
        c.rotate((reduced ? 0 : Math.sin(t * 1.3 + (right ? .7 : 0)) * .006) + (right ? wave : 0));
        c.translate(-px, -304); this.sprite('handwear-' + side); c.restore();
      }
      c.restore();
      c.save();
      this.headTransform(breath, nod);
      this.headMatrix = c.getTransform();
      this.faceMesh.draw(c, this.faceSurface, (x, y) => this.warpHead(x, y));
      this.hair('front-hair');
      const accessory = this.warpHead(449, 128, 28);
      const hairOffset = this.hairRigs['front-hair'].chains[1][2].offset;
      c.save(); c.translate(accessory.x, accessory.y); c.rotate(hairOffset * .0017);
      c.translate(-449, -128); this.sprite('headwear'); c.restore();
      c.restore(); c.restore();
    }

    headTransform(breath, nod) {
      const c = this.context;
      c.translate(384 + this.headPose.yaw * 3.2, 278 - breath * .6 + nod + this.headPose.pitch * 1.3);
      c.rotate(this.headPose.roll);
      c.translate(-384, -278);
    }

    point(clientX, clientY) {
      if (!this.active || !this.headMatrix) return null;
      const rect = this.canvas.getBoundingClientRect();
      const scale = Math.min(rect.width / 768, rect.height / 768);
      if (!scale) return null;
      const x = Math.floor((clientX - rect.left - (rect.width - 768 * scale) / 2) / scale);
      const y = Math.floor((clientY - rect.top - (rect.height - 768 * scale) / 2) / scale);
      if (x < 0 || y < 0 || x >= 768 || y >= 768 || this.context.getImageData(x, y, 1, 1).data[3] <= 40) return null;
      const head = new DOMPoint(x, y).matrixTransform(this.headMatrix.inverse());
      const face = this.faceMesh.unproject(head.x, head.y) || head;
      const body = new DOMPoint(x, y).matrixTransform(this.baseMatrix.inverse());
      const isHead = ((face.x - 382) / 114) ** 2 + ((face.y - 169) / 116) ** 2 <= 1;
      return { x, y, zone: isHead ? 'head' : body.x > 475 && body.y > 430 && body.y < 545 ? 'hand' : 'body' };
    }

    pause() { cancelAnimationFrame(this.frame); this.frame = null; this.lastFrame = 0; }
    destroy() {
      this.destroyed = true; this.enabled = false; this.sync(); this.pause();
      document.removeEventListener('visibilitychange', this.visibilityChanged);
      this.motion.removeEventListener('change', this.preferenceChanged);
      this.canvas.remove(); this.parts.clear();
    }
  };
})();
