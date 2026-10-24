// Lightweight, amplitude-driven mouth for the bundled portrait, not phoneme sync.
// Keep the original smile visible whenever speech is silent.
window.PortraitMouth = class PortraitMouth {
  constructor(image) {
    this.image = image;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'portrait-mouth';
    this.canvas.setAttribute('aria-hidden', 'true');
    image.parentElement.appendChild(this.canvas);
    this.context = this.canvas.getContext('2d');
    this.portraitURL = new URL('../assets/zhixiaoli/portrait.png', location.href).href;
    this.area = { x: 503, y: 441, w: 65, h: 46 };
    this.enabled = false;
    this.opening = 0;
    this.target = 0;
    this.gateOpen = false;
    this.frame = null;
    this.face = new Image();
    this.face.onload = () => this.prepare();
    this.face.src = new URL('../assets/zhixiaoli/face-base.png', location.href).href;
    this.onVisibility = () => { if (document.hidden) this.stop(); };
    document.addEventListener('visibilitychange', this.onVisibility);
  }

  prepare() {
    this.reset();
    if (this.image.closest('#portrait-pet')?.classList.contains('layered')) return;
    // Never draw these fixed coordinates over a user's replacement image.
    if (this.image.src !== this.portraitURL || !this.image.complete ||
        !this.image.naturalWidth || !this.face.naturalWidth) return;
    this.canvas.width = this.image.naturalWidth;
    this.canvas.height = this.image.naturalHeight;
    const { x, y, w, h } = this.area;
    this.skin = document.createElement('canvas');
    this.skin.width = w;
    this.skin.height = h;
    const s = this.skin.getContext('2d');
    // Same clean-face alignment as the existing blink effect.
    s.drawImage(this.face, 275, 385, 535, 570, 374 - x, 277 - y, 305, 231);
    const mask = document.createElement('canvas');
    mask.width = w;
    mask.height = h;
    const m = mask.getContext('2d');
    // Scale a feathered radial mask to cover the original smile and open mouth.
    m.translate(535 - x, 463 - y);
    m.scale(29, 18);
    const edge = m.createRadialGradient(0, 0, 0.65, 0, 0, 1);
    edge.addColorStop(0, '#fff');
    edge.addColorStop(1, 'rgba(255,255,255,0)');
    m.fillStyle = edge;
    m.fillRect(-1, -1, 2, 2);
    s.globalCompositeOperation = 'destination-in';
    s.drawImage(mask, 0, 0);
    this.enabled = true;
  }

  setLevel(value) {
    if (!this.enabled || document.hidden) return;
    const level = Math.max(0, Math.min(1, Number(value) || 0));
    // Hysteresis prevents quiet background energy from repeatedly opening the mouth.
    if (level >= 0.08) this.gateOpen = true;
    else if (level <= 0.045) this.gateOpen = false;
    const energy = this.gateOpen ? Math.max(0, (level - 0.045) / 0.72) : 0;
    this.target = Math.min(1, Math.sqrt(energy));
    if (this.frame !== null || (this.opening === 0 && this.target === 0)) return;
    let previous = performance.now();
    const tick = now => {
      this.frame = null;
      if (!this.enabled || document.hidden) return;
      const elapsed = Math.min(64, now - previous);
      previous = now;
      const timeConstant = this.target > this.opening ? 45 : 90;
      this.opening += (this.target - this.opening) * (1 - Math.exp(-elapsed / timeConstant));
      const settled = Math.abs(this.target - this.opening) < 0.006;
      if (settled) this.opening = this.target;
      this.draw();
      if (!settled) this.frame = requestAnimationFrame(tick);
    };
    this.frame = requestAnimationFrame(tick);
  }

  draw() {
    const c = this.context;
    const { x, y, w, h } = this.area;
    c.clearRect(x, y, w, h);
    if (this.opening < 0.015) return;
    const amount = this.opening;
    const cx = 535;
    const cy = 460;
    const halfWidth = 15 + amount * 3;
    const depth = 3 + amount * 14;
    c.save();
    c.globalAlpha = Math.min(1, amount / 0.12);
    c.drawImage(this.skin, x, y);
    const mouth = new Path2D();
    mouth.moveTo(cx - halfWidth, cy);
    mouth.quadraticCurveTo(cx, cy + 5, cx + halfWidth, cy - 3);
    mouth.bezierCurveTo(cx + halfWidth - 2, cy + depth,
      cx - halfWidth + 3, cy + depth + 2, cx - halfWidth, cy);
    mouth.closePath();
    const inside = c.createLinearGradient(0, cy, 0, cy + depth);
    inside.addColorStop(0, '#82414d');
    inside.addColorStop(1, '#bb687a');
    c.fillStyle = inside;
    c.fill(mouth);
    c.strokeStyle = '#b06c71';
    c.lineWidth = 1.4;
    c.lineJoin = 'round';
    c.stroke(mouth);
    c.clip(mouth);
    c.fillStyle = '#e5a0aa';
    c.beginPath();
    c.ellipse(cx + 1, cy + depth - 1, halfWidth * 0.65, depth * 0.26,
      -0.05, 0, Math.PI * 2);
    c.fill();
    c.restore();
  }

  stop() {
    cancelAnimationFrame(this.frame);
    this.frame = null;
    this.opening = 0;
    this.target = 0;
    this.gateOpen = false;
    const { x, y, w, h } = this.area;
    this.context.clearRect(x, y, w, h);
  }

  reset() {
    this.stop();
    this.enabled = false;
  }

  destroy() {
    this.reset();
    this.face.onload = null;
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.canvas.remove();
  }
};
