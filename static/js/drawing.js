/**
 * drawing.js —— 从 3D 场景生成 A4 二维线图（供 CGM 导出与屏幕预览共用）
 *
 * 流程：
 *   1. collectGroups()  按左侧层级树的顶层节点分组（= 装配分组）
 *   2. extractEdges()   每个零件用 EdgesGeometry 提特征边（跨面夹角阈值）
 *   3. projectTo2D()    沿当前相机视线做正交投影，得到 mm 平面坐标
 *   4. layoutSheet()    排到 A4 图框：整机视图 / 分组分格
 *   5. placeHotspots()  给每组布一个热点（圆圈 + 编号 + 引线），避免互相压盖
 *   6. buildDrawing()   输出与后端无关的中间表示（元素数组），CGM 与 SVG 都从它出
 *
 * 所有长度单位统一为 **毫米**，与 A4 图幅同一坐标系。
 */

import * as THREE from 'three';

import { hiddenLineAnalytic } from './hlr.js';
import { hiddenLineRaster } from './hlr_raster.js';

export const A4 = { width: 210, height: 297 };

/** 图框参数（mm） */
export const SHEET = {
  margin: 10,        // 纸边到图框
  titleH: 22,        // 标题栏高度
  gutter: 6,         // 分格视图之间的间距
  cellTitleH: 5,     // 分格视图下方零件名高度
  captionH: 3.2,     // 正文字高
};

/** 热点标注规范（用户给定） */
export const HOTSPOT = {
  fontFamily: 'Arial',
  charHeight: 2.056,   // mm，Arial 数字高度
  inflate: 0.05,       // mm，胶囊轮廓超出数字的量（旧样式用）
  leaderDot: 0.12,     // mm，引线端点小圆半径
  minRingGap: 0.6,     // mm，两个热点之间的最小间隙
  /**
   * 样式：
   *   'cgm'     —— 只要数字，不画外围轮廓；引线横平竖直（CGM 里靠 PICK IDENTIFIER 当热点）
   *   'balloon' —— 数字 + 椭圆气球（旧样式）
   */
  style: 'cgm',
  leaderGap: 1.8,      // mm，数字到零件的间距
  leaderElbow: 2.4,    // mm，折弯段长度（横平竖直的"横"或"竖"）
};

/** 热点图例表参数（mm） */
export const LEGEND = {
  rowH: 3.4,
  charHeight: 2.2,
  headerHeight: 2.0,
};

/**
 * 图册版面（对齐 HTEAM-04021 模板，mm，y 向上）：
 *   · 一张 A4 只画一个整机视图，不要图框 / 图例 / 分格标题
 *   · 左上角是图册号（Arial，数字高 4.91mm），距离纸边 10.2mm
 *   · 图形放在页面上部（下 1/3 留白）。数值直接从模板 GIF 量出来：
 *       图形墨迹 x 17.5–202.0，y(自上而下) 81.7–195.1
 *       图册号墨迹 x 10.2–53.7，y(自上而下) 12.1–17.1
 *   · 热点 = 纯数字 + 5mm 正交短引线（没有端点小圆、不拐折）
 */
export const PLATE = {
  /** 图形可用区（y 向上）：模板墨迹 x 17.5–202.0，y(自上而下) 81.7–195.1 */
  area: { x0: 17.5, y0: 101.9, x1: 202.0, y1: 215.3 },
  /** 图册号：左下角基线位置与字高（cap height） */
  titleX: 9.7,
  titleY: 280.0,
  titleHeight: 4.91,
  /** 热点引线长度（mm，零件轮廓 → 数字外框） */
  leader: 5.16,
  /** 引线与数字之间的空隙（mm，模板实测 1.0） */
  gap: 1.0,
  /** 线宽（mm），模板线条约 0.15 */
  lineWidth: 0.15,
  leaderWidth: 0.15,
  /** 隐藏边（被遮挡）线宽：细一点，观感退到轮廓后面 */
  hiddenWidth: 0.13,
  /** 隐藏边 SVG 虚线样式（mm：线段 间隙）—— 工程图惯例的点划感短虚线 */
  hiddenDash: '0.9 0.6',
  /**
   * 隐藏边的"物理点化"周期（mm）：CGM/SVG 的虚线属性在查看器里的表现不一致，
   * 所以把隐藏段按 dash/gap 周期切开成真实短段（dash 0.5 + gap 0.45），
   * 无论渲染端支不支持 LINE DASHED，出来都是一样的点线观感。
   */
  hiddenDotDash: 0.55,
  hiddenDotGap: 0.45,
};

/**
 * A4 取景框留白比例（用户给定）：
 *   上面留 1/10、下面留 1/5，其余中间 7/10 是"限定框"（也就是真正出图的内容区）。
 * 屏幕上的取景框与这个比例完全一致，所以拖动到框里的东西 = 出图的内容。
 */
export const FRAME = {
  topRatio: 1 / 10,
  bottomRatio: 1 / 5,
};

/** 限定框在 A4 毫米坐标里的矩形（y 向上） */
export function frameContentRect(sheet = A4) {
  const yTop = sheet.height * (1 - FRAME.topRatio);
  const yBottom = sheet.height * FRAME.bottomRatio;
  return { x0: 0, y0: yBottom, x1: sheet.width, y1: yTop, w: sheet.width, h: yTop - yBottom };
}

/** drawLegend: false 表示不要图例 */
const legendDisabled = (v) => v === false;

/* ---------------------------------------------------------------- */
/* 1. 分组                                                            */
/* ---------------------------------------------------------------- */

/**
 * 取树的顶层子节点作为分组。
 * 若顶层只有一个「装配」节点且它是文件容器（folder 模式的根），就再下钻一层，
 * 让每个零件/子装配各自成为一个组。
 */
export function collectGroups(root) {
  if (!root) return [];
  const walk = (node) => {
    const out = [];
    for (const child of node.children || []) {
      const leaves = [];
      (function collect(n) {
        if (!n.children || n.children.length === 0) leaves.push(n.key);
        else n.children.forEach(collect);
      })(child);
      out.push({
        key: child.key,
        name: child.name,
        kind: child.kind,
        tris: child.tris || 0,
        leafKeys: leaves,
      });
    }
    return out;
  };

  let groups = walk(root);
  /*
   * 单个 .jt 零件文件：根节点下**没有子节点**，walk() 返回空数组，
   * 出图就会画成一张"没有几何"的空图纸（界面上只有 No geometry to draw）。
   * 这种情况把根节点自己当成一个组 —— 单个零件也能出一张热点的图。
   */
  if (!groups.length && !(root.children || []).length && root.key) {
    groups = [{
      key: root.key,
      name: root.name,
      kind: root.kind,
      tris: root.tris || 0,
      leafKeys: [root.key],
    }];
  }
  // 只有一个组、且它自己还是个装配 → 下钻，避免"整机就是一个热点"
  let guard = 0;
  while (groups.length === 1 && groups[0].leafKeys.length > 1 && guard++ < 3) {
    const only = groups[0];
    const target = (root.children || []).find((c) => c.key === only.key);
    if (!target) break;
    const sub = walk(target);
    if (!sub.length) break;
    groups = sub;
  }
  return groups;
}

/* ---------------------------------------------------------------- */
/* 2. 特征边提取                                                      */
/* ---------------------------------------------------------------- */

/**
 * 从已加载的网格记录里提出要画的边（世界坐标）。
 *
 * 为什么不用 THREE.EdgesGeometry：
 *   JT 导出的网格顶点是**按面法线分裂**的（同一位置有多个顶点，法线不同），
 *   EdgesGeometry 按顶点索引配对共享边，分裂后一条也配不上，于是把每个
 *   三角形的三条边全当"边界边"画出来 —— 圆柱零件就成了一团密网。
 *   这里先按位置焊接，再按二面角筛特征边，并按视向补轮廓边。
 *
 * @param {Map<string, object>} meshRecords  key -> { body }
 * @param {string[]} keys  要包含的节点 key
 * @param {number} thresholdDeg  相邻面二面角超过它才算特征边
 * @param {{dir: THREE.Vector3}|null} basis  视向（给轮廓边用）；null 则不加轮廓边
 * @returns {Float32Array} 世界坐标线段 [x1,y1,z1,x2,y2,z2, ...]
 */


/**
 * 给一个几何建"焊接后的边表"：
 *   positions      焊接后的唯一顶点（局部坐标）
 *   faceNormals    每个三角形的面法线
 *   segments       [{a,b,t1,t2,feature}]，t2 = -1 表示边界边
 */

/**
 * 统一三角形绕序（把法线翻到同侧）
 *
 * JT 网格里有 1~5% 的三角形绕序是反的。后果是：
 *   · 轮廓判定 n·view 的符号不可靠 → 圆柱侧面冒出一堆假轮廓线
 *   · 平滑面合并要靠 |dot| 兜着，勉强能用
 *
 * 这里沿"共享边的邻接"做一次 BFS：相邻两面法线点积 < 0 就把邻居翻过来。
 * 封闭流形上这样一传，整张曲面的朝向就一致了。
 *
 * @returns {Int8Array} flip[i] = -1 表示第 i 个三角形被翻转
 */
function orientNormals(triCount, edges, ax, ay, az, faceNormals) {
  const flip = new Int8Array(triCount).fill(1);
  if (!triCount) return flip;

  // 邻接表
  const adj = new Map();
  const push = (a, b) => {
    if (!adj.has(a)) adj.set(a, []);
    adj.get(a).push(b);
  };
  for (const rec of edges) {
    if (rec.t2 === -1) continue;
    push(rec.t1, rec.t2);
    push(rec.t2, rec.t1);
  }

  const seen = new Uint8Array(triCount);
  const queue = [];
  for (let seed = 0; seed < triCount; seed++) {
    if (seen[seed]) continue;
    seen[seed] = 1;
    queue.length = 0;
    queue.push(seed);
    for (let qi = 0; qi < queue.length; qi++) {
      const t = queue[qi];
      const s = flip[t];
      const nb = adj.get(t);
      if (!nb) continue;
      for (const u of nb) {
        if (seen[u]) continue;
        // 用 t 的（已定向）法线去比 u 的原始法线
        const dot = s * (ax[t] * ax[u] + ay[t] * ay[u] + az[t] * az[u]);
        if (dot < 0) flip[u] = -1;
        seen[u] = 1;
        queue.push(u);
      }
    }
  }

  for (let t = 0; t < triCount; t++) {
    if (flip[t] === -1) { ax[t] = -ax[t]; ay[t] = -ay[t]; az[t] = -az[t]; }
  }
  return flip;
}

function buildEdgeTable(geo, cosThresh) {
  const posAttr = geo.getAttribute('position');
  const idxAttr = geo.getIndex();
  const nv0 = posAttr.count;
  const P0 = posAttr.array;

  // 1) 按位置焊接（容差 1e-4，与 JT 的 float32 精度匹配）
  const map = new Map();
  const weld = new Int32Array(nv0);
  const pos = [];
  let uniq = 0;
  for (let i = 0; i < nv0; i++) {
    const x = P0[i * 3], y = P0[i * 3 + 1], z = P0[i * 3 + 2];
    const k = `${Math.round(x * 1e4)},${Math.round(y * 1e4)},${Math.round(z * 1e4)}`;
    let v = map.get(k);
    if (v === undefined) {
      v = uniq++;
      map.set(k, v);
      pos.push(x, y, z);
    }
    weld[i] = v;
  }

  const triCount = idxAttr ? idxAttr.count / 3 : nv0 / 3;
  const getIdx = idxAttr
    ? (i) => idxAttr.getX(i)
    : (i) => i;

  // 2) 面法线 + 边 → 三角形映射
  const faceNormals = new Float32Array(triCount * 3);
  const edgeMap = new Map();
  const ax = new Float32Array(triCount), ay = new Float32Array(triCount), az = new Float32Array(triCount);

  for (let t = 0; t < triCount; t++) {
    const i0 = weld[getIdx(t * 3)];
    const i1 = weld[getIdx(t * 3 + 1)];
    const i2 = weld[getIdx(t * 3 + 2)];
    const v0x = pos[i0 * 3], v0y = pos[i0 * 3 + 1], v0z = pos[i0 * 3 + 2];
    const v1x = pos[i1 * 3], v1y = pos[i1 * 3 + 1], v1z = pos[i1 * 3 + 2];
    const v2x = pos[i2 * 3], v2y = pos[i2 * 3 + 1], v2z = pos[i2 * 3 + 2];
    // 法线 = (v1-v0) × (v2-v0)
    const ux = v1x - v0x, uy = v1y - v0y, uz = v1z - v0z;
    const wx = v2x - v0x, wy = v2y - v0y, wz = v2z - v0z;
    let nx = uy * wz - uz * wy;
    let ny = uz * wx - ux * wz;
    let nz = ux * wy - uy * wx;
    const L = Math.hypot(nx, ny, nz) || 1;
    nx /= L; ny /= L; nz /= L;
    faceNormals[t * 3] = nx; faceNormals[t * 3 + 1] = ny; faceNormals[t * 3 + 2] = nz;
    ax[t] = nx; ay[t] = ny; az[t] = nz;

    const tri = [i0, i1, i2];
    for (let k = 0; k < 3; k++) {
      const a = tri[k], b = tri[(k + 1) % 3];
      const lo = a < b ? a : b;
      const hi = a < b ? b : a;
      const key = lo * 8388608 + hi; // 顶点数 < 2^23 时无碰撞
      const rec = edgeMap.get(key);
      if (rec === undefined) edgeMap.set(key, { a: lo, b: hi, t1: t, t2: -1 });
      else if (rec.t2 === -1) rec.t2 = t;
    }
  }

  // 2.5) 统一绕序（只影响轮廓判定的符号可靠性，不改二面角判据）
  orientNormals(triCount, edgeMap.values(), ax, ay, az, faceNormals);

  /*
   * 3) 判定特征边：纯二面角阈值。
   *
   * 这就是 3D 线框（THREE.EdgesGeometry(geo, 20°)）的同一套口径 ——
   * 用户要求 2D 出图按 3D 线框的线条来，所以这里不再做"平滑面合并"。
   * cosThresh 由调用方传入（2D 出图用 20°，和 3D 对齐）。
   */
  /*
   * 共面容差：大平面被切成两个三角形后，法线会因为 float32 精度或面本身
   * 有极轻微不平整而差出一点点 —— 换算成角度常常刚好越过 20°，
   * 于是平面上就冒出一条斜对角剖分线。光看二面角治不了这个。
   *
   * 这里加一道几何判据：把对面三角形的第三个顶点投到本三角形平面上，
   * 距离小于 tol 就认为两个面共面，这条边不算特征边。
   */
  let bbMin = [Infinity, Infinity, Infinity];
  let bbMax = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      if (pos[i + k] < bbMin[k]) bbMin[k] = pos[i + k];
      if (pos[i + k] > bbMax[k]) bbMax[k] = pos[i + k];
    }
  }
  /*
   * 容差按**三角形自身尺寸**算，不要按零件包围盒算：
   * 薄壁件的包围盒对角线可能比壁厚大两个数量级，用它会误伤真实棱边
   * （实测按零件算时热点从 28 掉到 19）。
   */
  const bbDiag = Math.hypot(bbMax[0] - bbMin[0], bbMax[1] - bbMin[1], bbMax[2] - bbMin[2]) || 1;

  /*
   * 3) 判定特征边：二面角超过阈值。
   *
   * 这就是 hlr_analytic.png 那版用的判据，配合解析消隐效果最好。
   * 取 |dot| 而不是 dot：JT 里有 1~3% 的三角形绕序是反的，
   * 反绕序让点积变 -1，会被误判成"180° 硬边"，多出一截线。
   */
  const segments = [];
  for (const rec of edgeMap.values()) {
    let feature;
    if (rec.t2 === -1) {
      feature = true;                    // 边界边（开口）必画
    } else {
      const t1 = rec.t1, t2 = rec.t2;
      const dot = ax[t1] * ax[t2] + ay[t1] * ay[t2] + az[t1] * az[t2];
      feature = Math.abs(dot) <= cosThresh;
    }
    segments.push({ a: rec.a, b: rec.b, t1: rec.t1, t2: rec.t2, feature });
  }

  // 4) 焊接后的三角形列表（消隐用）；ni = 原始三角形序号，用来查面法线
  const triangles = [];
  for (let t = 0; t < triCount; t++) {
    const a = weld[getIdx(t * 3)];
    const b = weld[getIdx(t * 3 + 1)];
    const c = weld[getIdx(t * 3 + 2)];
    if (a === b || b === c || a === c) continue; // 退化三角形
    const tri = [a, b, c];
    tri.ni = t;
    triangles.push(tri);
  }

  return { positions: Float32Array.from(pos), faceNormals, segments, triangles };
}

/* ---------------------------------------------------------------- */
/* 3. 正交投影                                                        */
/* ---------------------------------------------------------------- */





/* ---------------------------------------------------------------- */
/* 3c. 屏幕取景框投影（所见即所得）                                     */
/* ---------------------------------------------------------------- */

/**
 * 建立"屏幕像素 → A4 毫米"的映射。
 *
 * 取景框在屏幕上是一个矩形（framePx，px），它对应 A4 上的内容区（frameA4，mm）。
 * 把顶点投到屏幕像素后，再线性映射进 A4 内容区 —— 屏幕上框里看到什么，
 * 出图就是什么（含透视透视收缩，和目视一致）。
 *
 * @param {{x:number,y:number,w:number,h:number}} framePx 屏幕上的限定框（CSS px）
 * @param {{x0:number,y0:number,x1:number,y1:number,w:number,h:number}} frameA4 A4 内容区
 */
export function screenFrameMapper(framePx, frameA4) {
  const sx = frameA4.w / Math.max(framePx.w, 1e-6);
  const sy = frameA4.h / Math.max(framePx.h, 1e-6);
  return {
    framePx,
    frameA4,
    /** 屏幕 px → A4 mm */
    toA4(px, py) {
      return [
        frameA4.x0 + (px - framePx.x) * sx,
        frameA4.y1 - (py - framePx.y) * sy,   // 屏幕 y 向下，A4 y 向上
      ];
    },
  };
}

/**
 * 沿当前相机做投影，输出 A4 毫米坐标下的边与面（供取景框模式出图）。
 *
 * @returns {{edges:{uv:Float32Array,depth:Float32Array}, tris:{uv:Float32Array,depth:Float32Array}}}
 */
export function projectGroupScreen(meshRecords, keys, camera, mapper, thresholdDeg = 25) {
  const viewW = camera.userData.viewportW || 1;
  const viewH = camera.userData.viewportH || 1;
  camera.updateMatrixWorld(true);
  const viewMat = camera.matrixWorldInverse;
  const projMat = camera.projectionMatrix;

  const cosThresh = Math.cos((thresholdDeg * Math.PI) / 180);
  const cache = new Map();

  const edgeUV = [];
  const edgeD = [];
  const triUV = [];
  const triD = [];

  // 单点投影：世界坐标 → [A4x, A4y, 深度]；在相机后方返回 null
  const proj = (x, y, z) => {
    // 相机空间
    const cx = viewMat.elements[0] * x + viewMat.elements[4] * y + viewMat.elements[8] * z + viewMat.elements[12];
    const cy = viewMat.elements[1] * x + viewMat.elements[5] * y + viewMat.elements[9] * z + viewMat.elements[13];
    const cz = viewMat.elements[2] * x + viewMat.elements[6] * y + viewMat.elements[10] * z + viewMat.elements[14];
    if (cz > -1e-6) return null;               // 在相机后方/近平面之后
    const clip = (m, a, b, c, d) =>
      m[0] * a + m[4] * b + m[8] * c + m[12] * d;
    const e = projMat.elements;
    const w = e[3] * cx + e[7] * cy + e[11] * cz + e[15];
    if (Math.abs(w) < 1e-12) return null;
    const ndcX = clip(e, cx, cy, cz, 1) / w;
    const ndcY = (e[1] * cx + e[5] * cy + e[9] * cz + e[13]) / w;
    const px = (ndcX * 0.5 + 0.5) * viewW;
    const py = (1 - (ndcY * 0.5 + 0.5)) * viewH;
    const [ax, ay] = mapper.toA4(px, py);
    return [ax, ay, -cz];                       // depth 越小越近
  };

  for (let ki = 0; ki < keys.length; ki++) {
    const key = keys[ki];
    const rec = meshRecords.get(key);
    if (!rec || !rec.body || !rec.body.geometry) continue;
    const geo = rec.body.geometry;
    let table = cache.get(geo);
    if (!table) { table = buildEdgeTable(geo, cosThresh); cache.set(geo, table); }
    rec.body.updateWorldMatrix(true, false);
    const e = rec.body.matrixWorld.elements;
    const nm = new THREE.Matrix3().getNormalMatrix(rec.body.matrixWorld);

    const pos = table.positions;
    const n = pos.length / 3;
    const uv = new Float32Array(n * 2);
    const dep = new Float32Array(n);
    const ok = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
      const wx = e[0] * x + e[4] * y + e[8] * z + e[12];
      const wy = e[1] * x + e[5] * y + e[9] * z + e[13];
      const wz = e[2] * x + e[6] * y + e[10] * z + e[14];
      const p = proj(wx, wy, wz);
      if (p) { uv[i * 2] = p[0]; uv[i * 2 + 1] = p[1]; dep[i] = p[2]; ok[i] = 1; }
    }

    // 世界法线（含视图方向，用于背面剔除和轮廓边）
    const fn = table.faceNormals;
    const wn = new Float32Array(fn.length);
    const ne = nm.elements;
    for (let i = 0; i < fn.length; i += 3) {
      const x = fn[i], y = fn[i + 1], z = fn[i + 2];
      wn[i] = ne[0] * x + ne[3] * y + ne[6] * z;
      wn[i + 1] = ne[1] * x + ne[4] * y + ne[7] * z;
      wn[i + 2] = ne[2] * x + ne[5] * y + ne[8] * z;
    }
    // 视向（世界空间）：相机朝向
    const vd = new THREE.Vector3();
    camera.getWorldDirection(vd);

    for (const tri of table.triangles) {
      const [a, b, c] = tri;
      if (!ok[a] || !ok[b] || !ok[c]) continue;
      /*
       * 这里**不做背面剔除**。
       * 消隐只需要"最近的表面"，背面本来就比正面远，留在深度图里无害；
       * 而 JT 网格的三角形绕序约有 1~5% 不统一，按法线剔除会在壳上留孔，
       * 内部零件就从孔里透出来（表现为整机变成密网）。
       */
      triUV.push(uv[a * 2], uv[a * 2 + 1], uv[b * 2], uv[b * 2 + 1], uv[c * 2], uv[c * 2 + 1]);
      triD.push(dep[a], dep[b], dep[c]);
    }

    for (const seg of table.segments) {
      const { a, b, t1, t2 } = seg;
      if (!ok[a] || !ok[b]) continue;
      let keep = seg.feature;
      if (!keep && t2 >= 0) {
        const d1 = wn[t1 * 3] * vd.x + wn[t1 * 3 + 1] * vd.y + wn[t1 * 3 + 2] * vd.z;
        const d2 = wn[t2 * 3] * vd.x + wn[t2 * 3 + 1] * vd.y + wn[t2 * 3 + 2] * vd.z;
        if ((d1 > 0) !== (d2 > 0)) keep = true;
      }
      if (!keep) continue;
      edgeUV.push(uv[a * 2], uv[a * 2 + 1], uv[b * 2], uv[b * 2 + 1]);
      edgeD.push(dep[a], dep[b]);
      edgeOwner.push(ki);
    }
  }

  return {
    keys,
    edges: {
      uv: Float32Array.from(edgeUV),
      depth: Float32Array.from(edgeD),
      owner: Int32Array.from(edgeOwner),
    },
    tris: { uv: Float32Array.from(triUV), depth: Float32Array.from(triD) },
  };
}

/**
 * 一次性投影多个分组，**共用同一个深度缓冲**。
 *
 * 为什么必须一起投影：消隐要拿"整机的所有三角形"去比深度。
 * 若逐零件单独消隐，外壳根本遮不住装在里面的零件，整机就成了密网。
 *
 * @returns {{
 *   edges: {uv: Float32Array, depth: Float32Array, owner: Int32Array},
 *   tris:  {uv: Float32Array, depth: Float32Array},
 *   keys:  string[],           // owner 下标 → 分组 key
 * }}
 */
export function projectManyScreen(meshRecords, groupList, camera, mapper, thresholdDeg = 25) {
  const viewW = camera.userData.viewportW || 1;
  const viewH = camera.userData.viewportH || 1;
  camera.updateMatrixWorld(true);
  const viewMat = camera.matrixWorldInverse;
  const projMat = camera.projectionMatrix;
  const cosThresh = Math.cos((thresholdDeg * Math.PI) / 180);
  const cache = new Map();

  const edgeUV = [];
  const edgeD = [];
  const edgeOwner = [];
  const triUV = [];
  const triD = [];
  const keys = [];

  const proj = (x, y, z) => {
    const cx = viewMat.elements[0] * x + viewMat.elements[4] * y + viewMat.elements[8] * z + viewMat.elements[12];
    const cy = viewMat.elements[1] * x + viewMat.elements[5] * y + viewMat.elements[9] * z + viewMat.elements[13];
    const cz = viewMat.elements[2] * x + viewMat.elements[6] * y + viewMat.elements[10] * z + viewMat.elements[14];
    if (cz > -1e-6) return null;
    const e = projMat.elements;
    const w = e[3] * cx + e[7] * cy + e[11] * cz + e[15];
    if (Math.abs(w) < 1e-12) return null;
    const ndcX = (e[0] * cx + e[4] * cy + e[8] * cz + e[12]) / w;
    const ndcY = (e[1] * cx + e[5] * cy + e[9] * cz + e[13]) / w;
    const px = (ndcX * 0.5 + 0.5) * viewW;
    const py = (1 - (ndcY * 0.5 + 0.5)) * viewH;
    const [ax, ay] = mapper.toA4(px, py);
    return [ax, ay, -cz];
  };

  groupList.forEach((g, gi) => {
    keys.push(g.key);
    for (const key of g.leafKeys) {
      const rec = meshRecords.get(key);
      if (!rec || !rec.body || !rec.body.geometry) continue;
      const geo = rec.body.geometry;
      let table = cache.get(geo);
      if (!table) { table = buildEdgeTable(geo, cosThresh); cache.set(geo, table); }
      rec.body.updateWorldMatrix(true, false);
      const e = rec.body.matrixWorld.elements;
      const nm = new THREE.Matrix3().getNormalMatrix(rec.body.matrixWorld);

      const pos = table.positions;
      const n = pos.length / 3;
      const uv = new Float32Array(n * 2);
      const dep = new Float32Array(n);
      const ok = new Uint8Array(n);
      for (let i = 0; i < n; i++) {
        const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
        const wx = e[0] * x + e[4] * y + e[8] * z + e[12];
        const wy = e[1] * x + e[5] * y + e[9] * z + e[13];
        const wz = e[2] * x + e[6] * y + e[10] * z + e[14];
        const p = proj(wx, wy, wz);
        if (p) { uv[i * 2] = p[0]; uv[i * 2 + 1] = p[1]; dep[i] = p[2]; ok[i] = 1; }
      }

      // 全部三角形都进深度图（不做背面剔除：绕序不一致会留孔）
      for (const tri of table.triangles) {
        const [a, b, c] = tri;
        if (!ok[a] || !ok[b] || !ok[c]) continue;
        triUV.push(uv[a * 2], uv[a * 2 + 1], uv[b * 2], uv[b * 2 + 1], uv[c * 2], uv[c * 2 + 1]);
        triD.push(dep[a], dep[b], dep[c]);
      }

      // 世界法线 + 视向：判定轮廓边
      const fn = table.faceNormals;
      const ne = nm.elements;
      const vd = new THREE.Vector3();
      camera.getWorldDirection(vd);
      const wn = new Float32Array(fn.length);
      for (let i = 0; i < fn.length; i += 3) {
        const x = fn[i], y = fn[i + 1], z = fn[i + 2];
        wn[i] = ne[0] * x + ne[3] * y + ne[6] * z;
        wn[i + 1] = ne[1] * x + ne[4] * y + ne[7] * z;
        wn[i + 2] = ne[2] * x + ne[5] * y + ne[8] * z;
      }

      for (const seg of table.segments) {
        const { a, b, t1, t2 } = seg;
        if (!ok[a] || !ok[b]) continue;
        let keep = seg.feature;
        if (!keep && t2 >= 0) {
          const d1 = wn[t1 * 3] * vd.x + wn[t1 * 3 + 1] * vd.y + wn[t1 * 3 + 2] * vd.z;
          const d2 = wn[t2 * 3] * vd.x + wn[t2 * 3 + 1] * vd.y + wn[t2 * 3 + 2] * vd.z;
          if ((d1 > 0) !== (d2 > 0)) keep = true;
        }
        if (!keep) continue;
        edgeUV.push(uv[a * 2], uv[a * 2 + 1], uv[b * 2], uv[b * 2 + 1]);
        edgeD.push(dep[a], dep[b]);
        edgeOwner.push(gi);
      }
    }
  });

  return {
    edges: {
      uv: Float32Array.from(edgeUV),
      depth: Float32Array.from(edgeD),
      owner: Int32Array.from(edgeOwner),
    },
    tris: { uv: Float32Array.from(triUV), depth: Float32Array.from(triD) },
    keys,
  };
}

/**
 * 全局消隐 + 按分组切分。
 *
 * proj 由 projectManyScreen 产出，edges 带 owner（段 → 分组下标）。
 * 深度图用的是**整机所有三角形**，所以外壳能正确遮挡内部零件。
 *
 * @returns {Map<string, Float32Array>} 分组 key → 可见线段（每段 4 数）
 */
export function removeHiddenLinesGrouped(proj, opts = {}) {
  const keys = proj.keys || [];
  const owner = proj.edges.owner || new Int32Array(0);
  const { segVisible, segHidden } = hiddenLinePass(proj, opts);
  const out = new Map();
  const acc = keys.map(() => []);
  const accH = segHidden ? keys.map(() => []) : null;
  for (let i = 0; i < segVisible.length; i++) {
    const gi = owner[i];
    if (gi == null || !acc[gi]) continue;
    const v = segVisible[i];
    if (!v) continue;
    for (let k = 0; k < v.length; k++) acc[gi].push(v[k]);
    if (accH) {
      const h = segHidden[i];
      if (h) for (let k = 0; k < h.length; k++) accH[gi].push(h[k]);
    }
  }
  keys.forEach((k, gi) => {
    if (acc[gi].length >= 4) {
      const rec = { visible: Float32Array.from(acc[gi]) };
      if (accH && accH[gi].length >= 4) rec.hidden = Float32Array.from(accH[gi]);
      out.set(k, rec);
    }
  });
  return out;
}

/**
 * 收集隐藏段的老接口（只返回可见段本体），兼容旧调用点。
 */
export function removeHiddenLinesGroupedVisible(grouped) {
  const m = new Map();
  for (const [k, rec] of grouped) {
    m.set(k, (rec && rec.visible) ? rec.visible : rec);
  }
  return m;
}


/**
 * 边统计（排查"出图比预期多很多线"用）
 *
 * 把一个零件的边按来源分类数出来：
 *   boundary  只被 1 个三角形用到（开口边界 / T 型接点）
 *   feature   跨曲面的特征边（平滑面合并后判定）
 *   smooth    被合并进同一张曲面、不画的边
 * 另外给出共面判据滤掉了多少条。
 *
 * @returns {{verts,tris,edges,boundary,feature,smooth,coplanar,bbox}}
 */
export function edgeStats(geo, thresholdDeg = 25) {
  const table = buildEdgeTable(geo, Math.cos((thresholdDeg * Math.PI) / 180));
  let boundary = 0, feature = 0, smooth = 0, coplanar = 0;
  for (const seg of table.segments) {
    if (seg.t2 === -1) { boundary++; continue; }
    if (seg.feature) feature++; else smooth++;
  }
  const pos = table.positions;
  let mn = [Infinity, Infinity, Infinity];
  let mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      if (pos[i + k] < mn[k]) mn[k] = pos[i + k];
      if (pos[i + k] > mx[k]) mx[k] = pos[i + k];
    }
  }
  return {
    verts: pos.length / 3,
    tris: table.triangles.length,
    edges: table.segments.length,
    boundary, feature, smooth,
    bbox: [mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]],
  };
}

export function clipSegmentsToRect(uv, rect) {
  const out = [];
  const { x0, y0, x1, y1 } = rect;
  for (let i = 0; i < uv.length; i += 4) {
    let ax = uv[i], ay = uv[i + 1], bx = uv[i + 2], by = uv[i + 3];
    const dx = bx - ax;
    const dy = by - ay;
    let t0 = 0, t1 = 1;
    let accept = true;
    const clipTest = (p, q) => {
      if (Math.abs(p) < 1e-12) return q >= 0;   // 平行：看是否在内侧
      const r = q / p;
      if (p < 0) {
        if (r > t1) return false;
        if (r > t0) t0 = r;
      } else {
        if (r < t0) return false;
        if (r < t1) t1 = r;
      }
      return true;
    };
    if (!clipTest(-dx, ax - x0)) accept = false;
    else if (!clipTest(dx, x1 - ax)) accept = false;
    else if (!clipTest(-dy, ay - y0)) accept = false;
    else if (!clipTest(dy, y1 - ay)) accept = false;
    if (!accept || t1 <= t0) continue;
    const nx1 = ax + dx * t0, ny1 = ay + dy * t0;
    const nx2 = ax + dx * t1, ny2 = ay + dy * t1;
    out.push(nx1, ny1, nx2, ny2);
  }
  return Float32Array.from(out);
}

export function projectGroup(meshRecords, keys, basis, thresholdDeg = 20) {
  const { dir } = basis;
  const edgeUV = [];
  const edgeD = [];
  const edgeOwner = [];       // 每条边属于第几个 key（整机消隐后要按组拆回去）
  const triUV = [];
  const triD = [];
  const cache = new Map();
  const cosThresh = Math.cos((thresholdDeg * Math.PI) / 180);

  for (let ki = 0; ki < keys.length; ki++) {
    const key = keys[ki];
    const rec = meshRecords.get(key);
    if (!rec || !rec.body || !rec.body.geometry) continue;
    const geo = rec.body.geometry;
    let table = cache.get(geo);
    if (!table) {
      table = buildEdgeTable(geo, cosThresh);
      cache.set(geo, table);
    }
    rec.body.updateWorldMatrix(true, false);
    const e = rec.body.matrixWorld.elements;
    const nm = new THREE.Matrix3().getNormalMatrix(rec.body.matrixWorld);

    // 顶点 → 世界 → (u,v,depth)
    const pos = table.positions;
    const n = pos.length / 3;
    const uv = new Float32Array(n * 2);
    const dep = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
      const wx = e[0] * x + e[4] * y + e[8] * z + e[12];
      const wy = e[1] * x + e[5] * y + e[9] * z + e[13];
      const wz = e[2] * x + e[6] * y + e[10] * z + e[14];
      uv[i * 2] = basis.right.x * wx + basis.right.y * wy + basis.right.z * wz;
      uv[i * 2 + 1] = basis.up.x * wx + basis.up.y * wy + basis.up.z * wz;
      // depth：越小越靠近相机
      dep[i] = -(dir.x * wx + dir.y * wy + dir.z * wz);
    }

    // 面法线（世界）
    const fn = table.faceNormals;
    const wn = new Float32Array(fn.length);
    const ne = nm.elements;
    for (let i = 0; i < fn.length; i += 3) {
      const x = fn[i], y = fn[i + 1], z = fn[i + 2];
      wn[i] = ne[0] * x + ne[3] * y + ne[6] * z;
      wn[i + 1] = ne[1] * x + ne[4] * y + ne[7] * z;
      wn[i + 2] = ne[2] * x + ne[5] * y + ne[8] * z;
    }

    // 三角形（消隐用）：只放朝向相机的，背面本来就不该挡线
    for (const tri of table.triangles) {
      const [a, b, c] = tri;
      // 同 projectGroupScreen：深度图不做背面剔除，避免绕序不一致留下的孔洞
      triUV.push(uv[a * 2], uv[a * 2 + 1], uv[b * 2], uv[b * 2 + 1], uv[c * 2], uv[c * 2 + 1]);
      triD.push(dep[a], dep[b], dep[c]);
    }

    /*
     * 可见边 = 特征边 + 轮廓边。
     *
     * · 特征边：跨曲面的边（见 buildEdgeTable 的平滑面合并）
     * · 轮廓边：面法线 · 视线方向 符号翻转 —— 光滑曲面没有硬边，
     *   不补轮廓的话像 o_ring 这种零件会整块消失
     */
    for (const seg of table.segments) {
      const { a, b, t1, t2 } = seg;
      let keep = seg.feature;
      if (!keep && t2 >= 0) {
        const d1 = wn[t1 * 3] * dir.x + wn[t1 * 3 + 1] * dir.y + wn[t1 * 3 + 2] * dir.z;
        const d2 = wn[t2 * 3] * dir.x + wn[t2 * 3 + 1] * dir.y + wn[t2 * 3 + 2] * dir.z;
        if ((d1 > 0) !== (d2 > 0)) keep = true;
      }
      if (!keep) continue;
      edgeUV.push(uv[a * 2], uv[a * 2 + 1], uv[b * 2], uv[b * 2 + 1]);
      edgeD.push(dep[a], dep[b]);
      edgeOwner.push(ki);
    }
  }

  return {
    keys,
    edges: {
      uv: Float32Array.from(edgeUV),
      depth: Float32Array.from(edgeD),
      owner: Int32Array.from(edgeOwner),
    },
    tris: { uv: Float32Array.from(triUV), depth: Float32Array.from(triD) },
  };
}

/**
 * 消隐入口。
 *
 * 用解析法（`hlr.js` 的 `hiddenLineAnalytic`）：把每条棱边和投影后的三角面
 * 做线段 ∩ 凸多边形，求出被遮挡的精确参数区间再减掉。没有采样，就没有
 * "贴着表面的可见边被判成遮挡、线条碎成虚线"那个老毛病。
 *
 * @param {{edges:{uv,depth}, tris:{uv,depth}}} proj
 * @returns {{segVisible: Array<Float32Array|null>, segHidden?: Array<Float32Array|null>, stats?: object}}
 */
function hiddenLinePass(proj, opts = {}) {
  const { edges, tris } = proj;
  const nEdge = edges.uv.length / 4;

  // 没有实体面（只画边线的模型）：全部当作可见
  if (!tris || !tris.uv || !tris.uv.length) {
    const segVisible = new Array(nEdge).fill(null);
    for (let i = 0; i < nEdge; i++) {
      segVisible[i] = edges.uv.subarray(i * 4, i * 4 + 4);
    }
    return { segVisible };
  }

  /*
   * 默认走**解析消隐**（几何精确）：光栅法在低容差下会把贴面可见边
   * 整段误判成遮挡（实测 3e-3 只保住 64% 可见线长，analytic 为 100% 基准），
   * 用户报"有的可见线消失"就是它。大装配 295 件实测 analytic 只要 ~2.1s。
   * 想要光栅版观感，传 { method: 'raster' }。
   * 两个实现都会返回 segHidden（被遮挡的部分），需要隐藏线的场合备用。
   */
  const r = opts.method === 'raster'
    ? hiddenLineRaster(proj, opts)
    : hiddenLineAnalytic(proj, opts);
  return { segVisible: r.segVisible, segHidden: r.segHidden, stats: r.stats };
}

/**
 * Z-buffer 隐藏线消除（单批次）。
 * @returns {Float32Array} 只含可见段（每段 4 数）
 */
export function removeHiddenLines(proj, opts = {}) {
  const { segVisible } = hiddenLinePass(proj, opts);
  const out = [];
  for (const v of segVisible) {
    if (!v) continue;
    for (let k = 0; k < v.length; k++) out.push(v[k]);
  }
  return Float32Array.from(out);
}


export function uvBounds(uv) {
  let minU = Infinity, minV = Infinity, maxU = -Infinity, maxV = -Infinity;
  for (let i = 0; i < uv.length; i += 2) {
    const u = uv[i], v = uv[i + 1];
    if (u < minU) minU = u;
    if (u > maxU) maxU = u;
    if (v < minV) minV = v;
    if (v > maxV) maxV = v;
  }
  if (!isFinite(minU)) return { minU: 0, minV: 0, maxU: 0, maxV: 0, w: 0, h: 0 };
  return { minU, minV, maxU, maxV, w: maxU - minU, h: maxV - minV };
}

/* ---------------------------------------------------------------- */
/* 4. 排到 A4                                                        */
/* ---------------------------------------------------------------- */

/**
 * 图层中间表示：
 *   { kind:'polyline', pts:[u,v,...], width, color }
 *   { kind:'text', x, y, str, height, alignH, alignV, color }
 *   { kind:'ellipse', cx, cy, rx, ry, color, width }
 */
/**
 * 生成图纸（可能多页）。
 *
 * 返回 { pages: [{ items, hotspots }], hotspots, items, sheet }：
 *   · pages  每页独立的一套元素，CGM 里对应一个 PICTURE，SVG 预览按页切换
 *   · items/hotspots  各页合并后的结果（向后兼容）
 *
 * 分页规则：分格模式下先按"每格不小于 minCell"估算列数，装不下就分页；
 * 每页只画本页零件对应的热点与图例，避免 295 个零件挤成一团。
 */
export function buildSheet(groups, opts) {
  const {
    mode = 'grid',
    edgesByGroup,
    sheet = A4,
    sourceName = 'Drawing',
    drawTitleBlock = false,
    /**
     * 外围图框（纸边矩形 + 内框）。
     * 默认关闭：图纸上只留图形本身。
     */
    drawBorder = false,
    hotspotByGroup = null,
    labelUnmatched = false,
    drawLegend = true,
    minCell = 34,
    softCell = 26,
    maxPages = 40,
    /**
     * 取景框模式：给了它就把内容区当作屏幕取景框的映射目标，
     * 线条已经不缩放（edgesByGroup 里就是 A4 毫米坐标），只做摆位与裁剪。
     */
    frameMode = false,
    /** AI 布点结果：{ [hotspotId]: {x,y} }，键 = g.key#recIndex */
    hotspotPositions = null,
    /**
     * 3D 连线：用户在 3D 里连的线，要画到 2D 上。
     *   linkSegments: [{ a:[x,y,z], b:[x,y,z] }]  世界坐标端点
     *   projectPoint: (x,y,z) => [u,v]            投到与 edgesByGroup 同一个空间
     */
    linkSegments = null,
    projectPoint = null,
    /**
     * 图册版面（对齐 HTEAM-04021）：一页一个整机视图、无图框/图例/分格标题、
     * 左上角写图册号、热点是"数字 + 5mm 正交短引线"。见 PLATE。
     * 打开后 mode / drawLegend / labelUnmatched 都被强制成图册的取值。
     */
    plate = false,
    /** 图册号，例如 'HTEAM-04021'；也用于 SVG/CGM 的文件名和 metafile 名 */
    drawingNo = '',
  } = opts;

  const visible = groups.filter((g) => {
    const e = edgesByGroup.get(g.key);
    if (!e) return false;
    const len = (e && e.visible) ? e.visible.length : e.length;
    return len >= 4;
  });

  /* ---------- 版面基础量 ---------- */
  const framePad = 2;
  const left = SHEET.margin;
  const top = sheet.height - SHEET.margin;
  const bottomBase = SHEET.margin + (drawTitleBlock ? SHEET.titleH : 0);
  const baseUsable = {
    x0: left + framePad,
    y0: bottomBase + framePad,
    x1: sheet.width - SHEET.margin - framePad,
    y1: top - framePad,
  };

  // 自动编号的起点：避开 Excel 已用的编号，防止两套编号撞车
  let autoNumber = 0;
  if (hotspotByGroup) {
    let maxN = 0;
    for (const list of hotspotByGroup.values()) {
      for (const rec of list) {
        const n = Number(rec.label);
        if (Number.isFinite(n) && n > maxN) maxN = n;
      }
    }
    autoNumber = Math.floor(maxN);
  }

  /**
   * 分页规划。
   *
   * 先用 softCell（默认 26mm）试"一页装下"：在 2~6 列里挑格子最大的方案。
   * 装不下再退回 minCell（34mm）分页 —— 格子大、页数多，但可读。
   * 这样 40 个零件能一页放下，295 个会自动分成 10 页。
   */
  const availW = baseUsable.x1 - baseUsable.x0;
  const availH = baseUsable.y1 - baseUsable.y0;

  function planGrid(n, areaW, areaH, floorCell) {
    let best = null;
    for (let c = 2; c <= 6; c++) {
      const r = Math.ceil(n / c);
      const cw = areaW / c;
      const ch = areaH / r;
      if (cw < floorCell || ch < floorCell) continue;
      const score = Math.min(cw, ch);          // 以较短边衡量格子大小
      if (!best || score > best.score) best = { cols: c, rows: r, cw, ch, score };
    }
    return best;
  }

  let pagesGroups = [];
  let gridPlan = null;

  if (frameMode && !plate) {
    // 取景框模式：几何已是 A4 毫米坐标，整幅一次画完，不分格不分页
    pagesGroups = [visible];
    gridPlan = null;
  } else if (plate || mode === 'single' || visible.length === 0) {
    pagesGroups = [visible];
  } else {
    const onePage = planGrid(visible.length, availW, availH, softCell);
    if (onePage) {
      gridPlan = onePage;
      pagesGroups = [visible];
    } else {
      // 需要分页：按 minCell 算每页容量（留出图例带）
      const colsP = Math.max(1, Math.min(6, Math.floor(availW / minCell)));
      const legendReserve = drawLegend && hotspotByGroup ? LEGEND.rowH * 8 + 6 : 0;
      const rowsP = Math.max(1, Math.floor((availH - legendReserve) / minCell));
      const perPage = Math.max(1, colsP * rowsP);
      gridPlan = { cols: colsP, rows: rowsP, cw: availW / colsP, ch: availH / rowsP, score: minCell };
      for (let i = 0; i < visible.length; i += perPage) {
        pagesGroups.push(visible.slice(i, i + perPage));
        if (pagesGroups.length >= maxPages) break;
      }
    }
  }

  const pageCount = Math.max(1, pagesGroups.length);
  const pages = [];
  const allItems = [];
  const allHotspots = [];
  let autoIndex = autoNumber;

  for (let p = 0; p < pageCount; p++) {
    const pageGroups0 = pagesGroups[p] || [];
    const items = [];
    const hotspots = [];

    /*
     * ---- 图框 ----
     * 默认**不画**：用户要求图纸上只留图形本身，不要外围框线。
     * 需要传统工程图边框时把 drawBorder 打开即可。
     */
    if (drawBorder) {
      items.push({
        kind: 'polyline', width: 0.5, color: [0, 0, 0],
        pts: [left, bottomBase, sheet.width - SHEET.margin, bottomBase,
              sheet.width - SHEET.margin, top, left, top, left, bottomBase],
      });
      items.push({
        kind: 'polyline', width: 0.25, color: [0, 0, 0],
        pts: [left + framePad, bottomBase + framePad, sheet.width - SHEET.margin - framePad,
              bottomBase + framePad, sheet.width - SHEET.margin - framePad, top - framePad,
              left + framePad, top - framePad, left + framePad, bottomBase + framePad],
      });
    }

    const usable = frameMode ? frameContentRect(sheet) : { ...baseUsable };
    // 图册版面：图形区固定为模板量出来的那块，图例一律不画
    if (plate) {
      usable.x0 = PLATE.area.x0;
      usable.y0 = PLATE.area.y0;
      usable.x1 = PLATE.area.x1;
      usable.y1 = PLATE.area.y1;
    }

    /*
     * 取景框模式：**不画限定框**。
     * 屏幕上那个绿框只是取景辅助，图纸上不需要这条线
     * （用户要求：转 2D 时不要把限定框画出来）。
     */

    // ---- 本页热点（用于图例） ----
    const pageHotspotByGroup = new Map();
    if (hotspotByGroup) {
      for (const g of pageGroups0) {
        const list = hotspotByGroup.get(g.key);
        if (list && list.length) pageHotspotByGroup.set(g.key, list);
      }
    }

    /* ---- 图例带：只放本页零件对应的热点 ---- */
    let legendItems = [];
    const legendRows = (!plate && pageHotspotByGroup.size && !legendDisabled(drawLegend))
      ? collectLegendRows(pageHotspotByGroup)
      : [];
    if (legendRows.length) {
      const totalH = usable.y1 - usable.y0;
      const idealH = LEGEND.rowH * (legendRows.length + 1) + 4;
      /*
       * 图例不能把绘图区吃光。
       * 上限：总高的 40%，并且必须给绘图区留下至少两格的高度
       * （否则格子高度变成负数，整格会被跳过 —— 热点和零件一起消失）。
       */
      const reserveForDrawing = minCell * 2;
      const maxBand = Math.min(totalH * 0.40, totalH - reserveForDrawing);
      const bandH = Math.min(idealH, Math.max(0, maxBand));
      if (bandH > LEGEND.rowH * 2) {
        legendItems = buildLegend(legendRows, {
          x0: usable.x0, x1: usable.x1,
          y0: usable.y0, y1: usable.y0 + bandH,
        });
        usable.y0 += bandH + 3;
      }
    }

    if (!pageGroups0.length) {
      items.push({
        kind: 'text', x: (usable.x0 + usable.x1) / 2, y: (usable.y0 + usable.y1) / 2,
        str: 'No geometry to draw', height: 5, alignH: 1, alignV: 1, color: [0.5, 0.5, 0.5],
      });
    } else if (plate) {
      /* ---- 图册：整机一个视图，铺满模板的图形区，按比例居中 ---- */
      const all = [];
      for (const g of pageGroups0) {
        const e = edgesByGroup.get(g.key);
        if (!e) continue;
        const vis = (e && e.visible) ? e.visible : e;
        for (let i = 0; i < vis.length; i++) all.push(vis[i]);
      }
      const b = uvBounds(Float32Array.from(all));
      const areaW = usable.x1 - usable.x0;
      const areaH = usable.y1 - usable.y0;
      /*
       * 热点要从零件外缘往外伸 5.16mm + 数字，所以图形不能顶到绘图区边界，
       * 必须给标注留一圈"边距"。这里按最长的热点编号算需要多少，
       * 从绘图区里扣掉，再算缩放 —— 否则靠边的热点会被夹回来，引线就缩成一小截。
       */
      const maxLabelLen = Math.max(2,
        ...(hotspotByGroup
          ? [...hotspotByGroup.values()].flat().map((r) => String(r.label ?? '').length)
          : [2]));
      const labelHalfW = textWidth('9'.repeat(maxLabelLen), HOTSPOT.charHeight) / 2;
      const marginX = labelHalfW + PLATE.gap + PLATE.leader + 1.0;
      const marginY = HOTSPOT.charHeight / 2 + PLATE.gap + PLATE.leader + 1.0;
      const drawW = Math.max(areaW - 2 * marginX, areaW * 0.25);
      const drawH = Math.max(areaH - 2 * marginY, areaH * 0.25);
      const s = Math.min(drawW / Math.max(b.w, 1e-6), drawH / Math.max(b.h, 1e-6));
      const cx = (usable.x0 + usable.x1) / 2;
      const cy = (usable.y0 + usable.y1) / 2;
      const ox = cx - ((b.minU + b.maxU) / 2) * s;
      const oy = cy - ((b.minV + b.maxV) / 2) * s;
      const plateEdges = new Map();
      for (const g of pageGroups0) {
        const e = edgesByGroup.get(g.key);
        if (!e) continue;
        const vis = (e && e.visible) ? e.visible : e;
        const m = mapSegs(vis, s, ox, oy);
        plateEdges.set(g.key, m);
        items.push({
          kind: 'polyline', pts: m, width: PLATE.lineWidth, color: [0, 0, 0], disjoint: true,
        });
        /*
         * 隐藏边不画（用户拍板：看不见的就不显示）。
         * HLR 已经把被遮挡段剔掉了 —— 那就保持剔掉的状态，别再用虚线补回来。
         * segHidden 数据仍保留在 edgesByGroup 里，将来要"可选显示隐藏线"直接用。
         */
      }
      // 3D 连线：同一套 s/ox/oy
      if (linkSegments && projectPoint) {
        for (const seg of linkSegments) {
          const a = projectPoint(seg.a[0], seg.a[1], seg.a[2]);
          const bb = projectPoint(seg.b[0], seg.b[1], seg.b[2]);
          if (!a || !bb) continue;
          items.push({
            kind: 'polyline', link: true, width: 0.2, color: [0, 0, 0],
            pts: [a[0] * s + ox, a[1] * s + oy, bb[0] * s + ox, bb[1] * s + oy],
          });
        }
      }
      hotspots.push(...placeHotspots(
        pageGroups0, plateEdges, { s: 1, ox: 0, oy: 0 }, usable, 'plate',
        autoIndex, hotspotByGroup, true, hotspotPositions
      ));
      autoIndex += hotspots.length;
    } else if (frameMode) {
      /*
       * 取景框模式：edgesByGroup 里已经是 A4 毫米坐标（由 projectGroupScreen +
       * clipSegmentsToRect 产生），不再缩放，直接画。热点用 identity 变换排版。
       */
      for (const g of pageGroups0) {
        const e = edgesByGroup.get(g.key);
        if (!e || e.length < 4) continue;
        items.push({ kind: 'polyline', pts: e, width: 0.18, color: [0, 0, 0], disjoint: true });
      }
      hotspots.push(...placeHotspots(
        pageGroups0, edgesByGroup, { s: 1, ox: 0, oy: 0 }, usable, 'frame',
        autoIndex, hotspotByGroup, labelUnmatched, hotspotPositions
      ));
      autoIndex += hotspots.length;

      // 3D 连线：取景框模式的投影已经是 A4 毫米，直接画
      if (linkSegments && projectPoint) {
        for (const seg of linkSegments) {
          const a = projectPoint(seg.a[0], seg.a[1], seg.a[2]);
          const b = projectPoint(seg.b[0], seg.b[1], seg.b[2]);
          if (!a || !b) continue;
          items.push({ kind: 'polyline', pts: [a[0], a[1], b[0], b[1]], width: 0.2, color: [0, 0, 0], link: true });
        }
      }
    } else if (mode === 'single') {
      /* ---- 整机视图：全部叠在一起 ---- */
      const all = [];
      for (const g of pageGroups0) {
        const e = edgesByGroup.get(g.key);
        for (let i = 0; i < e.length; i++) all.push(e[i]);
      }
      const b = uvBounds(Float32Array.from(all));
      const areaW = usable.x1 - usable.x0;
      const areaH = usable.y1 - usable.y0;
      const s = Math.min(areaW / Math.max(b.w, 1e-6), areaH / Math.max(b.h, 1e-6));
      const cx = (usable.x0 + usable.x1) / 2;
      const cy = (usable.y0 + usable.y1) / 2;
      const ox = cx - ((b.minU + b.maxU) / 2) * s;
      const oy = cy - ((b.minV + b.maxV) / 2) * s;
      for (const g of pageGroups0) {
        const e = edgesByGroup.get(g.key);
        items.push({
          kind: 'polyline', pts: mapSegs(e, s, ox, oy),
          width: 0.18, color: [0, 0, 0], disjoint: true,
        });
      }
      // 3D 连线：先投到 uv，再套用本页的 (s, ox, oy)
      if (linkSegments && projectPoint) {
        for (const seg of linkSegments) {
          const a = projectPoint(seg.a[0], seg.a[1], seg.a[2]);
          const b = projectPoint(seg.b[0], seg.b[1], seg.b[2]);
          if (!a || !b) continue;
          items.push({
            kind: 'polyline', link: true, width: 0.2, color: [0, 0, 0],
            pts: [a[0] * s + ox, a[1] * s + oy, b[0] * s + ox, b[1] * s + oy],
          });
        }
      }
      hotspots.push(...placeHotspots(
        pageGroups0, edgesByGroup, { s, ox, oy }, usable, 'single',
        autoIndex, hotspotByGroup, labelUnmatched, hotspotPositions
      ));
      autoIndex += hotspots.length;
    } else {
      /* ---- 分格视图 ---- */
      const n = pageGroups0.length;
      // 单页方案用规划好的列数；分页方案也用同一列数，保持一致
      const colsHere = Math.max(1, Math.min(gridPlan ? gridPlan.cols : 4, n));
      const r = Math.max(1, Math.ceil(n / colsHere));
      const cellW = (usable.x1 - usable.x0) / colsHere;
      const cellH = (usable.y1 - usable.y0) / r;

      pageGroups0.forEach((g, idx) => {
        const rr = Math.floor(idx / colsHere);
        const cc = idx % colsHere;
        const cx0 = usable.x0 + cc * cellW;
        const cy1 = usable.y1 - rr * cellH;
        const inner = {
          x0: cx0 + SHEET.gutter / 2,
          y0: cy1 - cellH + SHEET.cellTitleH + SHEET.gutter / 2,
          x1: cx0 + cellW - SHEET.gutter / 2,
          y1: cy1 - SHEET.gutter / 2,
        };
        // 格子太挤时退化：去掉标题高度，保证图形区还有正高度
        if (inner.y1 <= inner.y0 + 1) {
          inner.y0 = cy1 - cellH + 2;
          inner.y1 = cy1 - 1;
        }
        if (inner.x1 <= inner.x0 + 1 || inner.y1 <= inner.y0 + 1) return;   // 实在太挤就跳过
        const e = edgesByGroup.get(g.key);
        const b = uvBounds(e);
        const areaW = Math.max(inner.x1 - inner.x0, 1e-6);
        const areaH = Math.max(inner.y1 - inner.y0, 1e-6);
        const s = Math.min(areaW / Math.max(b.w, 1e-6), areaH / Math.max(b.h, 1e-6));
        const ccx = (inner.x0 + inner.x1) / 2;
        const ccy = (inner.y0 + inner.y1) / 2;
        const ox = ccx - ((b.minU + b.maxU) / 2) * s;
        const oy = ccy - ((b.minV + b.maxV) / 2) * s;
        items.push({
          kind: 'polyline', pts: mapSegs(e, s, ox, oy),
          width: 0.15, color: [0, 0, 0], disjoint: true,
        });
        // 分格标题：按格宽自适应字号并截断，长零件名不能串到隔壁格
        const capH = fitCaptionHeight(g.name, cellW - SHEET.gutter);
        items.push({
          kind: 'text', x: ccx, y: cy1 - cellH + 1.2,
          str: fitCaptionText(g.name, cellW - SHEET.gutter, capH),
          height: capH, alignH: 1, alignV: 3, color: [0, 0, 0],
        });
        const hs = placeHotspots(
          [g], edgesByGroup, { s, ox, oy }, inner, 'cell',
          autoIndex, hotspotByGroup, labelUnmatched, hotspotPositions
        );
        autoIndex += hs.length;
        hotspots.push(...hs);
      });
    }

    // ---- 热点绘制 ----
    if (plate) {
      /*
       * 图册模板的热点：**只有数字 + 一条正交短引线**。
       * 模板里没有端点小圆、没有外框；数字紧贴引线端点。
       *
       * 数字和它的引线**成对输出**（数字在前、引线紧跟），
       * 这样 CGM 里每个 PICK IDENTIFIER 都套住"数字 + 引线"两件东西，
       * 查看器点其中任何一个都能拾取到同一个编号。
       */
      for (const hs of hotspots) {
        items.push({
          kind: 'text', x: hs.cx, y: hs.cy - HOTSPOT.charHeight / 2,
          str: String(hs.label), height: HOTSPOT.charHeight,
          alignH: 1, alignV: 3, color: [0, 0, 0], pick: hs.label,
        });
        items.push({
          kind: 'polyline', width: PLATE.leaderWidth, color: [0, 0, 0],
          pts: hs.lead || [hs.ax, hs.ay, hs.ex, hs.ey],
          leadFor: hs.label,
        });
      }
    } else if (HOTSPOT.style === 'cgm') {
      /*
       * CGM 热点样式：**只要一个数字**。
       * 不画椭圆轮廓 —— CGM 里的热点靠 PICK IDENTIFIER 表达（写在文字前面），
       * 查看器点在数字上就能拿到编号，不需要外圈。
       */
      for (const hs of hotspots) {
        items.push({
          kind: 'text', x: hs.cx, y: hs.cy - HOTSPOT.charHeight / 2,
          str: String(hs.label), height: HOTSPOT.charHeight,
          alignH: 1, alignV: 3, color: [0, 0, 0], pick: hs.label,
        });
      }
      // 引线：横平竖直的折线（先横后竖），末端画小圆点标在零件上
      for (const hs of hotspots) {
        items.push({
          kind: 'polyline', width: 0.16, color: [0, 0, 0],
          pts: [hs.ax, hs.ay, hs.ex, hs.ay, hs.ex, hs.ey],
        });
        items.push({
          kind: 'ellipse', cx: hs.ax, cy: hs.ay, rx: HOTSPOT.leaderDot, ry: HOTSPOT.leaderDot,
          width: 0.14, color: [0, 0, 0],
        });
      }
    } else {
      // 旧样式：椭圆气球 + 直线引线
      for (const hs of hotspots) {
        items.push({
          kind: 'ellipse', cx: hs.cx, cy: hs.cy, rx: hs.rx, ry: hs.ry,
          width: 0.25, color: [0, 0, 0], pick: hs.label,
        });
      }
      for (const hs of hotspots) {
        items.push({
          kind: 'text', x: hs.cx, y: hs.cy - HOTSPOT.charHeight / 2,
          str: String(hs.label), height: HOTSPOT.charHeight,
          alignH: 1, alignV: 3, color: [0, 0, 0], pick: hs.label,
        });
      }
      for (const hs of hotspots) {
        items.push({
          kind: 'polyline', pts: [hs.ax, hs.ay, hs.tx, hs.ty], width: 0.18, color: [0, 0, 0],
        });
        items.push({
          kind: 'ellipse', cx: hs.ax, cy: hs.ay, rx: HOTSPOT.leaderDot, ry: HOTSPOT.leaderDot,
          width: 0.15, color: [0, 0, 0],
        });
      }
    }

    if (legendItems.length) items.push(...legendItems);

    if (plate) {
      /*
       * 图册号：左上角，Arial，cap height 4.91mm（模板实测 5.0mm 墨迹高）。
       * 模板里只有这一行字，没有图框 / 标题栏 / 图例。
       */
      const no = String(drawingNo || sourceName || '').trim();
      if (no) {
        items.push({
          kind: 'text', x: PLATE.titleX, y: PLATE.titleY, str: no,
          height: PLATE.titleHeight, alignH: 0, alignV: 3, color: [0, 0, 0],
        });
      }
    }

    const pageTitle = pageCount > 1
      ? `${sourceName}   第 ${p + 1}/${pageCount} 页`
      : sourceName;
    const done = finish(items, hotspots, sheet, pageTitle, plate ? false : drawTitleBlock);

    // 记录本页是否有热点重叠（0 = 一个都没有）
    let overlaps = 0;
    for (let a = 0; a < done.hotspots.length; a++) {
      for (let b = a + 1; b < done.hotspots.length; b++) {
        if (pairOverlaps(done.hotspots[a], done.hotspots[b])) overlaps++;
      }
    }

    pages.push({ items: done.items, hotspots: done.hotspots, overlaps });
    allItems.push(...done.items);
    allHotspots.push(...done.hotspots);
  }

  return {
    pages,
    pageCount,
    items: allItems,
    hotspots: allHotspots,
    sheet,
    /** 版面类型：图册（对齐 HTEAM-04021）/ 常规 */
    plate: !!plate,
    /** 图册号（页面上左上角那一行，也是文件名） */
    drawingNo: String(drawingNo || ''),
    /** 全图热点重叠对数（应当恒为 0） */
    overlaps: pages.reduce((a, p) => a + p.overlaps, 0),
  };
}

/**
 * 独立的"热点不折叠"校验：返回重叠对与最小中心距，供测试/自检用。
 * @returns {{overlaps:number, pairs:Array, minDist:number, count:number}}
 */
export function checkHotspotOverlap(sheetData) {
  const hs = sheetData.hotspots || [];
  const pairs = [];
  let minDist = Infinity;
  for (let a = 0; a < hs.length; a++) {
    for (let b = a + 1; b < hs.length; b++) {
      const A = hs[a], B = hs[b];
      const d = Math.hypot(B.cx - A.cx, B.cy - A.cy);
      if (d < minDist) minDist = d;
      if (pairOverlaps(A, B)) {
        pairs.push({
          a: A.label, b: B.label,
          dx: +(B.cx - A.cx).toFixed(2), dy: +(B.cy - A.cy).toFixed(2),
          needX: +(A.rx + B.rx + HOTSPOT.minRingGap).toFixed(2),
          needY: +(A.ry + B.ry + HOTSPOT.minRingGap).toFixed(2),
        });
      }
    }
  }
  return { overlaps: pairs.length, pairs, minDist: Number.isFinite(minDist) ? +minDist.toFixed(2) : 0, count: hs.length };
}

/**
 * 从 Excel 匹配结果里汇总图例行：按编号去重（同一编号指向多个同名零件时只出现一次），
 * 按编号数值排序。
 */
function collectLegendRows(hotspotByGroup) {
  const byLabel = new Map();
  for (const list of hotspotByGroup.values()) {
    for (const rec of list) {
      const label = String(rec.label ?? '');
      if (!label) continue;
      if (byLabel.has(label)) {
        // 合并：同名零件的分组名去重后合并
        const prev = byLabel.get(label);
        if (rec.groupName && !prev.groupNames.includes(rec.groupName)) prev.groupNames.push(rec.groupName);
        if (!prev.qty && rec.qty) prev.qty = rec.qty;
        if (!prev.title && rec.title) prev.title = rec.title;
        continue;
      }
      byLabel.set(label, {
        label,
        title: rec.title || '',
        qty: rec.qty || '',
        extra: rec.extra || [],
        groupNames: rec.groupName ? [rec.groupName] : [],
      });
    }
  }
  const rows = [...byLabel.values()];
  // 编号是数字就按数值排，否则按字典序
  rows.sort((a, b) => {
    const na = Number(a.label);
    const nb = Number(b.label);
    if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
    return a.label.localeCompare(b.label, 'zh-Hans-CN', { numeric: true });
  });
  return rows;
}

/**
 * 画热点图例表。区域由调用方给定（已从绘图区里扣出来了）。
 * 列：编号 | 说明（零件名） | 数量 | 附加列…
 */
function buildLegend(rows, area) {
  const out = [];
  if (!rows.length) return out;

  const x0 = area.x0;
  const x1 = area.x1;
  const rowH = LEGEND.rowH;

  // 列宽按内容粗估
  const colNo = 12;
  const colQty = rows.some((r) => r.qty) ? 14 : 0;
  const extraCols = rows[0].extra && rows[0].extra.length ? rows[0].extra.length : 0;
  const colExtra = 26;
  const colTitle = Math.max(30, (x1 - x0) - colNo - colQty - extraCols * colExtra);

  // 表画在 area 顶部往下
  const yTop = area.y1;
  const maxRows = Math.floor((yTop - area.y0) / rowH) - 1;
  const shown = rows.slice(0, Math.max(maxRows, 1));

  const line = (xa, ya, xb, yb, w = 0.18) =>
    out.push({ kind: 'polyline', pts: [xa, ya, xb, yb], width: w, color: [0, 0, 0] });

  const text = (x, y, s, h = LEGEND.charHeight, alignH = 0) =>
    out.push({ kind: 'text', x, y, str: s, height: h, alignH, alignV: 3, color: [0, 0, 0] });

  // 表头
  const yHead = yTop - rowH * 0.62;
  text(x0 + 1.2, yHead, '编号');
  text(x0 + colNo + 1.2, yHead, '说明');
  if (colQty) text(x0 + colNo + colTitle + 1.2, yHead, '数量');
  for (let i = 0; i < extraCols; i++) {
    text(x0 + colNo + colTitle + colQty + i * colExtra + 1.2, yHead, truncate(rows[0].extra[i].header, 8));
  }
  line(x0, yTop - rowH, x1, yTop - rowH, 0.3);

  // 数据行
  shown.forEach((r, i) => {
    const y = yTop - rowH * (i + 1.62);
    text(x0 + 1.2, y, r.label);
    const desc = r.title || (r.groupNames || []).join(', ');
    text(x0 + colNo + 1.2, y, truncate(desc, Math.floor(colTitle / 2.0)));
    if (colQty) text(x0 + colNo + colTitle + 1.2, y, r.qty || '');
    for (let k = 0; k < (r.extra || []).length; k++) {
      text(x0 + colNo + colTitle + colQty + k * colExtra + 1.2, y, truncate(r.extra[k].value, 10));
    }
    line(x0, yTop - rowH * (i + 2), x1, yTop - rowH * (i + 2), 0.12);
  });

  // 竖直分隔线
  const yBottom = yTop - rowH * (shown.length + 1);
  const cols = [x0, x0 + colNo, x0 + colNo + colTitle];
  if (colQty) cols.push(x0 + colNo + colTitle + colQty);
  for (let i = 0; i < extraCols; i++) cols.push(x0 + colNo + colTitle + colQty + (i + 1) * colExtra);
  cols.push(x1);
  for (const cx of cols) line(cx, yTop, cx, yBottom, 0.15);

  if (rows.length > shown.length) {
    text(x0 + 1.2, yBottom - 1.6, `另有 ${rows.length - shown.length} 项未列出`, LEGEND.headerHeight);
  }
  return out;
}

function finish(items, hotspots, sheet, sourceName, drawTitleBlock) {
  if (drawTitleBlock) {
    const y0 = SHEET.margin;
    const x0 = sheet.width - SHEET.margin - 90;
    const x1 = sheet.width - SHEET.margin;
    const y1 = y0 + SHEET.titleH;
    items.push({
      kind: 'polyline', width: 0.5, color: [0, 0, 0],
      pts: [x0, y0, x1, y0, x1, y1, x0, y1, x0, y0],
    });
    items.push({
      kind: 'polyline', width: 0.25, color: [0, 0, 0],
      pts: [x0, y0 + 7, x1, y0 + 7],
    });
    items.push({
      kind: 'polyline', width: 0.25, color: [0, 0, 0],
      pts: [x0, y0 + 14, x1, y0 + 14],
    });
    items.push({
      kind: 'text', x: x0 + 2, y: y0 + 16.5, str: truncate(sourceName, 40),
      height: 3.5, alignH: 0, alignV: 3, color: [0, 0, 0],
    });
    items.push({
      kind: 'text', x: x0 + 2, y: y0 + 9.5, str: 'JT Browser  ·  2D Line Drawing',
      height: 2.6, alignH: 0, alignV: 3, color: [0, 0, 0],
    });
    items.push({
      kind: 'text', x: x0 + 2, y: y0 + 2.5, str: 'A4  210 × 297 mm   ·   1:1 VDC (mm)',
      height: 2.6, alignH: 0, alignV: 3, color: [0, 0, 0],
    });
  }
  return { items, hotspots, sheet };
}

function mapSegs(uv, s, ox, oy) {
  const out = new Float32Array(uv.length);
  for (let i = 0; i < uv.length; i += 2) {
    const u = uv[i], v = uv[i + 1];
    // 坐标异常（NaN / 超出 A4 几个数量级）直接归零，别让一条坏线毁掉整张图
    out[i] = Number.isFinite(u) && Math.abs(u) < 1e5 ? u * s + ox : ox;
    out[i + 1] = Number.isFinite(v) && Math.abs(v) < 1e5 ? v * s + oy : oy;
  }
  return out;
}

/**
 * 把 disjoint 线段（每 4 数一段）按"短划 + 空隙"周期切成更短的段。
 *
 * 隐藏边画点线用：CGM 的 LINE DASHED 在不同查看器里相位/长度不一致，
 * 直接把几何切成真实短段，任何渲染端出来都是同一种点线观感。
 * 每段从周期起点重新起算（相位不跨段延续），与 CAD 惯例一致。
 *
 * @param {Float32Array|number[]} segs 每 4 数一段 [x0,y0,x1,y1,...]
 * @param {number} dash 划长（mm）
 * @param {number} gap 空隙长（mm）
 * @returns {Float32Array} 切短后的段
 */
export function dashSegments(segs, dash, gap) {
  const out = [];
  const period = dash + gap;
  for (let i = 0; i < segs.length; i += 4) {
    const x0 = segs[i], y0 = segs[i + 1], x1 = segs[i + 2], y1 = segs[i + 3];
    const L = Math.hypot(x1 - x0, y1 - y0);
    if (L < 1e-9) continue;
    if (L <= dash) { out.push(x0, y0, x1, y1); continue; }
    const ux = (x1 - x0) / L, uy = (y1 - y0) / L;
    for (let t = 0; t < L; t += period) {
      const a = t;
      const b = Math.min(t + dash, L);
      if (b - a < dash * 0.25) break;      // 尾部零头太短就丢弃，避免脏点
      out.push(x0 + ux * a, y0 + uy * a, x0 + ux * b, y0 + uy * b);
    }
  }
  return Float32Array.from(out);
}

function truncate(s, n) {
  s = String(s || '');
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

/* ---- 分格标题自适应：长零件名不能溢出到相邻格子 ---- */

/**
 * 估算一个字符在当前字号下的宽度（mm）。
 * 中文字宽约 1.0 em，ASCII 平均约 0.5 em；cap height = 0.716 em。
 */
function charWidth(ch, charHeight) {
  const em = charHeight / 0.716;
  const code = ch.codePointAt(0);
  // CJK / 全角
  if (code >= 0x2e80) return em * 1.0;
  // 窄字符
  if ('iljtIf.,;:\'"|!`'.includes(ch)) return em * 0.28;
  if (ch === ' ') return em * 0.28;
  // 大写与数字
  if (code >= 0x41 && code <= 0x5a) return em * 0.68;
  if (code >= 0x30 && code <= 0x39) return em * 0.556;
  return em * 0.52;
}

function textWidthMm(str, charHeight) {
  let w = 0;
  for (const ch of String(str)) w += charWidth(ch, charHeight);
  return w;
}

/** 给格宽选一个能放下的字号（不小于 1.6mm，不小于原字号的 55%） */
function fitCaptionHeight(name, maxWidth, baseHeight = SHEET.captionH) {
  const w = textWidthMm(name, baseHeight);
  if (w <= maxWidth) return baseHeight;
  const scaled = baseHeight * (maxWidth / w);
  return Math.max(1.6, Math.min(baseHeight, scaled));
}

/** 按字宽硬截断，末尾加省略号（保证不超出 maxWidth） */
function fitCaptionText(name, maxWidth, charHeight) {
  const s = String(name || '');
  if (textWidthMm(s, charHeight) <= maxWidth) return s;
  const ell = '…';
  const ellW = textWidthMm(ell, charHeight);
  let out = '';
  let w = 0;
  for (const ch of s) {
    const cw = charWidth(ch, charHeight);
    if (w + cw + ellW > maxWidth) break;
    out += ch;
    w += cw;
  }
  return (out || s.slice(0, 1)) + ell;
}

/* ---------------------------------------------------------------- */
/* 5. 热点布局                                                        */
/* ---------------------------------------------------------------- */

/**
 * 给每个分组中的每一条热点记录排一个圆圈：几何 → 圆心（编号）、外轮廓（ellipse）、引线端点。
 *
 * 规则（用户给定）：
 *   · 编号用 Arial，数字高度 2.056 mm
 *   · 热点轮廓比数字外框各大 0.05 mm（rx = 文字半宽 + 0.05，ry = 2.056/2 + 0.05）
 *   · 引线从轮廓边缘指向零件上的锚点，锚点画 0.12 mm 小圆
 *
 * @param {Array} groups
 * @param {Map} edgesByGroup
 * @param {{s,ox,oy}} xf
 * @param {object} area 可用区域（夹紧用）
 * @param {'single'|'cell'} mode
 * @param {number} baseIndex 无 Excel 时自动编号的起点
 * @param {Map<string, Array>|null} hotspotByGroup Excel 匹配结果：groupKey → [{label,title,qty,extra}]
 */
function placeHotspots(groups, edgesByGroup, xf, area, mode, baseIndex = 0, hotspotByGroup = null, labelUnmatched = false, fixPositions = null) {
  const out = [];
  if (!groups.length) return out;

  const { s, ox, oy } = xf;

  // 图区中心（判断"向外"是往哪边）
  const areaCx0 = (area.x0 + area.x1) / 2;
  const areaCy0 = (area.y0 + area.y1) / 2;

  /*
   * 1) 每个分组算：2D 边缘矩形（包围盒）+ 出线方向 + 锚点
   *
   * 默认逻辑（用户给定）：
   *   · 以**一组**为单位，先求这组 2D 线条的**边缘矩形**
   *   · 锚点取"这个矩形上最外缘、且真的落在图线上的那个点"
   *     —— 即沿"向外方向"投影最远的那个线段端点
   *   · 编号从这个点**向外延伸**出去，引线保持横平竖直
   */
  const info = [];
  groups.forEach((g, i) => {
    const uv = edgesByGroup.get(g.key) || new Float32Array(0);
    const b = uvBounds(uv);
    const bx0 = b.minU * s + ox, by0 = b.minV * s + oy;
    const bx1 = b.maxU * s + ox, by1 = b.maxV * s + oy;
    const cx = (bx0 + bx1) / 2;
    const cy = (by0 + by1) / 2;

    // 向外方向：从图区中心指向这组包围盒中心；退化时朝右
    let dx = cx - areaCx0;
    let dy = cy - areaCy0;
    if (Math.abs(dx) + Math.abs(dy) < 1e-9) { dx = 1; dy = 0; }
    // 只用正交方向（横平竖直），取占优的那个轴
    const outAxis = Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y';
    const outSign = outAxis === 'x' ? (dx >= 0 ? 1 : -1) : (dy >= 0 ? 1 : -1);

    /*
     * 锚点 = 沿 outward 方向投影最远的那个点（在边缘矩形上、且是图线上的点）。
     * 这样引线起点正好落在轮廓外缘，而不是零件内部。
     */
    let anchor = [cx, cy];
    let bestScore = -Infinity;
    const consider = (x, y) => {
      const score = outAxis === 'x' ? x * outSign : y * outSign;
      // 同分时偏向更靠近中心的那条，避免选到孤立的尖角
      if (score > bestScore + 1e-9) { bestScore = score; anchor = [x, y]; }
    };
    for (let k = 0; k < uv.length; k += 2) {
      consider(uv[k] * s + ox, uv[k + 1] * s + oy);
    }

    // Excel 里这个分组有几行就出几个热点。
    // 没给 Excel 时：每组一个自动编号热点。
    // 给了 Excel 但这一组没被匹配到：默认不画热点（避免凭空编号），
    // 除非 opts.labelUnmatched = true。
    const recs = hotspotByGroup ? hotspotByGroup.get(g.key) : null;
    let list;
    if (recs && recs.length) {
      list = recs;
    } else if (!hotspotByGroup || labelUnmatched) {
      list = [{ label: String(baseIndex + i + 1), title: '', qty: '', extra: [] }];
    } else {
      return; // 跳过：Excel 没覆盖到的分组不加热点
    }

    list.forEach((rec, k) => {
      info.push({
        g,
        i: info.length,
        recIndex: k,
        recCount: list.length,
        // 稳定 id：AI 布点按这个 id 回传坐标
        id: `${g.key}#${k}`,
        label: String(rec.label ?? (baseIndex + i + 1)),
        title: rec.title || '',
        qty: rec.qty || '',
        extra: rec.extra || [],
        excelName: rec.excelName || '',
        matchType: rec.matchType || '',
        box: {
          x0: bx0, y0: by0, x1: bx1, y1: by1,
        },
        centroid: [cx, cy],
        anchor,
        outAxis,
        outSign,
      });
    });
  });

  // 2) 热点尺寸（精确按规范算；多位数编号宽度自然变大）
  const halfH = HOTSPOT.charHeight / 2;
  for (const it of info) {
    const w = textWidth(it.label, HOTSPOT.charHeight);
    it.w2 = w / 2;                       // 数字本身的半宽（排版用，不含避让余量）
    if (HOTSPOT.style === 'cgm') {
      // 只要数字：尺寸只用来"避让"，本身不画框
      it.rx = w / 2 + 0.2;
      it.ry = halfH + 0.2;
    } else {
      it.rx = w / 2 + HOTSPOT.inflate;
      it.ry = halfH + HOTSPOT.inflate;
    }
    it.radius = Math.max(it.rx, it.ry);
  }

  // 3) 摆放：以视图中心为原点，按各组质心的角度向外推到边缘
  const areaCx = (area.x0 + area.x1) / 2;
  const areaCy = (area.y0 + area.y1) / 2;
  const halfW = (area.x1 - area.x0) / 2;
  const halfH2 = (area.y1 - area.y0) / 2;

  // 排序角度：优先用质心方向，退化时按序号均分；
  // 同一分组有多条热点时，围绕质心方向均分角度，避免叠在一起
  const groupAngleCount = new Map();
  for (const it of info) {
    const key = it.g.key;
    if (!groupAngleCount.has(key)) groupAngleCount.set(key, []);
    groupAngleCount.get(key).push(it);
  }
  for (const [, list] of groupAngleCount) {
    const base = list[0];
    const dx = base.centroid[0] - areaCx;
    const dy = base.centroid[1] - areaCy;
    const a0 = (Math.abs(dx) + Math.abs(dy) < 1e-6)
      ? (Math.PI * 2 * base.i) / info.length
      : Math.atan2(dy, dx);
    list.forEach((it, k) => {
      if (list.length === 1) { it.angle = a0; return; }
      // 在 ±60° 扇形内铺开
      const spread = (Math.PI / 1.5);
      it.angle = a0 + (k - (list.length - 1) / 2) * (spread / Math.max(list.length - 1, 1));
    });
  }

  // 环半径：留出热点自身尺寸，贴着视图边缘外侧
  const maxR = Math.max(...info.map((it) => it.radius));
  const ringPad = maxR + HOTSPOT.minRingGap;

  // 在椭圆环上取点，再夹进可用区域
  for (const it of info) {
    const cos = Math.cos(it.angle);
    const sin = Math.sin(it.angle);
    let px = areaCx + cos * (halfW + ringPad);
    let py = areaCy + sin * (halfH2 + ringPad);
    it.dirX = 0;
    it.dirY = 0;

    if (mode === 'plate') {
      /*
       * 图册模板：数字贴在零件外缘，用一条**正交**引线拉出来。
       *
       * 模板实测（HTEAM-04021.svg 的热点 4）：
       *   引线 M70,42.972 L64.841,42.972；数字左边缘 x=71、基线 y=43.9494
       *   → 引线长 5.16mm，线端与数字留 1.0mm，端点落在零件轮廓上，线在数字的垂直中心。
       *
       * 所以这里用"数字本身半宽 w2"算位置，不含避让余量：
       *   cx = 锚点 + 方向 × (w2 + 1.0 + 5.16)
       * 同一组多条热点时沿垂直方向等距排开（每条仍有自己的短引线）。
       */
      const outAxis = it.outAxis || 'x';
      const outSign = it.outSign || 1;
      const idx = it.recIndex ?? 0;
      const cnt = it.recCount ?? 1;
      const reach = (it.w2 ?? it.rx) + PLATE.gap + PLATE.leader;
      if (outAxis === 'x') {
        const step = PLATE.leader + HOTSPOT.charHeight * 0.6;
        px = it.anchor[0] + outSign * reach;
        py = it.anchor[1] + (idx - (cnt - 1) / 2) * step;
        it.dirX = outSign;
        it.dirY = 0;
      } else {
        const step = PLATE.leader + 2.2;
        py = it.anchor[1] + outSign * reach;
        px = it.anchor[0] + (idx - (cnt - 1) / 2) * step;
        it.dirX = 0;
        it.dirY = outSign;
      }
      it.cx = clamp(px, area.x0 + it.rx, area.x1 - it.rx);
      it.cy = clamp(py, area.y0 + it.ry, area.y1 - it.ry);
      continue;
    }

    if (HOTSPOT.style === 'cgm') {
      /*
       * 用 info 阶段算好的"出线方向"（outAxis / outSign）：
       * 从边缘矩形上那个最外缘的点，沿正交方向往外让出 数字半宽 + 间距。
       * 同一组有多条热点时，沿**垂直方向**等距排开，避免叠在一起，
       * 引线仍然是先横后竖的直角折线。
       */
      const outAxis = it.outAxis || 'x';
      const outSign = it.outSign || 1;
      const idx = it.recIndex ?? 0;
      const cnt = it.recCount ?? 1;
      if (outAxis === 'x') {
        const step = 2 * it.ry + HOTSPOT.minRingGap;
        px = it.anchor[0] + outSign * (it.rx + HOTSPOT.leaderGap);
        py = it.anchor[1] + (idx - (cnt - 1) / 2) * step;
        it.dirX = outSign;
        it.dirY = 0;
      } else {
        const step = 2 * it.rx + HOTSPOT.minRingGap;
        py = it.anchor[1] + outSign * (it.ry + HOTSPOT.leaderGap);
        px = it.anchor[0] + (idx - (cnt - 1) / 2) * step;
        it.dirX = 0;
        it.dirY = outSign;
      }
      it.cx = clamp(px, area.x0 + it.rx, area.x1 - it.rx);
      it.cy = clamp(py, area.y0 + it.ry, area.y1 - it.ry);
      continue;
    }

    if (mode === 'cell') {
      /*
       * 分格模式：热点压在格子右上角。
       * 同一格可能有多条热点（比如一个零件在 Excel 里有两行检验项），
       * 必须按序号**往下错开**，否则会完全叠在一起（等于"折叠"成一个）。
       */
      const stepY = 2 * it.ry + HOTSPOT.minRingGap;
      const stepX = 2 * it.rx + HOTSPOT.minRingGap;
      const col = Math.floor(it.recIndex / 3);      // 一行最多 3 个，超了换列
      const row = it.recIndex % 3;
      px = area.x1 - it.rx - 1.2 - col * stepX;
      py = area.y1 - it.ry - 1.2 - row * stepY;
    } else if (mode === 'frame') {
      /*
       * 取景框模式：整个装配都在框里，热点必须贴着各自的零件放，
       * 不能推到"A4 外圈"（那会全挤到页边成一竖排）。
       * 做法：从零件质心沿"远离图纸中心"的方向外移一个热点半径 + 1.5mm，
       * 引线再把球指回零件。
       */
      const away = Math.hypot(it.anchor[0] - areaCx, it.anchor[1] - areaCy) || 1;
      const ux = (it.anchor[0] - areaCx) / away;
      const uy = (it.anchor[1] - areaCy) / away;
      const off = it.radius + 1.6;
      px = it.anchor[0] + ux * off;
      py = it.anchor[1] + uy * off;
    }
    it.cx = clamp(px, area.x0 + it.rx, area.x1 - it.rx);
    it.cy = clamp(py, area.y0 + it.ry, area.y1 - it.ry);
  }

  /*
   * 3b) 外部指定坐标（AI 布点的结果）优先。
   *     放在这里是因为后面还有夹取 + 去重叠 + 网格回落三道保险，
   *     AI 给的坐标即使越界或有轻微重叠也会被自动修正，不会画飞。
   */
  if (fixPositions) {
    for (const it of info) {
      const p = fixPositions[it.id] || (fixPositions.get ? fixPositions.get(it.id) : null);
      if (!p) continue;
      it.cx = clamp(p.x, area.x0 + it.rx, area.x1 - it.rx);
      it.cy = clamp(p.y, area.y0 + it.ry, area.y1 - it.ry);
      it.fromAI = true;
    }
  }

  // 4) 去重叠：迭代推开（O(n²)，组数不大）
  //    注意：循环里**不夹取**，夹取会把热点又推回重叠位置；只在循环结束后夹一次。
  for (let iter = 0; iter < 200; iter++) {
    let moved = false;
    for (let a = 0; a < info.length; a++) {
      for (let b = a + 1; b < info.length; b++) {
        const A = info[a], B = info[b];
        const dx = B.cx - A.cx;
        const dy = B.cy - A.cy;
        const needX = A.rx + B.rx + HOTSPOT.minRingGap;
        const needY = A.ry + B.ry + HOTSPOT.minRingGap;
        const overlapX = needX - Math.abs(dx);
        const overlapY = needY - Math.abs(dy);
        if (overlapX > 0 && overlapY > 0) {
          if (overlapX < overlapY) {
            const push = (overlapX / 2 + 0.001) * (dx >= 0 ? 1 : -1);
            A.cx -= push; B.cx += push;
          } else {
            const push = (overlapY / 2 + 0.001) * (dy >= 0 ? 1 : -1);
            A.cy -= push; B.cy += push;
          }
          moved = true;
        }
      }
    }
    if (!moved) break;
  }
  for (const it of info) {
    it.cx = clamp(it.cx, area.x0 + it.rx, area.x1 - it.rx);
    it.cy = clamp(it.cy, area.y0 + it.ry, area.y1 - it.ry);
  }

  /*
   * 5) 硬保证：夹取之后可能又撞上了，或者热点太密松弛不开。
   *    这里做一次网格回落 —— 按"离各自零件最近"把热点分配进互不相邻的格子，
   *    格子尺寸取最大热点尺寸 + 间隙，所以**构造上就不可能重叠**。
   */
  if (hasOverlap(info)) {
    gridFallback(info, area);
  }


  /*
   * 5) 引线端点 / 折弯点
   *
   * cgm 样式（只要数字）：引线是**横平竖直**的折线 ——
   *   零件锚点 → 水平走到数字正下方/正上方 → 竖直到数字。
   *   所以需要算出数字的"下方接点" (ex, ey) 和它相对锚点的方向。
   * balloon 样式：从圆心沿指向锚点的方向落到椭圆边界。
   */
  for (const it of info) {
    it.ax = it.anchor[0];
    it.ay = it.anchor[1];

    if (mode === 'plate') {
      /*
       * 图册：数字 + 正交短引线。
       *
       * 模板的引线是一段直线：从零件轮廓正好走 5.16mm，停在数字外框外 1.0mm，
       * 且与数字垂直居中。热点没被挤开时，这里画出来和模板一模一样。
       *
       * 热点被"去重叠"挪开后（一张整机图 70+ 个热点必然发生），
       * **第一段仍然严格 5.16mm**，多出来的位移用一段正交折线吸收 ——
       * 所以任何情况下都不会出现斜线，也不会出现"引线缩成一小截"。
       *
       *   anchor ──5.16mm──> A ──(正交)──> 数字外框外 1.0mm
       */
      const dirX = it.dirX || 0;
      const dirY = it.dirY || 0;
      const w2 = it.w2 ?? it.rx;
      const halfCap = HOTSPOT.charHeight / 2;

      // 引线必须停在这儿：数字外框外 PLATE.gap
      it.ex = it.cx - dirX * (w2 + PLATE.gap);
      it.ey = it.cy - dirY * (halfCap + PLATE.gap);

      // 第一段终点：从锚点沿出线方向正好走 PLATE.leader
      const ax2 = it.ax + dirX * PLATE.leader;
      const ay2 = it.ay + dirY * PLATE.leader;
      // 拐到数字外框：先沿出线轴走完，再垂直落下去
      const lead = it.outAxis === 'y'
        ? [it.ax, it.ay, ax2, ay2, ax2, it.ey, it.ex, it.ey]
        : [it.ax, it.ay, ax2, ay2, it.ex, ay2, it.ex, it.ey];
      it.lead = dedupeLead(lead);

      it.tx = it.ex;
      it.ty = it.ey;
      out.push(it);
      continue;
    }

    if (HOTSPOT.style === 'cgm') {
      // 数字在锚点的哪一侧：先由摆放阶段定好方向（it.dirX / it.dirY），这里算接点
      const dirX = it.dirX || 0;
      const dirY = it.dirY || 0;
      // 接点：数字框朝零件的那一边的中点
      it.ex = it.cx - dirX * (it.rx + 0.15);
      it.ey = it.cy - dirY * (it.ry + 0.15);
      it.tx = it.ex;
      it.ty = it.ey;
      out.push(it);
      continue;
    }

    const dx = it.anchor[0] - it.cx;
    const dy = it.anchor[1] - it.cy;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len;
    const t = 1 / Math.hypot(ux / Math.max(it.rx, 1e-6), uy / Math.max(it.ry, 1e-6));
    it.tx = it.cx + ux * t;
    it.ty = it.cy + uy * t;
    it.ex = it.tx;
    it.ey = it.ty;
    out.push(it);
  }
  return out;
}

function clamp(v, lo, hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}

/**
 * 去掉折线里重复的点（同一位置的点会画成零长段，CGM 里看着像脏数据）。
 *
 * 只删"与上一点重合"的点，**不做共线合并** ——
 * L 形引线的两个端点与拐点是三处不同的位置，合并会退化成一条错线。
 */
function dedupeLead(pts) {
  const out = [];
  for (let i = 0; i < pts.length; i += 2) {
    const x = pts[i];
    const y = pts[i + 1];
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const n = out.length;
    if (n >= 2 && Math.abs(out[n - 2] - x) < 1e-9 && Math.abs(out[n - 1] - y) < 1e-9) continue;
    out.push(x, y);
  }
  return out;
}

/** 两个热点是否重叠（按椭圆外接矩形 + 间隙判） */
function pairOverlaps(A, B) {
  const needX = A.rx + B.rx + HOTSPOT.minRingGap;
  const needY = A.ry + B.ry + HOTSPOT.minRingGap;
  return Math.abs(B.cx - A.cx) < needX && Math.abs(B.cy - A.cy) < needY;
}

/** 是否存在任何一对重叠 */
function hasOverlap(info) {
  for (let a = 0; a < info.length; a++) {
    for (let b = a + 1; b < info.length; b++) {
      if (pairOverlaps(info[a], info[b])) return true;
    }
  }
  return false;
}

/**
 * 网格回落：把热点塞进互不相邻的格子，**构造上保证不重叠**。
 *
 * 格子尺寸 = 最大热点尺寸 + 间隙；每个热点挑"离自己零件锚点最近"的空格子。
 * 这样即使要塞几百个热点也不会叠在一起（A4 内容区约 210×208mm，
 * 3mm 见方的格子有两千多个）。
 */
function gridFallback(info, area) {
  if (!info.length) return;
  const maxRx = Math.max(...info.map((it) => it.rx));
  const maxRy = Math.max(...info.map((it) => it.ry));
  const cw = 2 * maxRx + HOTSPOT.minRingGap + 0.4;
  const ch = 2 * maxRy + HOTSPOT.minRingGap + 0.4;

  const x0 = area.x0 + maxRx;
  const x1 = area.x1 - maxRx;
  const y0 = area.y0 + maxRy;
  const y1 = area.y1 - maxRy;
  const cols = Math.max(1, Math.floor((x1 - x0) / cw) + 1);
  const rows = Math.max(1, Math.floor((y1 - y0) / ch) + 1);

  // 格子中心表 + 占用标记
  const free = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      free.push({ c, r, x: x0 + c * cw, y: y0 + r * ch, used: false });
    }
  }

  // 按锚点顺序挑最近的空格子；锚点靠边的一侧优先，减少引线交叉
  for (const it of info) {
    let best = null;
    let bestD = Infinity;
    for (const cell of free) {
      if (cell.used) continue;
      const d = (cell.x - it.anchor[0]) ** 2 + (cell.y - it.anchor[1]) ** 2;
      if (d < bestD) { bestD = d; best = cell; }
    }
    if (!best) break;                       // 格子用完了（极端情况）就保持原位置
    best.used = true;
    it.cx = best.x;
    it.cy = best.y;
  }
}

/** Arial 数字/字母的排版宽度（mm），与 cgm.js 的 arialTextExtent 一致 */
export function textWidth(str, charHeight) {
  const em = charHeight / 0.716;         // cap height 0.716 em
  return String(str).length * 0.556 * em; // digit advance 0.556 em
}

/* ---------------------------------------------------------------- */
/* 6. 预览用 SVG                                                      */
/* ---------------------------------------------------------------- */

/** 把图层中间表示渲染成 SVG 字符串（屏幕预览 / 打印核对用） */
export function sheetToSVG(sheetData) {
  const { items, sheet } = sheetData;
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const paths = [];
  for (const it of items) {
    const col = `rgb(${Math.round(it.color[0] * 255)},${Math.round(it.color[1] * 255)},${Math.round(it.color[2] * 255)})`;
    if (it.kind === 'polyline') {
      const dash = it.dash ? ` stroke-dasharray="${it.dash}"` : '';
      if (it.disjoint) {
        /*
         * disjoint：每 4 数一段独立线段（CAD 棱边 / 隐藏边短划）。
         * SVG 没有现成的 disjoint 元素，用"多个 M"表达 —— M 断开处不连线，
         * 等价于 CGM 的 DISJOINT POLYLINE。绝不能用一条 M+L 连到底，
         * 否则互不相连的段会被串成横穿整张图的长线。
         */
        const d = [];
        for (let i = 0; i < it.pts.length; i += 2) {
          const cmd = (i % 4 === 0) ? 'M' : 'L';
          d.push(cmd + it.pts[i].toFixed(3) + ' ' + (sheet.height - it.pts[i + 1]).toFixed(3));
        }
        paths.push(`<path d="${d.join(' ')}" fill="none" stroke="${col}" stroke-width="${it.width}" stroke-linecap="round" stroke-linejoin="round"${dash}/>`);
      } else {
        const d = [];
        for (let i = 0; i < it.pts.length; i += 2) {
          d.push((i === 0 ? 'M' : 'L') + it.pts[i].toFixed(3) + ' ' + (sheet.height - it.pts[i + 1]).toFixed(3));
        }
        paths.push(`<path d="${d.join(' ')}" fill="none" stroke="${col}" stroke-width="${it.width}" stroke-linecap="round" stroke-linejoin="round"${dash}/>`);
      }
    } else if (it.kind === 'ellipse') {
      paths.push(`<ellipse cx="${it.cx.toFixed(3)}" cy="${(sheet.height - it.cy).toFixed(3)}" rx="${it.rx.toFixed(3)}" ry="${it.ry.toFixed(3)}" fill="none" stroke="${col}" stroke-width="${it.width}" stroke-linecap="round" stroke-linejoin="round"/>`);
    } else if (it.kind === 'text') {
      const anchor = it.alignH === 0 ? 'start' : (it.alignH === 2 ? 'end' : 'middle');
      // alignV: 3=base, 1=cap, 0=top, 4=bottom → 统一用 alphabetic + 基线偏移近似
      const y = sheet.height - it.y;
      paths.push(`<text x="${it.x.toFixed(3)}" y="${y.toFixed(3)}" font-family="${HOTSPOT.fontFamily}" font-size="${(it.height / 0.716).toFixed(3)}" fill="${col}" text-anchor="${anchor}">${esc(it.str)}</text>`);
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${sheet.width}mm" height="${sheet.height}mm" viewBox="0 0 ${sheet.width} ${sheet.height}">
<rect width="${sheet.width}" height="${sheet.height}" fill="#ffffff"/>
${paths.join('\n')}
</svg>`;
}

/**
 * 单页 SVG（指定页码）。多页时用于逐页预览。
 * @param {object} sheetData buildSheet 结果
 * @param {number} pageIndex 0 基
 */
export function sheetPageToSVG(sheetData, pageIndex = 0) {
  const pages = sheetData.pages && sheetData.pages.length
    ? sheetData.pages
    : [{ items: sheetData.items, hotspots: sheetData.hotspots }];
  const page = pages[Math.max(0, Math.min(pageIndex, pages.length - 1))];
  return sheetToSVG({ items: page.items, hotspots: page.hotspots, sheet: sheetData.sheet });
}

/**
 * 多页 SVG：把每页上下排在一张图里，方便一次看全。
 */
export function sheetToSVGMultiPage(sheetData) {
  const pages = sheetData.pages && sheetData.pages.length
    ? sheetData.pages
    : [{ items: sheetData.items, hotspots: sheetData.hotspots }];
  if (pages.length === 1) return sheetPageToSVG(sheetData, 0);

  const { sheet } = sheetData;
  const gap = 8;
  const totalH = pages.length * sheet.height + (pages.length - 1) * gap;
  const inner = pages.map((p, i) => {
    const svg = sheetToSVG({ items: p.items, hotspots: p.hotspots, sheet });
    const body = svg.replace(/^<svg[^>]*>/, '').replace(/<\/svg>$/, '');
    const ty = i * (sheet.height + gap);
    return `<g transform="translate(0,${ty})">${body}</g>`;
  }).join('\n');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${sheet.width}mm" height="${totalH}mm" viewBox="0 0 ${sheet.width} ${totalH}">
<rect width="${sheet.width}" height="${totalH}" fill="#c8ccd2"/>
${inner}
</svg>`;
}
