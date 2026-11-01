/**
 * 解析消隐（参考 NX 的做法）
 *
 * 原来那套是"把三角面光栅化成深度图，再用 3×3 采样去比深度"，问题：
 *   · 采样点与边的采样点不重合 → 贴着表面的可见边被判成遮挡，线条碎成虚线
 *   · 只能给出"这一点可见/不可见"，可见段被切成采样粒度的小段
 *   · 容差是全局的，装配体里深度跨度大时怎么调都不对
 *
 * NX 的做法是**解析求交**：把每条棱边投影成二维线段，和投影后的三角面做
 * 线段∩凸多边形，得到被遮挡的精确参数区间，再把区间从 [0,1] 里减掉。
 * 结果是精确的可见段，不存在采样误差。
 *
 * 这里用二维均匀网格加速：三角面按投影包围盒塞进格子，每条边只检查
 * 它经过的格子里的三角形。
 */

/** 把三角形塞进二维网格 */
function buildTriGrid(tris, cellSize, bounds) {
  const { minU, minV } = bounds;
  const nTri = tris.uv.length / 6;
  const cols = Math.max(1, Math.ceil((bounds.maxU - minU) / cellSize) + 1);
  const rows = Math.max(1, Math.ceil((bounds.maxV - minV) / cellSize) + 1);

  const counts = new Int32Array(cols * rows);
  const cellOf = (x, y) => {
    const cx = Math.min(cols - 1, Math.max(0, Math.floor((x - minU) / cellSize)));
    const cy = Math.min(rows - 1, Math.max(0, Math.floor((y - minV) / cellSize)));
    return cy * cols + cx;
  };

  // 先数每格多少三角形，再填，避免用数组套数组
  const triCells = new Int32Array(nTri * 2);
  for (let t = 0; t < nTri; t++) {
    const x0 = tris.uv[t * 6], y0 = tris.uv[t * 6 + 1];
    const x1 = tris.uv[t * 6 + 2], y1 = tris.uv[t * 6 + 3];
    const x2 = tris.uv[t * 6 + 4], y2 = tris.uv[t * 6 + 5];
    const lo = cellOf(Math.min(x0, x1, x2), Math.min(y0, y1, y2));
    const hi = cellOf(Math.max(x0, x1, x2), Math.max(y0, y1, y2));
    triCells[t * 2] = lo;
    triCells[t * 2 + 1] = hi;
    const c0 = lo % cols, c1 = hi % cols;
    const r0 = (lo / cols) | 0, r1 = (hi / cols) | 0;
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) counts[r * cols + c]++;
  }

  const start = new Int32Array(cols * rows + 1);
  for (let i = 0; i < counts.length; i++) start[i + 1] = start[i] + counts[i];
  const fill = start.slice(0, -1);
  const items = new Int32Array(start[counts.length]);

  for (let t = 0; t < nTri; t++) {
    const lo = triCells[t * 2], hi = triCells[t * 2 + 1];
    const c0 = lo % cols, c1 = hi % cols;
    const r0 = (lo / cols) | 0, r1 = (hi / cols) | 0;
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const k = r * cols + c;
        items[fill[k]++] = t;
      }
    }
  }
  return { cols, rows, start, items, cellOf };
}

/**
 * 一条线段被一个三角形遮挡的参数区间 [t0,t1]（无遮挡返回 null）
 *
 * 线段 P(t) = A + t·D，深度 d(t) = dA + t·dD（都是线性）。
 * 三角形在投影上是凸多边形，先求 2D 包含区间，再在区间内解 d(t) > dtri(t) + eps。
 */
function occludedInterval(ax, ay, dx, dy, dA, dD, tri, tris, eps) {
  const x0 = tris.uv[tri * 6], y0 = tris.uv[tri * 6 + 1];
  const x1 = tris.uv[tri * 6 + 2], y1 = tris.uv[tri * 6 + 3];
  const x2 = tris.uv[tri * 6 + 4], y2 = tris.uv[tri * 6 + 5];

  const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
  if (Math.abs(area) < 1e-14) return null;
  const sgn = area > 0 ? 1 : -1;

  // 三条边的半平面：sgn * cross(edge, P - v) >= 0 表示在内部
  let tEnter = 0, tExit = 1;
  const edges = [
    [x0, y0, x1, y1],
    [x1, y1, x2, y2],
    [x2, y2, x0, y0],
  ];
  for (const [ex0, ey0, ex1, ey1] of edges) {
    const nx = sgn * (ey1 - ey0) * -1;
    const ny = sgn * (ex1 - ex0);
    // 内部满足 nx*(px-ex0) + ny*(py-ey0) >= 0
    const c0 = nx * (ax - ex0) + ny * (ay - ey0);
    const c1 = nx * dx + ny * dy;
    if (Math.abs(c1) < 1e-14) {
      if (c0 < 0) return null;              // 平行且在外部
      continue;
    }
    const t = -c0 / c1;
    if (c1 > 0) { if (t > tEnter) tEnter = t; }      // 由外向内
    else { if (t < tExit) tExit = t; }               // 由内向外
    if (tEnter > tExit) return null;
  }
  if (tEnter >= tExit) return null;

  // 深度：三角形在 2D 上线性，所以 dtri(t) 也是 t 的一次函数
  const depthAt = (px, py) => {
    const w0 = ((x1 - px) * (y2 - py) - (x2 - px) * (y1 - py)) / area;
    const w1 = ((x2 - px) * (y0 - py) - (x0 - px) * (y2 - py)) / area;
    const w2 = 1 - w0 - w1;
    return w0 * tris.depth[tri * 3] + w1 * tris.depth[tri * 3 + 1] + w2 * tris.depth[tri * 3 + 2];
  };
  const px0 = ax + dx * tEnter, py0 = ay + dy * tEnter;
  const px1 = ax + dx * tExit, py1 = ay + dy * tExit;
  const dt0 = depthAt(px0, py0);
  const dt1 = depthAt(px1, py1);

  // 差函数 f(t) = d_edge(t) - dtri(t) - eps，线性；f > 0 即被遮挡
  const f0 = (dA + dD * tEnter) - dt0 - eps;
  const f1 = (dA + dD * tExit) - dt1 - eps;
  if (f0 <= 0 && f1 <= 0) return null;

  let a = tEnter, b = tExit;
  if (f0 <= 0 || f1 <= 0) {
    const t = tEnter + (tExit - tEnter) * (f0 / (f0 - f1));
    if (f0 <= 0) a = t; else b = t;
  }
  if (b - a < 1e-9) return null;
  return [a, b];
}

/** 从 [0,1] 里减掉一堆区间，返回剩下的可见区间 */
function subtractIntervals(occluded) {
  if (!occluded.length) return [[0, 1]];
  occluded.sort((p, q) => p[0] - q[0]);
  const out = [];
  let cur = 0;
  for (const [a, b] of occluded) {
    if (a > cur) out.push([cur, Math.min(a, 1)]);
    if (b > cur) cur = b;
    if (cur >= 1) break;
  }
  if (cur < 1) out.push([cur, 1]);
  return out.filter(([a, b]) => b - a > 1e-6);
}

/**
 * 解析消隐主函数。
 * @returns {{segVisible: Array<Float32Array|null>, segHidden: Array<Float32Array|null>, stats: object}}
 *   segHidden[i] = 第 i 条边被遮挡的部分（与 segVisible 互补），供"隐藏边画点线"用
 */
export function hiddenLineAnalytic(proj, opts = {}) {
  const { edges, tris } = proj;
  const nEdge = edges.uv.length / 4;
  const segVisible = new Array(nEdge).fill(null);
  const segHidden = new Array(nEdge).fill(null);
  const stats = { edges: nEdge, tris: tris.uv.length / 6, tests: 0, visibleRuns: 0 };

  if (!nEdge) return { segVisible, segHidden, stats };
  if (!tris.uv.length) {
    for (let i = 0; i < nEdge; i++) segVisible[i] = edges.uv.subarray(i * 4, i * 4 + 4);
    return { segVisible, segHidden, stats };
  }

  // ---- 包围盒 ----
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

  const spanU = Math.max(maxU - minU, 1e-9);
  const spanV = Math.max(maxV - minV, 1e-9);
  const span = Math.max(spanU, spanV);

  // 网格大小：按三角形平均尺寸来，太大候选多，太小建表慢
  const nTri = tris.uv.length / 6;
  let sumExtent = 0;
  for (let t = 0; t < nTri; t++) {
    const x0 = tris.uv[t * 6], y0 = tris.uv[t * 6 + 1];
    const x1 = tris.uv[t * 6 + 2], y1 = tris.uv[t * 6 + 3];
    const x2 = tris.uv[t * 6 + 4], y2 = tris.uv[t * 6 + 5];
    sumExtent += Math.max(
      Math.max(x0, x1, x2) - Math.min(x0, x1, x2),
      Math.max(y0, y1, y2) - Math.min(y0, y1, y2));
  }
  const avg = sumExtent / Math.max(nTri, 1);
  const cellSize = Math.max(avg * 2, span / 256, 1e-9);

  const grid = buildTriGrid(tris, cellSize, { minU, minV, maxU, maxV });

  /*
   * 深度容差：只用来吸收"共面边 vs 共面三角"的浮点误差。
   * 因为不再有光栅采样，这里的容差可以比原来小两个数量级。
   */
  const spanD = Math.max(maxD - minD, 1e-12);
  const eps = Math.max(spanD * 5e-4, span * 1e-5, 1e-9);

  const stamp = new Int32Array(nTri).fill(-1);
  const cand = [];

  /*
   * 每个三角形"最近的那个深度"（值越小越靠前）。
   * 如果它比整条边的最远深度还靠后，这个三角形永远挡不住这条边 —— 直接跳过。
   * 装配体里大量三角形在很后面，这个剔除很有效。
   */
  const triNear = new Float32Array(nTri);
  for (let t = 0; t < nTri; t++) {
    const a = tris.depth[t * 3], b = tris.depth[t * 3 + 1], c = tris.depth[t * 3 + 2];
    triNear[t] = Math.min(a, b, c);
  }
  const cellW = cellSize;
  const originU = minU, originV = minV;

  /** 沿线段走过的格子（Amanatides-Woo），比取包围盒矩形少很多候选 */
  const walkCells = (ax, ay, bx, by, visit) => {
    let cx = Math.min(grid.cols - 1, Math.max(0, Math.floor((ax - originU) / cellW)));
    let cy = Math.min(grid.rows - 1, Math.max(0, Math.floor((ay - originV) / cellW)));
    const ex = Math.min(grid.cols - 1, Math.max(0, Math.floor((bx - originU) / cellW)));
    const ey = Math.min(grid.rows - 1, Math.max(0, Math.floor((by - originV) / cellW)));

    const dx = bx - ax, dy = by - ay;
    const stepX = dx > 0 ? 1 : -1, stepY = dy > 0 ? 1 : -1;
    const invDx = dx !== 0 ? 1 / Math.abs(dx) : Infinity;
    const invDy = dy !== 0 ? 1 / Math.abs(dy) : Infinity;
    let tMaxX = dx !== 0
      ? ((dx > 0 ? (originU + (cx + 1) * cellW) - ax : ax - (originU + cx * cellW)) * invDx)
      : Infinity;
    let tMaxY = dy !== 0
      ? ((dy > 0 ? (originV + (cy + 1) * cellW) - ay : ay - (originV + cy * cellW)) * invDy)
      : Infinity;
    const tDeltaX = invDx * cellW;
    const tDeltaY = invDy * cellW;

    let guard = 0;
    for (;;) {
      visit(cy * grid.cols + cx);
      if (cx === ex && cy === ey) break;
      if (++guard > grid.cols + grid.rows + 8) break;
      if (tMaxX < tMaxY) { cx += stepX; tMaxX += tDeltaX; }
      else { cy += stepY; tMaxY += tDeltaY; }
      if (cx < 0 || cx >= grid.cols || cy < 0 || cy >= grid.rows) break;
    }
  };

  for (let i = 0; i < nEdge; i++) {
    const ax = edges.uv[i * 4], ay = edges.uv[i * 4 + 1];
    const bx = edges.uv[i * 4 + 2], by = edges.uv[i * 4 + 3];
    const dA = edges.depth[i * 2], dB = edges.depth[i * 2 + 1];
    const dx = bx - ax, dy = by - ay, dD = dB - dA;

    // 收集边经过的格子里的三角形
    cand.length = 0;
    walkCells(ax, ay, bx, by, (k) => {
      for (let s = grid.start[k]; s < grid.start[k + 1]; s++) {
        const t = grid.items[s];
        if (stamp[t] === i) continue;
        stamp[t] = i;
        cand.push(t);
      }
    });

    // 求遮挡区间（先用深度范围剔掉不可能挡住的三角形）
    const edgeFar = Math.max(dA, dB) + eps;
    const occ = [];
    for (const t of cand) {
      if (triNear[t] > edgeFar) continue;
      stats.tests++;
      const iv = occludedInterval(ax, ay, dx, dy, dA, dD, t, tris, eps);
      if (iv) occ.push(iv);
    }

    const vis = subtractIntervals(occ);
    const hid = vis.length ? subtractIntervals(vis) : [[0, 1]];

    // 拼成可见段
    const out = [];
    for (const [a, b] of vis) {
      const x0 = ax + dx * a, y0 = ay + dy * a;
      const x1 = ax + dx * b, y1 = ay + dy * b;
      if (Math.hypot(x1 - x0, y1 - y0) < 1e-9) continue;
      out.push(x0, y0, x1, y1);
    }
    if (out.length) {
      segVisible[i] = Float32Array.from(out);
      stats.visibleRuns += out.length / 4;
    }

    // 拼成隐藏段（专业 CAD 图纸的"虚线/点线"素材）
    const hout = [];
    for (const [a, b] of hid) {
      const x0 = ax + dx * a, y0 = ay + dy * a;
      const x1 = ax + dx * b, y1 = ay + dy * b;
      if (Math.hypot(x1 - x0, y1 - y0) < 1e-9) continue;
      hout.push(x0, y0, x1, y1);
    }
    if (hout.length) segHidden[i] = Float32Array.from(hout);
  }

  return { segVisible, segHidden, stats };
}
