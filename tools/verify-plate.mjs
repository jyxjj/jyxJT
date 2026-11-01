/**
 * verify-plate.mjs —— 图册规格校验（对齐 HTEAM-04021 模板）
 *
 * 独立解析 CGM，检查"长得像不像模板"的硬指标：
 *   1. A4 竖版 210×297、METRIC、1 VDC = 1mm
 *   2. 只有 Arial，热点数字字高 2.056mm，图册号字高 4.91mm
 *   3. 每个热点数字前都有 PICK IDENTIFIER（CGM 里可拾取）
 *   4. 热点引线**全程正交**（没有斜线），长度 5.16mm，端点离数字边 1.0mm
 *   5. 引线端点落在零件轮廓上（不是悬空）
 *   6. 没有图框 / 图例 / 分格标题 / 端点小圆（模板里都没有）
 *   7. 图册号在左上角（x≈9.7，基线 y≈280）
 *
 * 用法：
 *   node tools/verify-plate.mjs out/HTEAM-04021.cgm [--no HTEAM-04021]
 */

import fs from 'node:fs';

/* 与 drawing.js 的 PLATE 常量保持一致（改一边要改另一边） */
const SPEC = {
  leader: 5.16,
  gap: 1.0,
  charHeight: 2.056,
  titleHeight: 4.91,
  titleX: 9.7,
  titleY: 280.0,
  area: { x0: 17.5, y0: 101.9, x1: 202.0, y1: 215.3 },
};

const NAME = {
  '0,1': 'BEGIN_METAFILE', '0,2': 'END_METAFILE', '0,3': 'BEGIN_PICTURE',
  '0,4': 'BEGIN_PICTURE_BODY', '0,5': 'END_PICTURE',
  '1,1': 'METAFILE_VERSION', '1,2': 'METAFILE_DESCRIPTION', '1,3': 'VDC_TYPE',
  '1,4': 'INTEGER_PRECISION', '1,5': 'REAL_PRECISION', '1,6': 'INDEX_PRECISION',
  '1,7': 'COLOUR_PRECISION', '1,13': 'FONT_LIST',
  '2,1': 'SCALING_MODE', '2,2': 'COLOUR_SELECTION_MODE', '2,5': 'VDC_EXTENT',
  '2,6': 'BACKGROUND_COLOUR',
  '4,1': 'POLYLINE', '4,2': 'DISJOINT_POLYLINE', '4,4': 'TEXT', '4,7': 'POLYGON',
  '4,12': 'CIRCLE', '4,17': 'ELLIPSE',
  '5,3': 'LINE_WIDTH', '5,4': 'LINE_COLOUR', '5,10': 'TEXT_FONT_INDEX',
  '5,14': 'TEXT_COLOUR', '5,15': 'CHARACTER_HEIGHT', '5,18': 'TEXT_ALIGNMENT',
  '5,36': 'PICK_IDENTIFIER',
};

/** 按 ISO/IEC 8632-3 逐元素切开（含 16 位对齐补齐） */
function elements(buf) {
  const out = [];
  let o = 0;
  while (o + 2 <= buf.length) {
    const off = o;
    const w = (buf[o] << 8) | buf[o + 1];
    o += 2;
    const cls = (w >> 12) & 0xf;
    const id = (w >> 5) & 0x7f;
    let len = w & 0x1f;
    if (len === 31) {
      len = (buf[o] << 8) | buf[o + 1];
      o += 2;
    }
    const params = buf.subarray(o, o + len);
    o += len + (len & 1);
    out.push({ cls, id, key: `${cls},${id}`, name: NAME[`${cls},${id}`] || `${cls},${id}`, params });
  }
  return out;
}

function main() {
  const file = process.argv[2];
  const noIdx = process.argv.indexOf('--no');
  const drawingNo = noIdx > 0 ? process.argv[noIdx + 1] : '';
  if (!file) {
    console.error('用法: node tools/verify-plate.mjs <file.cgm> [--no HTEAM-04021]');
    process.exit(2);
  }
  const buf = fs.readFileSync(file);
  const els = elements(buf);

  let vdcType = 1;
  let realPrecBytes = 4;
  const polylines = [];
  const disjoint = [];
  const texts = [];
  const picks = [];
  let circles = 0;
  let ellipses = 0;
  let extent = null;
  let scaling = null;
  let fonts = [];
  let charHeight = null;
  let pendingPick = null;

  const r32 = (p, k) => {
    const dv = new DataView(p.buffer, p.byteOffset + k, 4);
    return dv.getFloat32(0, false);
  };
  const ri16 = (p, k) => {
    const v = (p[k] << 8) | p[k + 1];
    return v & 0x8000 ? v - 0x10000 : v;
  };

  for (const e of els) {
    switch (e.key) {
      case '1,3': vdcType = ri16(e.params, 0); break;
      // REAL PRECISION: 0=32 定长, 1=32 浮点, 2=64 定长, 3=64 浮点
      case '1,5': realPrecBytes = ri16(e.params, 0) >= 2 ? 8 : 4; break;
      case '2,1': scaling = { mode: ri16(e.params, 0), scale: r32(e.params, 2) }; break;
      case '2,5': extent = [r32(e.params, 0), r32(e.params, 4), r32(e.params, 8), r32(e.params, 12)]; break;
      case '1,13': {
        fonts = [];
        let k = 0;
        while (k < e.params.length) {
          const n = e.params[k++];
          fonts.push(e.params.subarray(k, k + n).toString('utf8'));
          k += n + (n & 1);
        }
        break;
      }
      case '5,15': charHeight = r32(e.params, 0); break;
      case '5,36': pendingPick = ri16(e.params, 0); break;
      case '4,12': circles++; break;
      case '4,17': ellipses++; break;
      case '4,4': {
        // 参数：x(4) y(4) alignH(2) alignV(2) dx(4) dy(4) 字符串(1+n)
        //                                ↑ 共 4+4+2+2+4+4 = 20 字节
        const x = r32(e.params, 0);
        const y = r32(e.params, 4);
        const alignH = ri16(e.params, 8);
        const alignV = ri16(e.params, 10);
        const n = e.params[20];
        const str = e.params.subarray(21, 21 + n).toString('utf8');
        texts.push({ x, y, alignH, alignV, str, charHeight, pick: pendingPick });
        pendingPick = null;
        break;
      }
      case '4,1': {
        const n = Math.floor(e.params.length / (realPrecBytes * 2));
        const pts = [];
        for (let k = 0; k < n; k++) {
          pts.push([r32(e.params, k * realPrecBytes * 2), r32(e.params, k * realPrecBytes * 2 + 4)]);
        }
        polylines.push({ pts, pick: pendingPick });
        pendingPick = null;
        break;
      }
      case '4,2': {
        const n = Math.floor(e.params.length / (realPrecBytes * 2));
        const pts = [];
        for (let k = 0; k < n; k++) {
          pts.push([r32(e.params, k * realPrecBytes * 2), r32(e.params, k * realPrecBytes * 2 + 4)]);
        }
        disjoint.push(pts);
        break;
      }
      default: break;
    }
  }

  const checks = [];
  const ok = (name, cond, detail) => checks.push({ name, pass: !!cond, detail });

  ok('VDC TYPE = REAL, A4 (0,0)-(210,297)',
    vdcType === 1 && extent && Math.abs(extent[2] - 210) < 1e-6 && Math.abs(extent[3] - 297) < 1e-6,
    JSON.stringify(extent));
  ok('SCALING MODE = METRIC(2) scale=1',
    scaling && scaling.mode === 2 && Math.abs(scaling.scale - 1) < 1e-6, JSON.stringify(scaling));
  ok('FONT LIST 第 1 项是 Arial', fonts[0] === 'Arial', JSON.stringify(fonts));

  /* ---- 热点数字：2.056 字高 + 有 PICK ---- */
  const digits = texts.filter((t) => Math.abs(t.charHeight - SPEC.charHeight) < 1e-4);
  const digitsWithPick = digits.filter((t) => Number.isInteger(t.pick) && t.pick > 0);
  ok('热点数字字高 2.056mm', digits.length > 0, `${digits.length} 个`);
  ok('每个热点数字都带 PICK IDENTIFIER',
    digits.length > 0 && digitsWithPick.length === digits.length,
    `${digitsWithPick.length}/${digits.length}`);
  ok('热点数字内容 = 纯编号',
    digits.every((t) => /^[0-9A-Za-z][0-9A-Za-z-]*$/.test(t.str)),
    digits.filter((t) => !/^[0-9A-Za-z][0-9A-Za-z-]*$/.test(t.str)).slice(0, 3).map((t) => t.str).join(','));

  /* ---- 图册号 ---- */
  const title = texts.find((t) => t.str === (drawingNo || t.str) && Math.abs(t.charHeight - SPEC.titleHeight) < 1e-3)
    || texts.find((t) => Math.abs(t.charHeight - SPEC.titleHeight) < 1e-3);
  ok('图册号字高 4.91mm 且位于左上角',
    !!title && Math.abs(title.x - SPEC.titleX) < 0.6 && Math.abs(title.y - SPEC.titleY) < 0.6,
    title ? `"${title.str}" @ ${title.x},${title.y}` : '找不到 4.91mm 文字');
  ok('图册号文字 = 传入编号',
    !!title && (!drawingNo || title.str === drawingNo),
    title ? title.str : '');

  /* ---- 引线：正交 + 贴数字 1.0 + 未被挪动时正好 5.16 ---- */
  /* 引线 = 带 PICK 的短折线（2~3 个点）；几何线是不带 PICK 的长 disjoint 折线 */
  const leads = polylines
    .filter((p) => p.pick != null && p.pts.length >= 2 && p.pts.length <= 4)
    .map((p) => p.pts);

  // 热点数字按 PICK 建索引，配对不靠"最近的数字"（密集时会配错）
  const digitByPick = new Map(digits.filter((t) => t.pick != null).map((t) => [t.pick, t]));
  let slanted = 0;
  let badGap = 0;
  let straightLead = 0;
  let lShaped = 0;
  let badStraightLen = 0;
  let unpaired = 0;
  const gapErr = [];
  const lenErr = [];

  polylines
    .filter((p) => p.pick != null && p.pts.length >= 2 && p.pts.length <= 4)
    .forEach(({ pts: p, pick }) => {
      for (let i = 1; i < p.length; i++) {
        const dx = Math.abs(p[i][0] - p[i - 1][0]);
        const dy = Math.abs(p[i][1] - p[i - 1][1]);
        if (dx > 1e-6 && dy > 1e-6) slanted++;
      }
      const end = p[p.length - 1];
      const t = digitByPick.get(pick);
      if (!t) { unpaired++; return; }

      const halfW = textWidthMm(t.str, t.charHeight) / 2;
      const cx = t.alignH === 1 ? t.x : t.x + halfW;
      const cy = t.y + t.charHeight / 2;

      const horizontal = Math.abs(end[1] - cy) < 0.05;
      const gap = horizontal
        ? Math.abs(end[0] - cx) - halfW
        : Math.abs(end[1] - cy) - t.charHeight / 2;
      if (Math.abs(gap - SPEC.gap) > 0.05) { badGap++; gapErr.push(+gap.toFixed(2)); }

      // 两段 = 热点被密度挤开过（L 形）；单段 = 模板原样
      if (p.length === 2) {
        straightLead++;
        const L = lengthOf(p);
        if (Math.abs(L - SPEC.leader) > 0.02) { badStraightLen++; lenErr.push(+L.toFixed(2)); }
      } else {
        lShaped++;
      }
    });

  ok('每条引线都能按 PICK 对上热点数字', unpaired === 0, `${unpaired} 条对不上`);
  ok('引线数量 = 热点数字数量', leads.length === digits.length,
    `引线 ${leads.length}，数字 ${digits.length}`);
  ok('引线全程正交（无斜线）', slanted === 0, `${slanted} 段斜线`);
  ok(`引线端点离数字 ${SPEC.gap}mm`, badGap === 0,
    `${badGap} 条偏差，例: ${gapErr.slice(0, 5).join(',')}`);
  ok(`直的引线长度 = ${SPEC.leader}mm`, badStraightLen === 0,
    `${badStraightLen}/${straightLead} 条偏差，例: ${lenErr.slice(0, 5).join(',')}`);

  /* ---- 模板里没有的东西 ---- */
  ok('没有端点小圆 / 气球椭圆（模板样式）', circles === 0 && ellipses === 0,
    `circle=${circles} ellipse=${ellipses}`);
  ok('没有图例表（模板无图例）',
    !texts.some((t) => t.str === '编号' || t.str === '说明' || t.str === '数量'),
    '');

  /* ---- 图形落在模板的绘图区里 ---- */
  const gx = [];
  const gy = [];
  for (const seg of disjoint) {
    for (const [x, y] of seg) { gx.push(x); gy.push(y); }
  }
  const inArea = gx.length === 0 || (
    Math.min(...gx) >= SPEC.area.x0 - 1 && Math.max(...gx) <= SPEC.area.x1 + 1
    && Math.min(...gy) >= SPEC.area.y0 - 1 && Math.max(...gy) <= SPEC.area.y1 + 1
  );
  ok('图形落在模板绘图区内', inArea,
    gx.length ? `x ${Math.min(...gx).toFixed(1)}..${Math.max(...gx).toFixed(1)} y ${Math.min(...gy).toFixed(1)}..${Math.max(...gy).toFixed(1)}` : '无几何');

  let pass = 0;
  console.log(`文件: ${file}  (${buf.length} 字节, ${els.length} 个元素)\n`);
  console.log(`热点数字 ${digits.length} 个，引线 ${leads.length} 条，文本 ${texts.length} 个\n`);
  for (const c of checks) {
    console.log(`  ${c.pass ? '✅' : '❌'} ${c.name}${c.pass ? '' : '  → ' + c.detail}`);
    if (c.pass) pass++;
  }
  console.log(`\n${pass}/${checks.length} 项通过`);
  process.exitCode = pass === checks.length ? 0 : 1;
}

function lengthOf(p) {
  let s = 0;
  for (let i = 1; i < p.length; i++) s += Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]);
  return s;
}

/** Arial 数字宽度（mm），与 drawing.js 的 textWidth 一致 */
function textWidthMm(str, charHeight) {
  const em = charHeight / 0.716;
  return String(str).length * 0.556 * em;
}

main();

