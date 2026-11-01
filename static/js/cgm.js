/**
 * cgm.js —— ISO/IEC 8632 二进制编码 CGM 写入器（纯 JS，无依赖）
 *
 * 依据 ISO/IEC 8632-3:1992 二进制编码：
 *   · 命令头 = 16 位字：class(4) | id(7) | paramLength(5)
 *     长度 < 31 用短格式；= 31 用长格式，紧跟 2 字节无符号长度
 *   · 元素按 16 位字对齐，奇数长度的参数列表末尾补 1 字节 0（补齐字节不计入长度）
 *   · 字符串参数 = 1 字节长度 + 字符，无结尾 NUL
 *   · 实数按 IEEE 754 float32 大端序（word1 = sign+exp+frac[22:16]）
 *   · 整数按二进制补码大端序
 *
 * 本文件只做"按元素写字节"，不做任何几何/排版决策。
 */

export const CLS = {
  DELIMITER: 0,
  METAFILE_DESCRIPTOR: 1,
  PICTURE_DESCRIPTOR: 2,
  CONTROL: 3,
  PRIMITIVE: 4,
  ATTRIBUTE: 5,
  ESCAPE: 6,
  EXTERNAL: 7,
  SEGMENT: 8,
};

/* 本模块用到的元素 (class, id) */
export const EL = {
  BEGIN_METAFILE: [0, 1],
  END_METAFILE: [0, 2],
  BEGIN_PICTURE: [0, 3],
  BEGIN_PICTURE_BODY: [0, 4],
  END_PICTURE: [0, 5],

  METAFILE_VERSION: [1, 1],
  METAFILE_DESCRIPTION: [1, 2],
  VDC_TYPE: [1, 3],
  INTEGER_PRECISION: [1, 4],
  REAL_PRECISION: [1, 5],
  INDEX_PRECISION: [1, 6],
  COLOUR_PRECISION: [1, 7],
  COLOUR_INDEX_PRECISION: [1, 8],
  MAXIMUM_COLOUR_INDEX: [1, 9],
  COLOUR_VALUE_EXTENT: [1, 10],
  METAFILE_ELEMENT_LIST: [1, 11],
  FONT_LIST: [1, 13],

  SCALING_MODE: [2, 1],
  COLOUR_SELECTION_MODE: [2, 2],
  LINE_WIDTH_SPECIFICATION_MODE: [2, 3],
  EDGE_WIDTH_SPECIFICATION_MODE: [2, 4],
  VDC_EXTENT: [2, 5],
  BACKGROUND_COLOUR: [2, 6],

  VDC_INTEGER_PRECISION: [3, 1],
  VDC_REAL_PRECISION: [3, 2],

  POLYLINE: [4, 1],
  DISJOINT_POLYLINE: [4, 2],
  TEXT: [4, 4],
  POLYGON: [4, 7],
  CIRCLE: [4, 12],
  ELLIPSE: [4, 17],

  LINE_WIDTH: [5, 3],
  LINE_COLOUR: [5, 4],
  LINE_TYPE: [5, 2],
  TEXT_FONT_INDEX: [5, 10],
  CHARACTER_EXPANSION_FACTOR: [5, 12],
  TEXT_COLOUR: [5, 14],
  CHARACTER_HEIGHT: [5, 15],
  CHARACTER_ORIENTATION: [5, 16],
  TEXT_ALIGNMENT: [5, 18],
  INTERIOR_STYLE: [5, 22],
  FILL_COLOUR: [5, 23],
  EDGE_WIDTH: [5, 28],
  EDGE_COLOUR: [5, 29],
  EDGE_VISIBILITY: [5, 30],
  PICK_IDENTIFIER: [5, 36],
};

/* 枚举常量（ISO 8632-1） */
export const ENUM = {
  VDC_INTEGER: 0,
  VDC_REAL: 1,
  /*
   * PRECISION 枚举只用于"精度说明"类元素；
   * INTEGER/INDEX/COLOUR PRECISION 三个描述符写的是**位数**（8/16/24/32），
   * 不是这个枚举 —— 写成 1 会被读成"1 位整数"，uniconvertor / Cortona2D 直接拒绝打开。
   * 见 beginMetafile()。
   */
  PREC_8: 0,
  PREC_16: 1,
  PREC_24: 2,
  PREC_32: 3,
  REAL_FIXED: 0,
  REAL_FLOATING: 1,
  SCALING_ABSTRACT: 0,
  SCALING_METRIC: 2,
  COLOUR_INDEXED: 0,
  COLOUR_DIRECT: 1,
  INTERIOR_HOLLOW: 2,
  INTERIOR_SOLID: 1,
  EDGE_ON: 1,
  EDGE_OFF: 0,
  TEXT_LEFT: 0,
  TEXT_CENTRE: 1,
  TEXT_RIGHT: 2,
  TEXT_TOP: 0,
  TEXT_CAP: 1,
  TEXT_HALF_CAP: 2,
  TEXT_BASE: 3,
  TEXT_BOTTOM: 4,
};

/** 参数构造器：把 JS 值转成该元素参数列表的字节 */
class Params {
  constructor() {
    this.bytes = [];
  }
  /** 有符号整数（16 位，二进制补码，大端） */
  i16(v) {
    const n = Math.round(v) & 0xffff;
    this.bytes.push((n >> 8) & 0xff, n & 0xff);
    return this;
  }
  /** 有符号整数（32 位） */
  i32(v) {
    const n = Math.round(v) >>> 0;
    this.bytes.push((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
    return this;
  }
  /** 无符号 8 位 */
  u8(v) {
    this.bytes.push(v & 0xff);
    return this;
  }
  /** IEEE 754 float32，大端（CGM 的 FP real 32-bit 就是这个位序） */
  f32(v) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setFloat32(0, v, false); // big-endian
    this.bytes.push(b[0], b[1], b[2], b[3]);
    return this;
  }
  /** 定点实数 32 位精度：word1 = 有符号整数部分，word2 = 无符号小数部分 */
  fx32(v) {
    const whole = Math.floor(v);
    const frac = Math.round((v - whole) * 65536);
    return this.i16(whole).i16(frac);
  }
  /** 字符串：1 字节长度 + 字符（无 NUL） */
  str(s) {
    const enc = new TextEncoder().encode(String(s));
    const n = Math.min(enc.length, 254);
    this.bytes.push(n);
    for (let i = 0; i < n; i++) this.bytes.push(enc[i]);
    return this;
  }
  /** 点（坐标对） */
  pt(x, y) {
    return this.f32(x).f32(y);
  }
  /** 直接色（CI 精度 8 位，R G B） */
  rgb(r, g, b) {
    return this.u8(r).u8(g).u8(b);
  }
  raw(arr) {
    for (const v of arr) this.bytes.push(v & 0xff);
    return this;
  }
}

export class CgmWriter {
  constructor(opts = {}) {
    this.chunks = [];
    this.elementCount = 0;
    this.coord = opts.coord || 'f32'; // 'f32' 浮点 | 'fx32' 定点
    this.meta = [];
  }

  /** 写一个元素。长格式长度上限 32767（规范要求是有符号正数），超了必须由调用方切分 */
  element(cls, id, params) {
    const b = params instanceof Params ? params.bytes : params || [];
    const len = b.length;
    if (len > 32767) {
      throw new RangeError(
        `CGM 元素 ${cls},${id} 参数长度 ${len} 超过长格式上限 32767，必须切分后再写`
      );
    }
    const head = [];
    if (len < 31) {
      const w = ((cls & 0xf) << 12) | ((id & 0x7f) << 5) | (len & 0x1f);
      head.push((w >> 8) & 0xff, w & 0xff);
    } else {
      const w = ((cls & 0xf) << 12) | ((id & 0x7f) << 5) | 31;
      head.push((w >> 8) & 0xff, w & 0xff, (len >> 8) & 0xff, len & 0xff);
    }
    this.chunks.push(new Uint8Array(head));
    this.chunks.push(new Uint8Array(b));
    if ((head.length + len) & 1) this.chunks.push(new Uint8Array([0])); // 对齐补齐
    this.elementCount++;
    return this;
  }

  el(elPair, params) {
    return this.element(elPair[0], elPair[1], params);
  }

  /* ---------- 便捷方法 ---------- */
  p() {
    return new Params();
  }
  coordPair(x, y) {
    const p = new Params();
    if (this.coord === 'fx32') {
      p.fx32(x).fx32(y);
    } else {
      p.f32(x).f32(y);
    }
    return p;
  }

  beginMetafile(name) {
    this.el(EL.BEGIN_METAFILE, this.p().str(name));
    this.el(EL.METAFILE_VERSION, this.p().i16(3)); // CGM:1992 = version 3
    this.el(EL.METAFILE_DESCRIPTION, this.p().str('JT Browser CGM export (ISO/IEC 8632-3 binary)'));
    /*
     * 精度描述符写**位数**，不是枚举索引（ISO/IEC 8632-1 §7.2）：
     *   INTEGER PRECISION      = 8 / 16 / 24 / 32
     *   INDEX PRECISION        = 8 / 16 / 24 / 32
     *   COLOUR PRECISION       = 8 / 16 / 24 / 32
     *   COLOUR INDEX PRECISION = 8 / 16 / 24 / 32
     * 曾经这里写了枚举（16 位 → 1、8 位 → 0），Cortona2D 打开就退出，
     * uniconvertor 报 "Unsupported 1-bit integer precision"。
     *
     * REAL PRECISION 的格式和上面四个不同：它是 (format, exponent bits, mantissa bits)
     * 三个 i16。实测（techdraw.cgm、uniconvertor 产物、用户模板三者一致）Cortona2D
     * 只认 (0, 9, 23) 这一种写法；ISO float 写法 (1, 8, 23) 会让它拒绝加载。
     */
    this.el(EL.VDC_TYPE, this.p().i16(ENUM.VDC_REAL));
    this.el(EL.INTEGER_PRECISION, this.p().i16(16));
    this.el(EL.REAL_PRECISION, this.p().i16(0).i16(9).i16(23));
    this.el(EL.INDEX_PRECISION, this.p().i16(16));
    this.el(EL.COLOUR_PRECISION, this.p().i16(8));
    this.el(EL.COLOUR_INDEX_PRECISION, this.p().i16(8));
    // MAXIMUM COLOUR INDEX 是单字节无符号（受 COLOUR INDEX PRECISION = 8 约束）
    this.el(EL.MAXIMUM_COLOUR_INDEX, this.p().u8(255));
    /*
     * COLOUR VALUE EXTENT 按 COLOUR PRECISION = 8 编码：R/G/B 各 min,max 共 6 个
     * **字节**。曾写成 6 个 i16（12 字节），Cortona2D 按 8 位色值解析时长度错位，
     * 直接退出——这是"打不开"的最终根因（模板与 uniconvertor 均为 6 字节）。
     */
    this.el(EL.COLOUR_VALUE_EXTENT, this.p().u8(0).u8(255).u8(0).u8(255).u8(0).u8(255));
    this.el(EL.VDC_REAL_PRECISION, this.p().i16(0).i16(9).i16(23));
    return this;
  }

  /** 声明字体表：index 1 = Arial */
  fontList(names) {
    const p = this.p();
    for (const n of names) p.str(n);
    return this.el(EL.FONT_LIST, p);
  }

  beginPicture(name, vdcExtent, opts = {}) {
    this.el(EL.BEGIN_PICTURE, this.p().str(name));
    // SCALING MODE = METRIC，scale=1 → VDC 单位即毫米
    this.el(EL.SCALING_MODE, this.p().i16(ENUM.SCALING_METRIC).f32(1.0));
    this.el(EL.COLOUR_SELECTION_MODE, this.p().i16(ENUM.COLOUR_DIRECT));
    this.el(EL.LINE_WIDTH_SPECIFICATION_MODE, this.p().i16(0)); // ABSOLUTE
    this.el(EL.EDGE_WIDTH_SPECIFICATION_MODE, this.p().i16(0));
    const [x0, y0, x1, y1] = vdcExtent;
    this.el(EL.VDC_EXTENT, this.p().f32(x0).f32(y0).f32(x1).f32(y1));
    if (opts.background) {
      this.el(EL.BACKGROUND_COLOUR, this.p().rgb(...opts.background));
    }
    this.el(EL.BEGIN_PICTURE_BODY, this.p());
    return this;
  }

  endPicture() {
    return this.el(EL.END_PICTURE, this.p());
  }
  endMetafile() {
    return this.el(EL.END_METAFILE, this.p());
  }

  /** 折线；pts = [x0,y0,x1,y1,...]（VDC=mm）。超长自动切段（保持首尾相连） */
  polyline(pts) {
    const pairs = pts.length / 2;
    // 每条元素最多 (32767 / 8) 个点，再减 1 保证与下一段共享连接点
    const maxPts = 4000;
    if (pairs <= maxPts) {
      const p = this.p();
      for (let i = 0; i < pts.length; i += 2) this._coord(p, pts[i], pts[i + 1]);
      return this.el(EL.POLYLINE, p);
    }
    for (let start = 0; start < pairs - 1; start += maxPts - 1) {
      const end = Math.min(start + maxPts, pairs);
      const slice = pts.slice(start * 2, end * 2);
      const p = this.p();
      for (let i = 0; i < slice.length; i += 2) this._coord(p, slice[i], slice[i + 1]);
      this.el(EL.POLYLINE, p);
      if (end >= pairs) break;
    }
    return this;
  }

  /**
   * 不连续折线：pts 每 4 个数是一段独立线段（x1,y1,x2,y2）。
   * 这是画 CAD 棱边的正确元素 —— 用 POLYLINE 会把不相连的边首尾连起来。
   */
  disjointPolyline(pts) {
    // 每条元素最多 4000 段（4000*16 = 64000 > 32767，取 2000 段）
    const segs = pts.length / 4;
    const maxSegs = 2000;
    if (segs <= maxSegs) {
      const p = this.p();
      for (let i = 0; i < pts.length; i += 2) this._coord(p, pts[i], pts[i + 1]);
      return this.el(EL.DISJOINT_POLYLINE, p);
    }
    for (let start = 0; start < segs; start += maxSegs) {
      const end = Math.min(start + maxSegs, segs);
      const p = this.p();
      for (let i = start * 4; i < end * 4; i += 2) this._coord(p, pts[i], pts[i + 1]);
      this.el(EL.DISJOINT_POLYLINE, p);
    }
    return this;
  }

  _coord(p, x, y) {
    if (this.coord === 'fx32') p.fx32(x).fx32(y);
    else p.f32(x).f32(y);
  }

  /** 文本；alignH/alignV 决定 (x,y) 的锚点 */
  text(x, y, s, alignH = ENUM.TEXT_CENTRE, alignV = ENUM.TEXT_CAP) {
    const p = this.p();
    if (this.coord === 'fx32') p.fx32(x).fx32(y);
    else p.f32(x).f32(y);
    p.i16(alignH).i16(alignV).f32(0).f32(0);
    p.str(s);
    return this.el(EL.TEXT, p);
  }

  circle(cx, cy, r) {
    const p = this.p();
    if (this.coord === 'fx32') p.fx32(cx).fx32(cy).fx32(r);
    else p.f32(cx).f32(cy).f32(r);
    return this.el(EL.CIRCLE, p);
  }

  /**
   * 正椭圆（轴对齐）：CGM ELLIPSE 的三个参数是
   * 圆心、第一共轭直径端点、第二共轭直径端点。
   * 轴对齐时即 (cx,cy)、(cx+rx,cy)、(cx,cy+ry)。
   */
  ellipse(cx, cy, rx, ry) {
    const p = this.p();
    const put = (x, y) => (this.coord === 'fx32' ? p.fx32(x).fx32(y) : p.f32(x).f32(y));
    put(cx, cy);
    put(cx + rx, cy);
    put(cx, cy + ry);
    return this.el(EL.ELLIPSE, p);
  }

  /** 空心矩形（用多边形，闭合） */
  rectHollow(x0, y0, x1, y1) {
    return this.polyline([x0, y0, x1, y0, x1, y1, x0, y1, x0, y0]);
  }

  /** 打包成 Blob */
  toBlob() {
    const total = this.chunks.reduce((a, c) => a + c.length, 0);
    const out = new Uint8Array(total);
    let o = 0;
    for (const c of this.chunks) {
      out.set(c, o);
      o += c.length;
    }
    return new Blob([out], { type: 'image/cgm' });
  }

  toUint8Array() {
    const total = this.chunks.reduce((a, c) => a + c.length, 0);
    const out = new Uint8Array(total);
    let o = 0;
    for (const c of this.chunks) {
      out.set(c, o);
      o += c.length;
    }
    return out;
  }
}

/* ------------------------------------------------------------------ */
/* Arial 度量：把"字符高度 mm"换算成排版尺寸                              */
/* ------------------------------------------------------------------ */
/** Arial 的数字 advance（em 比例），见 Arial AFM: 0.556 em */
export const ARIAL_DIGIT_ADVANCE_EM = 0.556;
/** Arial 的大写/数字高度（cap height）0.716 em */
export const ARIAL_CAP_HEIGHT_EM = 0.716;
/** Arial 的 ascent / descent（em 比例） */
export const ARIAL_ASCENT_EM = 0.905;
export const ARIAL_DESCENT_EM = 0.212;

/**
 * 给定 CGM CHARACTER HEIGHT（= 数字高度，mm），算字符串的排版包围盒（mm）。
 * CGM 的 CHARACTER HEIGHT 对应 cap height，所以要先反推 em。
 */
export function arialTextExtent(str, charHeightMm) {
  const em = charHeightMm / ARIAL_CAP_HEIGHT_EM;
  const n = String(str).length;
  return {
    width: n * ARIAL_DIGIT_ADVANCE_EM * em,
    height: charHeightMm,
    em,
    advance: ARIAL_DIGIT_ADVANCE_EM * em,
  };
}
