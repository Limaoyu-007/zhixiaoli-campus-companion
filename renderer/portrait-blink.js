// Portrait-specific eye/brow compositor. Face motion shares one animation clock.
// Supplied artwork is aligned at runtime; the original PNGs stay unchanged.
window.PortraitBlink = class PortraitBlink {
  constructor(image) {
    this.image = image;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'portrait-blink';
    this.canvas.setAttribute('aria-hidden', 'true');
    image.parentElement.appendChild(this.canvas);
    this.context = this.canvas.getContext('2d');
    this.portraitURL = new URL('../assets/zhixiaoli/portrait.png', location.href).href;
    this.gaze = { x: 0, y: 0, weight: 0 };
    this.gazeTarget = { ...this.gaze };
    this.closed = 0;
    this.frame = null;
    this.blinkStarted = null;
    this.restExpression = 'neutral';
    this.presets = {
      neutral:   { leftY: 0, rightY: 0, leftAngle: 0, rightAngle: 0, lid: 0, weight: 0 },
      attentive: { leftY: -1.4, rightY: -1.1, leftAngle: -.012, rightAngle: .012, lid: 0, weight: 1 },
      gentle:    { leftY: -.7, rightY: -.5, leftAngle: -.025, rightAngle: .025, lid: .09, weight: 1 },
      happy:     { leftY: -1.7, rightY: -1.4, leftAngle: -.015, rightAngle: .015, lid: .19, weight: 1 },
      curious:   { leftY: -2.5, rightY: .4, leftAngle: -.035, rightAngle: -.015, lid: .025, weight: 1 },
      concerned: { leftY: -.5, rightY: -.5, leftAngle: -.055, rightAngle: .055, lid: .06, weight: 1 },
    };
    this.expression = { ...this.presets.neutral };
    this.expressionTarget = { ...this.expression };
    this.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    for (const [property, file] of Object.entries({
      face: 'face-base.png', whites: 'eye-whites.png', irises: 'irises.png',
      lashes: 'lashes.png', brows: 'brows.png',
    })) {
      const asset = new Image();
      this[property] = asset;
      asset.onload = () => this.prepare();
      asset.src = new URL('../assets/zhixiaoli/' + file, location.href).href;
    }
    this.eyeSpecs = [
      { x: 382, y: 355, w: 120, h: 96, anchor: 422,
        shape: 'M388 405 Q396 391 407 381 L400 374 L417 376 Q448 356 474 379 Q489 391 493 413 L490 431 Q462 450 429 442 Q408 437 398 420 Z',
        aperture: 'M409 400 C412 383 434 374 453 379 C475 382 486 400 484 420 C481 437 461 444 443 440 C423 438 411 424 409 400 Z',
        iris: [426, 377, 61, 66], irisSource: [322, 668, 143, 153],
        whites: [294, 611, 179, 130, 408, 375, 80, 69],
        lashSource: [273, 595, 218, 137], lashDest: [388, 357, 109, 68],
        line: [402, 418, 444, 437, 485, 419] },
      { x: 559, y: 336, w: 119, h: 102, anchor: 407,
        shape: 'M567 384 Q573 362 591 353 Q618 339 644 350 L654 343 L652 355 L666 369 L671 374 L660 379 Q654 411 642 422 Q610 435 584 419 Q570 409 567 384 Z',
        aperture: 'M575 381 C578 365 594 354 612 355 C634 355 649 372 649 391 C647 411 633 425 612 425 C590 424 578 409 575 381 Z',
        iris: [575, 359, 62, 68], irisSource: [623, 668, 145, 153],
        whites: [632, 603, 182, 130, 573, 353, 78, 73],
        lashSource: [630, 591, 211, 125], lashDest: [566, 338, 107, 63],
        line: [576, 403, 615, 423, 655, 399] },
    ];
    this.browSpecs = [
      { x: 409, y: 301, w: 61, h: 43, source: [180, 648, 255, 92], dest: [408, 310, 59, 22],
        shape: 'M417 317 L447 303 L460 313 L466 337 L414 342 Z' },
      { x: 566, y: 291, w: 61, h: 39, source: [659, 631, 251, 107], dest: [564, 297, 62, 26],
        shape: 'M568 299 L584 292 L614 296 L623 311 L623 324 L573 327 Z' },
    ];
    this.onVisibility = () => {
      this.stop();
      if (!document.hidden && this.eyes) {
        this.expressionTarget = { ...this.presets[this.restExpression] };
        this.schedule();
        this.animate();
      }
    };
    this.onMotionPreference = () => {
      this.resetGaze();
      clearTimeout(this.timer);
      if (!this.reducedMotion.matches) this.schedule();
    };
    document.addEventListener('visibilitychange', this.onVisibility);
    this.reducedMotion.addEventListener('change', this.onMotionPreference);
  }

  cleanSkin(spec, path) {
    const skin = document.createElement('canvas');
    skin.width = spec.w;
    skin.height = spec.h;
    const c = skin.getContext('2d');
    c.drawImage(this.face, 275, 385, 535, 570, 374 - spec.x, 277 - spec.y, 305, 231);
    const mask = document.createElement('canvas');
    mask.width = spec.w;
    mask.height = spec.h;
    const m = mask.getContext('2d');
    m.filter = 'blur(1px)';
    m.translate(-spec.x, -spec.y);
    m.fill(path);
    c.globalCompositeOperation = 'destination-in';
    c.drawImage(mask, 0, 0);
    return skin;
  }

  prepare() {
    this.stop();
    this.eyes = null;
    this.eyebrows = null;
    if (this.image.closest('#portrait-pet')?.classList.contains('layered')) return;
    // Fixed face coordinates never apply to replacement portraits.
    if (this.image.src !== this.portraitURL || !this.image.complete ||
        !this.image.naturalWidth || !this.face.naturalWidth) return;
    this.canvas.width = this.image.naturalWidth;
    this.canvas.height = this.image.naturalHeight;
    this.eyes = this.eyeSpecs.map(spec => {
      const path = new Path2D(spec.shape);
      const open = document.createElement('canvas');
      open.width = spec.w;
      open.height = spec.h;
      const c = open.getContext('2d');
      c.translate(-spec.x, -spec.y);
      c.clip(path);
      c.drawImage(this.image, 0, 0);
      const pupil = document.createElement('canvas');
      const [ix, iy, iw, ih] = spec.iris;
      pupil.width = iw;
      pupil.height = ih;
      const p = pupil.getContext('2d');
      p.beginPath();
      p.ellipse(iw / 2, ih / 2, iw / 2, ih / 2, 0, 0, Math.PI * 2);
      p.clip();
      if (this.irises.naturalWidth) p.drawImage(this.irises, ...spec.irisSource, 0, 0, iw, ih);
      else p.drawImage(this.image, -ix, -iy);
      const tracked = document.createElement('canvas');
      tracked.width = spec.w;
      tracked.height = spec.h;
      return { ...spec, path, open, pupil, tracked,
        skin: this.cleanSkin(spec, path), aperturePath: new Path2D(spec.aperture) };
    });
    this.eyebrows = this.browSpecs.map(spec => {
      const path = new Path2D(spec.shape);
      return { ...spec, path, skin: this.cleanSkin(spec, path) };
    });
    this.expressionTarget = { ...this.presets[this.restExpression] };
    this.schedule(1800 + Math.random() * 1200);
    this.animate();
  }

  schedule(delay = 3400 + Math.random() * 3600, allowDouble = true) {
    clearTimeout(this.timer);
    if (!document.hidden && this.eyes && !this.reducedMotion.matches) {
      this.timer = setTimeout(() => this.blink(allowDouble), delay);
    }
  }

  blink(allowDouble = true) {
    if (!this.eyes || document.hidden || this.blinkStarted !== null) return;
    clearTimeout(this.timer);
    this.blinkStarted = performance.now();
    this.openDuration = 145 + Math.random() * 40;
    this.doubleBlink = allowDouble && Math.random() < .09;
    this.animate();
  }

  setState(name) {
    this.restExpression = Object.hasOwn(this.presets, name) ? name : 'neutral';
    if (!this.transient) this.setExpression(this.restExpression);
  }

  setExpression(name, { duration = 0 } = {}) {
    if (!Object.hasOwn(this.presets, name)) return;
    clearTimeout(this.expressionTimer);
    this.transient = duration > 0;
    this.expressionTarget = { ...this.presets[name] };
    if (duration > 0) {
      this.expressionTimer = setTimeout(() => {
        this.transient = false;
        this.setExpression(this.restExpression);
      }, duration);
    }
    this.animate();
  }

  followPointer(clientX, clientY) {
    if (!this.eyes || !this.whites.naturalWidth || document.hidden || this.reducedMotion.matches) return;
    const rect = this.image.getBoundingClientRect();
    const scale = Math.min(rect.width / this.image.naturalWidth, rect.height / this.image.naturalHeight);
    if (!Number.isFinite(scale) || scale <= 0) return;
    const left = rect.left + (rect.width - this.image.naturalWidth * scale) / 2;
    const top = rect.top + (rect.height - this.image.naturalHeight * scale) / 2;
    const dx = (clientX - left - 531 * scale) / (this.image.naturalWidth * scale * .6);
    const dy = (clientY - top - 399 * scale) / (this.image.naturalHeight * scale * .3);
    const distance = Math.max(1, Math.hypot(dx, dy));
    this.nextGaze = { x: dx / distance * 3.8, y: dy / distance * 2.1, weight: 1 };
    // Track a settled target rather than every tiny cursor movement.
    if (!this.gazeDelay) {
      this.gazeDelay = setTimeout(() => {
        this.gazeDelay = null;
        this.gazeTarget = this.nextGaze;
        this.animate();
      }, 85);
    }
    clearTimeout(this.gazeIdleTimer);
    this.gazeIdleTimer = setTimeout(() => this.resetGaze(), 1700);
  }

  resetGaze() {
    clearTimeout(this.gazeIdleTimer);
    clearTimeout(this.gazeDelay);
    this.gazeDelay = null;
    this.gazeTarget = { x: 0, y: 0, weight: 0 };
    this.animate();
  }

  animate() {
    if (this.frame !== null || !this.eyes || document.hidden) return;
    let previous = performance.now();
    const tick = now => {
      this.frame = null;
      if (!this.eyes || document.hidden) return;
      const elapsed = Math.max(0, Math.min(64, now - previous));
      previous = now;
      let moving = false;
      const approach = (current, target, time) => {
        for (const key of Object.keys(current)) {
          const delta = target[key] - current[key];
          if (Math.abs(delta) < .001) current[key] = target[key];
          else {
            current[key] += delta * (1 - Math.exp(-elapsed / time));
            moving = true;
          }
        }
      };
      approach(this.gaze, this.gazeTarget, this.gazeTarget.weight ? 170 : 330);
      approach(this.expression, this.expressionTarget, this.expressionTarget.weight ? 190 : 320);
      if (this.blinkStarted !== null) {
        const age = now - this.blinkStarted;
        const closeTime = 76;
        const holdTime = 28;
        this.closed = age < closeTime ? Math.sin(age / closeTime * Math.PI / 2)
          : age < closeTime + holdTime ? 1
          : Math.max(0, Math.cos(Math.min(1, (age - closeTime - holdTime) / this.openDuration) * Math.PI / 2));
        if (age >= closeTime + holdTime + this.openDuration) {
          this.closed = 0;
          this.blinkStarted = null;
          if (this.doubleBlink) this.schedule(140, false);
          else this.schedule();
        } else moving = true;
      }
      this.draw();
      if (moving) this.frame = requestAnimationFrame(tick);
    };
    this.frame = requestAnimationFrame(tick);
  }

  composeOpenEye(eye) {
    const c = eye.tracked.getContext('2d');
    c.clearRect(0, 0, eye.w, eye.h);
    c.drawImage(eye.open, 0, 0);
    if (!this.whites.naturalWidth) return eye.tracked;
    c.save();
    c.translate(-eye.x, -eye.y);
    c.clip(eye.aperturePath);
    const white = c.createLinearGradient(0, eye.y + 20, 0, eye.y + eye.h);
    white.addColorStop(0, '#bfc2d2');
    white.addColorStop(.55, '#f3f2f8');
    white.addColorStop(1, '#fff9f7');
    c.fillStyle = white;
    c.fill(eye.aperturePath);
    c.drawImage(this.whites, ...eye.whites);
    const [x, y] = eye.iris;
    c.drawImage(eye.pupil, x + this.gaze.x, y + this.gaze.y);
    c.restore();
    return eye.tracked;
  }

  drawEye(c, eye, closed) {
    c.drawImage(eye.skin, eye.x, eye.y);
    c.save();
    c.clip(eye.path);
    if (closed < .98) {
      c.save();
      c.clip(eye.aperturePath);
      // The moving lid occludes the iris, preserving its shape and highlights.
      const top = eye.y + 9 + (eye.anchor - eye.y - 9) * closed;
      const bottom = eye.y + eye.h - (eye.y + eye.h - eye.anchor - 1) * closed;
      c.beginPath();
      c.moveTo(eye.x, top + 7 * (1 - closed));
      c.quadraticCurveTo(eye.x + eye.w / 2, top - 7 * (1 - closed), eye.x + eye.w, top + 5 * (1 - closed));
      c.lineTo(eye.x + eye.w, bottom);
      c.quadraticCurveTo(eye.x + eye.w / 2, bottom + 3 * (1 - closed), eye.x, bottom);
      c.closePath();
      c.clip();
      c.drawImage(this.composeOpenEye(eye), eye.x, eye.y);
      c.restore();
    }
    if (this.lashes.naturalWidth) {
      const [x, y, w, h] = eye.lashDest;
      c.save();
      c.globalAlpha *= Math.max(0, 1 - Math.max(0, closed - .66) / .34);
      c.drawImage(this.lashes, ...eye.lashSource,
        x, y + (eye.anchor - y - 4) * closed, w, h * (1 - .88 * closed));
      c.restore();
    } else if (closed < .05) {
      c.drawImage(eye.open, eye.x, eye.y);
    }
    c.save();
    c.globalAlpha *= Math.max(0, (closed - .58) / .42);
    c.strokeStyle = '#493637';
    c.lineWidth = 2.8;
    c.lineCap = 'round';
    c.beginPath();
    c.moveTo(eye.line[0], eye.line[1]);
    c.quadraticCurveTo(...eye.line.slice(2));
    c.stroke();
    c.restore();
    c.restore();
  }

  drawBrows(c) {
    if (!this.brows.naturalWidth || this.expression.weight < .001) return;
    for (const [index, brow] of this.eyebrows.entries()) {
      const side = index === 0 ? 'left' : 'right';
      const [x, y, w, h] = brow.dest;
      c.save();
      c.globalAlpha = this.expression.weight;
      c.drawImage(brow.skin, brow.x, brow.y);
      // Forehead masks keep the supplied eyebrows behind the fringe.
      c.clip(brow.path);
      c.translate(x + w / 2, y + h / 2 + this.expression[side + 'Y']);
      c.rotate(this.expression[side + 'Angle']);
      c.drawImage(this.brows, ...brow.source, -w / 2, -h / 2, w, h);
      c.restore();
    }
  }

  draw() {
    const c = this.context;
    c.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (!this.eyes) return;
    const activity = Math.max(Math.min(1, this.closed / .12), this.gaze.weight, this.expression.weight);
    if (activity < .001) return;
    const closed = this.closed + this.expression.lid * (1 - this.closed);
    c.save();
    c.globalAlpha = activity;
    for (const eye of this.eyes) this.drawEye(c, eye, closed);
    c.restore();
    this.drawBrows(c);
  }

  stop() {
    clearTimeout(this.timer);
    clearTimeout(this.expressionTimer);
    clearTimeout(this.gazeIdleTimer);
    clearTimeout(this.gazeDelay);
    cancelAnimationFrame(this.frame);
    this.frame = null;
    this.gazeDelay = null;
    this.blinkStarted = null;
    this.closed = 0;
    this.transient = false;
    this.gaze = { x: 0, y: 0, weight: 0 };
    this.gazeTarget = { ...this.gaze };
    this.expression = { ...this.presets.neutral };
    this.expressionTarget = { ...this.expression };
    this.context.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  destroy() {
    this.stop();
    for (const name of ['face', 'whites', 'irises', 'lashes', 'brows']) this[name].onload = null;
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.reducedMotion.removeEventListener('change', this.onMotionPreference);
    this.canvas.remove();
  }
};
