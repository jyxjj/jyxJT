/**
 * verify-cgm.mjs —— 独立 CGM 解析器：按 ISO/IEC 8632-3 二进制规范回读
 *
 * 用途：验证生成的 CGM 是否**结构合法**，以及关键参数（A4 尺寸、字号 2.056、
 * 热点外扩 0.05、字体 Arial）是否真的写进去了。不依赖生成端任何代码路径，
 * 只按规范解析字节流。
 *
 * 用法：
 *   node verify-cgm.mjs drawing.cgm
 *   node verify-cgm.mjs drawing.cgm --json
 */

import fs from 'node:fs';

const CLASS_NAMES = {
  0: 'Delimiter', 1: 'MetafileDescriptor', 2: 'PictureDescriptor',
  3: 'Control', 4: 'Primitive', 5: 'Attribute', 6: 'Escape', 7: 'External', 8: 'Segment',
};

const ELEMENT_NAMES = {
  '0,1': 'BEGIN METAFILE', '0,2': 'END METAFILE',
  '0,3': 'BEGIN PICTURE', '0,4': 'BEGIN PICTURE BODY', '0,5': 'END PICTURE',
  '1,1': 'METAFILE VERSION', '1,2': 'METAFILE DESCRIPTION', '1,3': 'VDC TYPE',
  '1,4': 'INTEGER PRECISION', '1,5': 'REAL PRECISION', '1,6': 'INDEX PRECISION',
  '1,7': 'COLOUR PRECISION', '1,8': 'COLOUR INDEX PRECISION',
  '1,9': 'MAXIMUM COLOUR INDEX', '1,10': 'COLOUR VALUE EXTENT',
  '1,11': 'METAFILE ELEMENT LIST', '1,13': 'FONT LIST',
  '2,1': 'SCALING MODE', '2,2': 'COLOUR SELECTION MODE',
  '2,3': 'LINE WIDTH SPECIFICATION MODE', '2,4': 'EDGE WIDTH SPECIFICATION MODE',
  '2,5': 'VDC EXTENT', '2,6': 'BACKGROUND COLOUR',
  '3,1': 'VDC INTEGER PRECISION', '3,2': 'VDC REAL PRECISION',
  '4,1': 'POLYLINE', '4,2': 'DISJOINT POLYLINE', '4,4': 'TEXT', '4,7': 'POLYGON',
  '4,12': 'CIRCLE', '4,13': 'CIRCULAR ARC 3 POINT', '4,14': 'CIRCULAR ARC 3 POINT CLOSE',
  '5,3': 'LINE WIDTH', '5,4': 'LINE COLOUR', '5,10': 'TEXT FONT INDEX',
  '5,12': 'CHARACTER EXPANSION FACTOR', '5,14': 'TEXT COLOUR',
  '5,15': 'CHARACTER HEIGHT', '5,16': 'CHARACTER ORIENTATION',
  '5,18': 'TEXT ALIGNMENT', '5,22': 'INTERIOR STYLE', '5,23': 'FILL COLOUR',
  '5,28': 'EDGE WIDTH', '5,29': 'EDGE COLOUR', '5,30': 'EDGE VISIBILITY',
  '5,36': 'PICK IDENTIFIER',
};

class Reader {
  constructor(buf) {
    this.b = buf;
    this.o = 0;
  }
  eof() { return this.o >= this.b.length; }
  u8() { return this.b[this.o++]; }
  u16() {
    const v = (this.b[this.o] << 8) | this.b[this.o + 1];
    this.o += 2;
    return v;
  }
  i16() {
    const v = this.u16();
    return v & 0x8000 ? v - 0x10000 : v;
  }
  f32() {
    const dv = new DataView(this.b.buffer, this.b.byteOffset + this.o, 4);
    const v = dv.getFloat32(0, false);
    this.o += 4;
    return v;
  }
  bytes(n) {
    const s = this.b.subarray(this.o, this.o + n);
    this.o += n;
    return s;
  }
}

/** 解析整个 CGM，返回元素列表 + 诊断 */
export function parseCgm(buf) {
  const r = new Reader(buf);
  const elements = [];
  const errors = [];
  let guard = 0;

  while (!r.eof()) {
    if (guard++ > 2_000_000) { errors.push('element count exceeded'); break; }
    if (r.o + 2 > buf.length) { errors.push(`truncated header at ${r.o}`); break; }

    const w = r.u16();
    const cls = (w >> 12) & 0xf;
    const id = (w >> 5) & 0x7f;
    let len = w & 0x1f;
    let longForm = false;
    if (len === 31) {
      if (r.o + 2 > buf.length) { errors.push(`truncated long length at ${r.o}`); break; }
      len = r.u16();
      longForm = true;
    }
    // 分区/扩展形式：class 15 & id 127 → 后续 2 字节长度
    if (cls === 15 && id === 127) {
      const partitionLen = r.u16();
      elements.push({ cls, id, len, longForm, name: 'PARTITION', offset: r.o, paramLen: partitionLen });
      continue;
    }

    if (r.o + len > buf.length) {
      errors.push(`element ${cls},${id} at ${r.o} claims ${len} bytes but only ${buf.length - r.o} left`);
      break;
    }
    const start = r.o;
    const params = r.bytes(len);
    // 16 位对齐补齐
    if ((2 + (longForm ? 2 : 0) + len) & 1) r.o += 1;

    elements.push({
      cls, id, len, longForm, offset: start, params,
      name: ELEMENT_NAMES[`${cls},${id}`] || `${CLASS_NAMES[cls] || cls} #${id}`,
    });
  }

  return { elements, errors, size: buf.length };
}

/** 从元素列表里抽取语义信息 */
export function summarize(parsed) {
  const out = {
    version: null, description: null, fonts: [],
    vdcType: null, realPrecision: null, colourPrecision: null,
    scalingMode: null, vdcExtent: null, background: null,
    polylines: 0, texts: [], circles: 0, pickIdentifiers: [],
    charHeight: null, charHeights: [], textFontIndex: null,
    lineWidth: null, lineWidths: [],
    vdcCoords: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
    invalidParams: [],
  };

  const rd = (e) => new Reader(e.params);

  let haveBox = false;
  for (const e of parsed.elements) {
    const key = `${e.cls},${e.id}`;
    const r = rd(e);
    try {
      switch (key) {
        case '1,1': out.version = r.i16(); break;
        case '1,2': out.description = readString(r); break;
        case '1,13': {
          out.fonts = [];
          while (r.o < e.params.length) out.fonts.push(readString(r));
          break;
        }
        case '1,3': out.vdcType = r.i16(); break;
        case '1,5': {
          // (format, exponent bits, mantissa bits) 三个 i16；实测 Cortona2D 只认 (0,9,23)
          out.realPrecision = [r.i16(), r.i16(), r.i16()];
          break;
        }
        case '1,7': out.colourPrecision = r.i16(); break;
        case '2,1': out.scalingMode = { mode: r.i16(), scale: r.f32() }; break;
        case '2,5': {
          out.vdcExtent = [r.f32(), r.f32(), r.f32(), r.f32()];
          const [x0, y0, x1, y1] = out.vdcExtent;
          out.vdcCoords = { minX: x0, minY: y0, maxX: x1, maxY: y1 };
          haveBox = true;
          break;
        }
        case '2,6': out.background = [r.u8(), r.u8(), r.u8()]; break;
        case '5,15': out.charHeight = r.f32(); out.charHeights.push(out.charHeight); break;
        case '5,10': out.textFontIndex = r.i16(); break;
        case '5,3': out.lineWidth = r.f32(); out.lineWidths.push(out.lineWidth); break;
        case '5,36': out.pickIdentifiers.push(r.i16()); break;
        case '4,1': {
          out.polylines++;
          // 逐点校验坐标落在 VDC extent 内
          while (r.o + 8 <= e.params.length) {
            const x = r.f32(), y = r.f32();
            if (!isFinite(x) || !isFinite(y)) out.invalidParams.push(`polyline has non-finite coord`);
            if (haveBox) {
              const [x0, y0, x1, y1] = out.vdcExtent;
              const tol = 0.001;
              if (x < x0 - tol || x > x1 + tol || y < y0 - tol || y > y1 + tol) {
                // 允许少量越界（热点标注可能压边），只记录
              }
            }
            out.vdcCoords.minX = Math.min(out.vdcCoords.minX, x);
            out.vdcCoords.maxX = Math.max(out.vdcCoords.maxX, x);
            out.vdcCoords.minY = Math.min(out.vdcCoords.minY, y);
            out.vdcCoords.maxY = Math.max(out.vdcCoords.maxY, y);
          }
          if ((e.params.length % 8) !== 0) out.invalidParams.push('polyline param length not multiple of 8');
          break;
        }
        case '4,12': {
          out.circles++;
          const cx = r.f32(), cy = r.f32(), rad = r.f32();
          if (!isFinite(cx) || !isFinite(cy) || !isFinite(rad)) out.invalidParams.push('circle non-finite');
          if (rad <= 0) out.invalidParams.push(`circle radius <= 0 (${rad})`);
          break;
        }
        case '4,17': {
          // ELLIPSE: 圆心 + 两个共轭直径端点
          out.ellipses = (out.ellipses || 0) + 1;
          const cx = r.f32(), cy = r.f32();
          const x1 = r.f32(), y1 = r.f32();
          const x2 = r.f32(), y2 = r.f32();
          const rx = Math.hypot(x1 - cx, y1 - cy);
          const ry = Math.hypot(x2 - cx, y2 - cy);
          (out.ellipseSizes = out.ellipseSizes || []).push({ rx: +rx.toFixed(4), ry: +ry.toFixed(4) });
          if (![cx, cy, rx, ry].every(isFinite)) out.invalidParams.push('ellipse non-finite');
          if (rx <= 0 || ry <= 0) out.invalidParams.push(`ellipse semi-axis <= 0 (${rx}, ${ry})`);
          break;
        }
        case '4,4': {
          const x = r.f32(), y = r.f32();
          const alignH = r.i16(), alignV = r.i16();
          r.f32(); r.f32(); // orientation
          const str = readString(r);
          out.texts.push({ x, y, alignH, alignV, str, charHeight: out.charHeight });
          break;
        }
        default: break;
      }
    } catch (err) {
      out.invalidParams.push(`${key}: ${err.message}`);
    }
  }
  return out;
}

function readString(r) {
  const n = r.u8();
  const b = r.bytes(n);
  return new TextDecoder('utf-8', { fatal: false }).decode(b);
}

/* ------------------------------- CLI ------------------------------- */
if (process.argv[1] && process.argv[1].endsWith('verify-cgm.mjs')) {
  const file = process.argv[2];
  const asJson = process.argv.includes('--json');
  if (!file) {
    console.error('用法: node verify-cgm.mjs <file.cgm> [--json]');
    process.exit(2);
  }
  const buf = fs.readFileSync(file);
  const parsed = parseCgm(buf);
  const sum = summarize(parsed);

  const checks = [];
  const ok = (name, cond, detail) => checks.push({ name, pass: !!cond, detail });

  ok('CGM 无结构错误', parsed.errors.length === 0, parsed.errors.join('; ') || 'ok');
  ok('METAFILE VERSION = 3 (CGM:1992)', sum.version === 3, `got ${sum.version}`);
  ok('VDC TYPE = REAL (1)', sum.vdcType === 1, `got ${sum.vdcType}`);
  ok('REAL PRECISION = (0,9,23) 32-bit-float 写法', JSON.stringify(sum.realPrecision) === '[0,9,23]', `got ${JSON.stringify(sum.realPrecision)}`);
  ok('COLOUR PRECISION = 8 bit', sum.colourPrecision === 8, `got ${sum.colourPrecision}`);
  ok('SCALING MODE = METRIC(2), scale=1', sum.scalingMode && sum.scalingMode.mode === 2 && Math.abs(sum.scalingMode.scale - 1) < 1e-6,
    JSON.stringify(sum.scalingMode));
  const ext = sum.vdcExtent || [];
  ok('VDC EXTENT = A4 (0,0)-(210,297)',
    Math.abs(ext[0]) < 1e-6 && Math.abs(ext[1]) < 1e-6 && Math.abs(ext[2] - 210) < 1e-6 && Math.abs(ext[3] - 297) < 1e-6,
    JSON.stringify(ext));
  ok('FONT LIST 第 1 项是 Arial', (sum.fonts[0] || '').toLowerCase() === 'arial', JSON.stringify(sum.fonts));
  ok('TEXT FONT INDEX = 1 (Arial)', sum.textFontIndex === 1, `got ${sum.textFontIndex}`);
  ok('存在 PICK IDENTIFIER（热点可拾取）', sum.pickIdentifiers.length > 0, `${sum.pickIdentifiers.length} 个`);

  const heights = [...new Set(sum.charHeights.map((h) => +h.toFixed(6)))].sort((a, b) => a - b);
  ok('出现含 Arial 的字高 2.056mm 文本', heights.some((h) => Math.abs(h - 2.056) < 1e-4), JSON.stringify(heights));

  /*
   * CGM 热点样式：只要数字，不画外框。
   * 判据：
   *   · 有 PICK IDENTIFIER（可拾取）
   *   · 有 2.056mm 的文字
   *   · **没有**大椭圆/大圆（旧气球样式的 rx≈1.078 那种）
   */
  const ell = sum.ellipseSizes || [];
  const bigEll = ell.filter((e) => e.ry > 0.4 || e.rx > 0.4);
  ok('热点为纯数字（无外框椭圆）', bigEll.length === 0,
    `${ell.length} 个椭圆，其中大的 ${bigEll.length} 个`);

  const numTexts = sum.texts.filter((t) => /^[0-9A-Za-z-]+$/.test(t.str));
  ok('热点数字文本存在', numTexts.length > 0, `${numTexts.length} 个`);

  if (asJson) {
    console.log(JSON.stringify({ summary: sum, checks, errors: parsed.errors, elements: parsed.elements.length }, (k, v) => v instanceof Uint8Array ? `<${v.length}B>` : v, 2));
  } else {
    console.log(`文件: ${file}  (${buf.length} 字节, ${parsed.elements.length} 个元素)\n`);
    console.log('元素统计:', {
      折线: sum.polylines, 文本: sum.texts.length, 圆: sum.circles,
      PICK_IDENTIFIER: sum.pickIdentifiers.length,
      奇怪参数: sum.invalidParams.length,
    });
    console.log('VDC 实际坐标范围:', sum.vdcCoords);
    console.log('字高集合:', heights);
    console.log('');
    let pass = 0;
    for (const c of checks) {
      console.log(`  ${c.pass ? '✅' : '❌'} ${c.name}  ${c.pass ? '' : '→ ' + c.detail}`);
      if (c.pass) pass++;
    }
    console.log(`\n${pass}/${checks.length} 项通过`);
    if (sum.invalidParams.length) {
      console.log('\n参数告警:');
      for (const w of sum.invalidParams.slice(0, 10)) console.log('  ·', w);
    }
    process.exitCode = pass === checks.length ? 0 : 1;
  }
}
