// A small two-joint sleeve rig built from the user's unmodified PNGs.
// Geometry, masks and texture deformation exist only in the renderer.
window.PortraitWave = class PortraitWave {
  constructor(image) {
    this.image = image;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'portrait-wave';
    this.canvas.hidden = true;
    this.canvas.setAttribute('aria-hidden', 'true');
    image.parentElement.appendChild(this.canvas);
    this.context = this.canvas.getContext('2d', { willReadFrequently: true });
    this.portraitURL = new URL('../assets/zhixiaoli/portrait.png', location.href).href;
    this.active = false;
    this.version = 0;
    this.frame = null;
    this.destroyed = false;
    this.shoulder = { x: 377, y: 350 };
    this.elbow = { x: 495, y: 670 };
    this.wrist = { x: 762, y: 1112 };
    this.anchor = { x: 694, y: 629 };
    this.scale = .35;
    this.loaded = Promise.all(['body', 'sleeve', 'hand'].map(name => new Promise(resolve => {
      const asset = new Image();
      this[name] = asset;
      asset.onload = () => resolve(true);
      asset.onerror = () => resolve(false);
      asset.src = new URL('../assets/zhixiaoli/wave-' + name + '.png', location.href).href;
    }))).then(values => {
      this.available = values.every(Boolean);
      return this.available;
    });
    this.onVisibility = () => { if (document.hidden) this.stop(); };
    document.addEventListener('visibilitychange', this.onVisibility);
  }

  smooth(value) {
    const t = Math.max(0, Math.min(1, value));
    return t * t * (3 - 2 * t);
  }

  prepare() {
    if (!this.available || this.destroyed || this.image.src !== this.portraitURL ||
        !this.image.complete || !this.image.naturalWidth) return false;
    if (this.prepared) return true;
    this.canvas.width = this.image.naturalWidth;
    this.canvas.height = this.image.naturalHeight;
    this.base = document.createElement('canvas');
    this.rig = document.createElement('canvas');
    for (const canvas of [this.base, this.rig]) {
      canvas.width = this.canvas.width;
      canvas.height = this.canvas.height;
    }
    const width = this.canvas.width;
    const height = this.canvas.height;
    const mask = document.createElement('canvas');
    mask.width = width;
    mask.height = height;
    const m = mask.getContext('2d');
    m.filter = 'blur(2px)';
    // Replace only the original arm and the immediately surrounding hair.
    // The original face, left arm and the rest of the portrait stay exact.
    m.fill(new Path2D('M650 580 L745 575 L845 740 L929 884 L930 1010 L788 1005 L743 855 L683 775 Z'));
    const patch = document.createElement('canvas');
    patch.width = width;
    patch.height = height;
    const p = patch.getContext('2d');
    p.drawImage(this.body, 0, 0, width, height);
    p.globalCompositeOperation = 'destination-in';
    p.drawImage(mask, 0, 0);
    const b = this.base.getContext('2d');
    b.drawImage(this.image, 0, 0);
    b.globalCompositeOperation = 'destination-out';
    b.drawImage(mask, 0, 0);
    b.globalCompositeOperation = 'source-over';
    b.drawImage(patch, 0, 0);

    // One shared grid preserves matching seams and patterns at the elbow.
    const cols = 7;
    const rows = 24;
    this.vertices = [];
    const axisX = this.wrist.x - this.elbow.x;
    const axisY = this.wrist.y - this.elbow.y;
    const length = Math.hypot(axisX, axisY);
    for (let row = 0; row <= rows; row++) {
      for (let col = 0; col <= cols; col++) {
        const x = 270 + 630 * col / cols;
        const y = 250 + 980 * row / rows;
        const along = ((x - this.elbow.x) * axisX + (y - this.elbow.y) * axisY) / length;
        this.vertices.push({ x, y, weight: this.smooth((along + 85) / 170) });
      }
    }
    this.triangles = [];
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const a = row * (cols + 1) + col;
        const b = a + 1;
        const c = a + cols + 1;
        const d = c + 1;
        this.triangles.push([a, b, c], [b, d, c]);
      }
    }
    this.prepared = true;
    return true;
  }

  rotate(x, y, angle) {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    return { x: x * cos - y * sin, y: x * sin + y * cos };
  }

  pose(upper, bend) {
    const elbowOffset = this.rotate((this.elbow.x - this.shoulder.x) * this.scale,
      (this.elbow.y - this.shoulder.y) * this.scale, upper);
    const elbow = { x: this.anchor.x + elbowOffset.x, y: this.anchor.y + elbowOffset.y };
    const transform = point => {
      const a = this.rotate((point.x - this.shoulder.x) * this.scale,
        (point.y - this.shoulder.y) * this.scale, upper);
      const b = this.rotate((point.x - this.elbow.x) * this.scale,
        (point.y - this.elbow.y) * this.scale, upper + bend);
      const weight = point.weight;
      return { x: (this.anchor.x + a.x) * (1 - weight) + (elbow.x + b.x) * weight,
        y: (this.anchor.y + a.y) * (1 - weight) + (elbow.y + b.y) * weight };
    };
    const wristOffset = this.rotate((this.wrist.x - this.elbow.x) * this.scale,
      (this.wrist.y - this.elbow.y) * this.scale, upper + bend);
    return { points: this.vertices.map(transform), wrist: {
      x: elbow.x + wristOffset.x, y: elbow.y + wristOffset.y,
    } };
  }

  textureTriangle(c, indices, points, alpha = 1) {
    const [s0, s1, s2] = indices.map(index => this.vertices[index]);
    const [p0, p1, p2] = indices.map(index => points[index]);
    const sx1 = s1.x - s0.x, sy1 = s1.y - s0.y;
    const sx2 = s2.x - s0.x, sy2 = s2.y - s0.y;
    const dx1 = p1.x - p0.x, dy1 = p1.y - p0.y;
    const dx2 = p2.x - p0.x, dy2 = p2.y - p0.y;
    const det = sx1 * sy2 - sx2 * sy1;
    const a = (dx1 * sy2 - dx2 * sy1) / det;
    const b = (dy1 * sy2 - dy2 * sy1) / det;
    const d = (dy2 * sx1 - dy1 * sx2) / det;
    const f = (dx2 * sx1 - dx1 * sx2) / det;
    c.save();
    c.globalAlpha = alpha;
    // A subpixel overlap hides antialias cracks between adjacent triangles.
    const cx = (p0.x + p1.x + p2.x) / 3;
    const cy = (p0.y + p1.y + p2.y) / 3;
    c.beginPath();
    [p0, p1, p2].forEach((point, index) => {
      const length = Math.hypot(point.x - cx, point.y - cy) || 1;
      const x = point.x + (point.x - cx) * .45 / length;
      const y = point.y + (point.y - cy) * .45 / length;
      if (index === 0) c.moveTo(x, y); else c.lineTo(x, y);
    });
    c.closePath();
    c.clip();
    c.transform(a, b, f, d, p0.x - a * s0.x - f * s0.y, p0.y - b * s0.x - d * s0.y);
    c.drawImage(this.sleeve, 0, 0);
    c.restore();
  }

  draw(upper, bend, wristAngle, blend) {
    const c = this.rig.getContext('2d');
    const { points, wrist } = this.pose(upper, bend);
    c.clearRect(0, 0, this.rig.width, this.rig.height);
    // Shoulder stays behind the original fringe; the raised forearm comes forward.
    for (const triangle of this.triangles) this.textureTriangle(c, triangle, points);
    c.drawImage(this.base, 0, 0);
    for (const triangle of this.triangles) {
      const weight = triangle.reduce((sum, index) => sum + this.vertices[index].weight, 0) / 3;
      const alpha = this.smooth((weight - .15) / .7);
      if (alpha > .001) this.textureTriangle(c, triangle, points, alpha);
    }
    c.save();
    c.translate(wrist.x, wrist.y);
    c.rotate(upper + bend + wristAngle - .1);
    c.scale(.22, .22);
    // Extra wrist skin sits beneath the opaque sleeve cuff.
    c.drawImage(this.hand, -690, -733);
    c.restore();
    // Repaint the cuff over the wrist seam, while leaving the palm exposed.
    for (const triangle of this.triangles) {
      const y = triangle.reduce((sum, index) => sum + this.vertices[index].y, 0) / 3;
      if (y > 1030) this.textureTriangle(c, triangle, points);
    }
    const output = this.context;
    output.clearRect(0, 0, this.canvas.width, this.canvas.height);
    output.save();
    output.globalAlpha = 1 - blend;
    output.drawImage(this.image, 0, 0);
    output.globalCompositeOperation = 'lighter';
    output.globalAlpha = blend;
    output.drawImage(this.rig, 0, 0);
    output.restore();
  }

  async play() {
    this.stop();
    const version = this.version;
    const available = await this.loaded;
    if (version !== this.version || this.destroyed || document.hidden) return false;
    if (!available || !this.prepare()) {
      window.dispatchEvent(new CustomEvent('portrait-error', {
        detail: this.image.src === this.portraitURL ? '挥手素材暂时无法加载。' : '挥手动作适用于默认智小理形象。',
      }));
      return false;
    }
    this.active = true;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const start = performance.now();
    this.draw(0, 0, 0, 0);
    this.canvas.hidden = false;
    this.image.closest('#portrait-pet').classList.add('waving');
    const tick = now => {
      if (!this.active || version !== this.version) return;
      const time = (now - start) / 1000;
      if (time >= 3.35) { this.stop(); return; }
      const lift = this.smooth((time - .12) / .7) * (1 - this.smooth((time - 2.4) / .72));
      const progress = Math.max(0, Math.min(1, (time - .82) / 1.58));
      const envelope = Math.sin(progress * Math.PI);
      const swing = reduced ? 0 : Math.sin(progress * Math.PI * 5) * envelope;
      const radians = Math.PI / 180;
      const blend = this.smooth(time / .16) * (1 - this.smooth((time - 3.12) / .2));
      this.draw((-58 * lift + swing * 1.4) * radians,
        (-55 * lift + swing * 8) * radians, swing * 13 * radians, blend);
      this.frame = requestAnimationFrame(tick);
    };
    this.frame = requestAnimationFrame(tick);
    return true;
  }

  hitTest(x, y) {
    if (!this.active || x < 0 || y < 0 || x >= this.canvas.width || y >= this.canvas.height) return false;
    return this.context.getImageData(Math.floor(x), Math.floor(y), 1, 1).data[3] > 40;
  }

  stop() {
    ++this.version;
    cancelAnimationFrame(this.frame);
    this.frame = null;
    this.active = false;
    this.canvas.hidden = true;
    this.image.closest('#portrait-pet')?.classList.remove('waving');
  }

  destroy() {
    this.destroyed = true;
    this.stop();
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.canvas.remove();
  }
};
