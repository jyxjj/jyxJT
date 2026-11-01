/**
 * 光栅消隐（深度图 + 采样）—— 用户选的 D 版观感
 *
 * 和解析法（hiddenLineAnalytic）互补：
 *   · 解析法几何上精确，但对"贴着表面的边"极度敏感，容差调不好会出现假遮挡
 *   · 光栅法容差宽，线条整体更"稳"，但采样误差会把可见边切成虚线碎点
 *
 * 这里在光栅法上补两件事，专门治"线条不清晰"：
 *   1. 提高默认分辨率（1400 → 2200）
 *   2. **合并碎段**：可见段之间如果只隔了很短的一段（小于几个采样步长），
 *      就接起来。虚线感基本都是这种微小缺口造成的。
 */

export function hiddenLineRaster(proj, opts = {}) {
  const { edges, tris } = proj;
  const res = opts.res || 2200;
  const nEdge = edges.uv.length / 4;
  const segVisible = new Array(nEdge).fill(null);
  const segHidden = new Array(nEdge).fill(null);
  if (!nEdge) return { segVisible, segHidden, stats: { edges: 0, tris: 0 } };

  // 没有实体面：全部可见
  if (!tris || !tris.uv || !tris.uv.length) {
    for (let i = 0; i < nEdge; i++) segVisible[i] = edges.uv.subarray(i * 4, i * 4 + 4);
    return { segVisible, segHidden, stats: { edges: nEdge, tris: 0 } };
  }

  // ---- 包围盒（边 + 三角），留 2% 余量 ----
  let minU = Infinity, minV = Infinity, maxU = -Infinity, maxV = -Infinity;
  let minD = Infinity, maxD = -Infinity;
  const scan = (uv, d) => {
    for (let i = 0; i < uv.length; i += 2) {
      if (uv[i] < minU) minU = uv[i];
      if (uv[i] > maxU) maxU = uv[i];
      if (uv[i + 1] < minV) minV = uv[i + 1];
      if (uv[i + 1] > maxV) maxV = uv[i + 1];
    }
    for (let i = 0; i < d.length; i++) {
      if (d[i] < minD) minD = d[i];
      if (d[i] > maxD) maxD = d[i];
    }
  };
  scan(edges.uv, edges.depth);
  scan(tris.uv, tris.depth);

  const padU = (maxU - minU) * 0.02 + 1e-9;
  const padV = (maxV - minV) * 0.02 + 1e-9;
  minU -= padU; maxU += padU; minV -= padV; maxV += padV;

  const spanU = maxU - minU;
  const spanV = maxV - minV;
  const scale = Math.max(spanU, spanV) > 0 ? (res - 1) / Math.max(spanU, spanV) : 1;
  const W = Math.max(2, Math.ceil(spanU * scale) + 1);
  const H = Math.max(2, Math.ceil(spanV * scale) + 1);
  const toX = (u) => (u - minU) * scale;
  const toY = (v) => (v - minV) * scale;

  // ---- 深度图：Infinity 表示没有面 ----
  const zbuf = new Float32Array(W * H).fill(Infinity);
  const nTri = tris.uv.length / 6;
  for (let t = 0; t < nTri; t++) {
    const x0 = toX(tris.uv[t * 6]), y0 = toY(tris.uv[t * 6 + 1]);
    const x1 = toX(tris.uv[t * 6 + 2]), y1 = toY(tris.uv[t * 6 + 3]);
    const x2 = toX(tris.uv[t * 6 + 4]), y2 = toY(tris.uv[t * 6 + 5]);
    const d0 = tris.depth[t * 3], d1 = tris.depth[t * 3 + 1], d2 = tris.depth[t * 3 + 2];

    const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
    if (Math.abs(area) < 1e-12) continue;
    const invArea = 1 / area;

    const bx0 = Math.max(0, Math.floor(Math.min(x0, x1, x2)));
    const bx1 = Math.min(W - 1, Math.ceil(Math.max(x0, x1, x2)));
    const by0 = Math.max(0, Math.floor(Math.min(y0, y1, y2)));
    const by1 = Math.min(H - 1, Math.ceil(Math.max(y0, y1, y2)));

    for (let py = by0; py <= by1; py++) {
      const cy = py + 0.5;
      const rowBase = py * W;
      for (let px = bx0; px <= bx1; px++) {
        const cx = px + 0.5;
        const w0 = ((x1 - cx) * (y2 - cy) - (x2 - cx) * (y1 - cy)) * invArea;
        const w1 = ((x2 - cx) * (y0 - cy) - (x0 - cx) * (y2 - cy)) * invArea;
        const w2 = 1 - w0 - w1;
        if (w0 < -1e-9 || w1 < -1e-9 || w2 < -1e-9) continue;
        const d = w0 * d0 + w1 * d1 + w2 * d2;
        const idx = rowBase + px;
        if (d < zbuf[idx]) zbuf[idx] = d;
      }
    }
  }

  // ---- 容差 ----
  const spanD = Math.max(maxD - minD, 1e-9);
  const eps = Math.max(spanD * (opts.depthTol || 3e-3), Math.max(spanU, spanV) * 5e-4, 1e-9);

  // 3×3 取最小 = 最近的遮挡面
  const sampleDepth = (px, py) => {
    const ix = Math.round(px), iy = Math.round(py);
    let best = Infinity;
    for (let dy = -1; dy <= 1; dy++) {
      const yy = iy + dy;
      if (yy < 0 || yy >= H) continue;
      const row = yy * W;
      for (let dx = -1; dx <= 1; dx++) {
        const xx = ix + dx;
        if (xx < 0 || xx >= W) continue;
        const d = zbuf[row + xx];
        if (d < best) best = d;
      }
    }
    return best;
  };

  const gapTol = opts.gapTol ?? 0.006;   // 允许接起来的缺口（占边长的比例）

  for (let i = 0; i < nEdge; i++) {
    const u0 = edges.uv[i * 4], v0 = edges.uv[i * 4 + 1];
    const u1 = edges.uv[i * 4 + 2], v1 = edges.uv[i * 4 + 3];
    const dA = edges.depth[i * 2], dB = edges.depth[i * 2 + 1];

    const ax = toX(u0), ay = toY(v0), bx = toX(u1), by = toY(v1);
    const lenPx = Math.hypot(bx - ax, by - ay);
    if (lenPx < 0.75) continue;                       // 短于一像素没有意义
    const steps = Math.min(800, Math.max(2, Math.ceil(lenPx * 1.6)));

    // 逐点判可见
    const vis = new Uint8Array(steps + 1);
    for (let s = 0; s <= steps; s++) {
      const tt = s / steps;
      const px = ax + (bx - ax) * tt;
      const py = ay + (by - ay) * tt;
      const dz = dA + (dB - dA) * tt;
      vis[s] = dz <= sampleDepth(px, py) + eps ? 1 : 0;
    }

    // 合并碎段：把短缺口补上，消掉虚线感
    const maxGap = Math.max(1, Math.round(steps * gapTol));
    let s = 0;
    while (s <= steps) {
      if (!vis[s]) { s++; continue; }
      // 找这一段的结尾
      let e = s;
      while (e < steps && vis[e + 1]) e++;
      // 往后看缺口，足够短就吞掉继续
      let probe = e + 1;
      let gap = 0;
      while (probe <= steps && !vis[probe] && gap < maxGap) { probe++; gap++; }
      if (probe <= steps && vis[probe] && gap < maxGap) {
        for (let k = e + 1; k < probe; k++) vis[k] = 1;
        continue;                                   // 重扫，接上下一段
      }
      // 记录这一段
      const t0 = s / steps, t1 = e / steps;
      if (t1 - t0 > 1e-6) {
        if (!segVisible[i]) segVisible[i] = [];
        segVisible[i].push(u0 + (u1 - u0) * t0, v0 + (v1 - v0) * t0,
                           u0 + (u1 - u0) * t1, v0 + (v1 - v0) * t1);
      }
      s = e + 1;
    }

    /*
     * 隐藏段 = 全长减去可见段（可见段的合并已经把短缺口吞了，
     * 所以隐藏段可能含小碎段；碎段过滤放到收集端做，避免这里把点线打散）。
     */
    if (segVisible[i]) {
      const vis = segVisible[i];
      const lenUv = Math.max(Math.hypot(u1 - u0, v1 - v0), 1e-12);
      const frac = (x, y) => Math.hypot(x - u0, y - v0) / lenUv;
      const hid = [];
      let cur = 0;
      for (let k = 0; k < vis.length; k += 4) {
        const a = frac(vis[k], vis[k + 1]);
        const b = frac(vis[k + 2], vis[k + 3]);
        if (a > cur + 1e-9) hid.push(cur, a);
        if (b > cur) cur = b;
      }
      if (cur < 1 - 1e-9) hid.push(cur, 1);
      for (let k = 0; k < hid.length; k += 2) {
        const a = hid[k], b = hid[k + 1];
        if (!segHidden[i]) segHidden[i] = [];
        segHidden[i].push(u0 + (u1 - u0) * a, v0 + (v1 - v0) * a,
                          u0 + (u1 - u0) * b, v0 + (v1 - v0) * b);
      }
    }
    if (segVisible[i]) segVisible[i] = Float32Array.from(segVisible[i]);
    if (segHidden[i]) segHidden[i] = Float32Array.from(segHidden[i]);
  }

  return { segVisible, segHidden, stats: { edges: nEdge, tris: nTri, res } };
}
