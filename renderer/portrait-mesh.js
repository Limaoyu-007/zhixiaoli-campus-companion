// Small Canvas triangle mesh. No external editor, runtime, or model format.
// Source coordinates stay local to the texture; destination coordinates stay
// in the PSD canvas, so all parent transforms and pointer calculations agree.
(function () {
  'use strict';
  window.PortraitMesh = class PortraitMesh {
    constructor(rect, columns, rows) {
      this.rect = { ...rect };
      this.points = [];
      this.triangles = [];
      for (let row = 0; row <= rows; row++) {
        for (let column = 0; column <= columns; column++) {
          const x = column * rect.width / columns, y = row * rect.height / rows;
          this.points.push({ x, y, worldX: rect.x + x, worldY: rect.y + y,
            targetX: rect.x + x, targetY: rect.y + y });
        }
      }
      for (let row = 0; row < rows; row++) {
        for (let column = 0; column < columns; column++) {
          const a = row * (columns + 1) + column, b = a + 1;
          const d = a + columns + 1, e = d + 1;
          // Alternate diagonals to avoid a directional bias when bending.
          const indices = (row + column) % 2 ? [[a, b, d], [b, e, d]] : [[a, b, e], [a, e, d]];
          for (const ids of indices) {
            const [p, q, r] = ids.map(index => this.points[index]);
            const x1 = q.x - p.x, y1 = q.y - p.y, x2 = r.x - p.x, y2 = r.y - p.y;
            const left = Math.max(0, Math.floor(Math.min(p.x, q.x, r.x)) - 1);
            const top = Math.max(0, Math.floor(Math.min(p.y, q.y, r.y)) - 1);
            const right = Math.min(rect.width, Math.ceil(Math.max(p.x, q.x, r.x)) + 1);
            const bottom = Math.min(rect.height, Math.ceil(Math.max(p.y, q.y, r.y)) + 1);
            this.triangles.push({ ids, x1, y1, x2, y2, denominator: x1 * y2 - x2 * y1,
              crop: [left, top, right - left, bottom - top] });
          }
        }
      }
    }

    draw(context, texture, deform) {
      for (const point of this.points) {
        const target = deform(point.worldX, point.worldY);
        point.targetX = target.x; point.targetY = target.y;
      }
      for (const triangle of this.triangles) {
        const [p, q, r] = triangle.ids.map(index => this.points[index]);
        const dx1 = q.targetX - p.targetX, dx2 = r.targetX - p.targetX;
        const dy1 = q.targetY - p.targetY, dy2 = r.targetY - p.targetY;
        if (Math.abs(dx1 * dy2 - dx2 * dy1) < .001) continue;
        const { x1, y1, x2, y2, denominator, crop } = triangle;
        const a = (dx1 * y2 - dx2 * y1) / denominator;
        const b = (dy1 * y2 - dy2 * y1) / denominator;
        const c = (x1 * dx2 - x2 * dx1) / denominator;
        const d = (x1 * dy2 - x2 * dy1) / denominator;
        const e = p.targetX - a * p.x - c * p.y;
        const f = p.targetY - b * p.x - d * p.y;
        const cx = (p.targetX + q.targetX + r.targetX) / 3;
        const cy = (p.targetY + q.targetY + r.targetY) / 3;
        context.save();
        context.beginPath();
        // Slight overlap covers antialiased internal edges between triangles.
        for (const [index, vertex] of [p, q, r].entries()) {
          const vx = vertex.targetX - cx, vy = vertex.targetY - cy;
          const length = Math.max(.001, Math.hypot(vx, vy));
          const x = vertex.targetX + vx / length * .45;
          const y = vertex.targetY + vy / length * .45;
          if (index === 0) context.moveTo(x, y); else context.lineTo(x, y);
        }
        context.closePath(); context.clip();
        context.transform(a, b, c, d, e, f);
        context.drawImage(texture, ...crop, ...crop);
        context.restore();
      }
    }

    unproject(x, y) {
      for (const triangle of this.triangles) {
        const [a, b, c] = triangle.ids.map(index => this.points[index]);
        const denominator = (b.targetY - c.targetY) * (a.targetX - c.targetX) +
          (c.targetX - b.targetX) * (a.targetY - c.targetY);
        if (Math.abs(denominator) < .001) continue;
        const u = ((b.targetY - c.targetY) * (x - c.targetX) +
          (c.targetX - b.targetX) * (y - c.targetY)) / denominator;
        const v = ((c.targetY - a.targetY) * (x - c.targetX) +
          (a.targetX - c.targetX) * (y - c.targetY)) / denominator;
        const w = 1 - u - v;
        if (u >= -.001 && v >= -.001 && w >= -.001) {
          return { x: u * a.worldX + v * b.worldX + w * c.worldX,
            y: u * a.worldY + v * b.worldY + w * c.worldY };
        }
      }
      return null;
    }
  };
})();
