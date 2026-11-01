/**
 * sheetcgm.js —— 把 drawing.js 的图层中间表示写成 CGM 文件
 *
 * 输出特征：
 *   · A4 = 210 × 297 mm，VDC extent 就是 (0,0)-(210,297)，SCALING MODE = METRIC，
 *     所以 1 VDC 单位 = 1 mm，图纸按 1:1 打出来尺寸就准。
 *   · 字体表只有 Arial（font index 1）。
 *   · 每个热点先写 PICK_IDENTIFIER 再写圆，这样 CAD/CGM 查看器里点热点能拿到编号；
 *     热点圆 = 文字外框各方向 +0.05 mm（见 drawing.js 的 HOTSPOT.inflate）。
 */

import { CgmWriter, EL, ENUM } from './cgm.js';

const FONT_ARIAL = 1;

/**
 * 元素 → CGM
 *
 * 多页支持：sheetData.pages 每个元素写成一个 PICTURE（CGM 允许一个 metafile 里
 * 放多个 picture，查看器按页切换）。
 */
export function sheetToCgm(sheetData, opts = {}) {
  const { items, hotspots, sheet } = sheetData;
  const pages = sheetData.pages && sheetData.pages.length
    ? sheetData.pages
    : [{ items, hotspots }];
  const w = new CgmWriter({ coord: 'f32' });

  w.beginMetafile(opts.metafileName || 'jtbrowser.cgm');
  w.fontList(['Arial']);

  pages.forEach((page, pageIndex) => {
    writePicture(w, page.items, page.hotspots, sheet, {
      pictureName: (opts.pictureName || 'A4_2D_LINE_DRAWING') + (pages.length > 1 ? `_P${pageIndex + 1}` : ''),
      // 图册模式：数字（带 PICK IDENTIFIER）和直引线已经在 items 里了，
      // 不能再走下面的热点循环，否则会重复写字、还多画一圈端点小圆。
      plate: opts.plate ?? sheetData.plate ?? false,
    });
  });

  w.endMetafile();
  return w;
}

/** 把一页写进 CGM */
function writePicture(w, items, hotspots, sheet, opts = {}) {
  w.beginPicture(
    opts.pictureName || 'A4_2D_LINE_DRAWING',
    [0, 0, sheet.width, sheet.height],
    { background: null }
  );

  // 默认属性
  w.el(EL.LINE_WIDTH, w.p().f32(0.18));
  w.el(EL.LINE_COLOUR, w.p().rgb(0, 0, 0));
  w.el(EL.TEXT_FONT_INDEX, w.p().i16(FONT_ARIAL));
  w.el(EL.TEXT_COLOUR, w.p().rgb(0, 0, 0));
  w.el(EL.CHARACTER_EXPANSION_FACTOR, w.p().f32(1.0));
  w.el(EL.EDGE_VISIBILITY, w.p().i16(ENUM.EDGE_OFF));
  w.el(EL.INTERIOR_STYLE, w.p().i16(ENUM.INTERIOR_HOLLOW));
  w.el(EL.CHARACTER_ORIENTATION, w.p().f32(0).f32(1).f32(-1).f32(0));

  for (const it of items) {
    const c = it.color || [0, 0, 0];
    const rgb = [Math.round(c[0] * 255), Math.round(c[1] * 255), Math.round(c[2] * 255)];

    // 带 pick 的元素：先写 PICK IDENTIFIER，查看器里点上去能拿到热点编号。
    // 图册模式下数字和它的引线都带同一个 pick，拾取范围覆盖整套标注。
    if (it.pick != null) {
      const n = Number(it.pick);
      if (Number.isInteger(n) && n > 0 && n < 32767) {
        w.el(EL.PICK_IDENTIFIER, w.p().i16(n));
      }
    } else if (opts.plate && it.kind === 'polyline' && it.leadFor != null) {
      w.el(EL.PICK_IDENTIFIER, w.p().i16(Number(it.leadFor)));
    }

    if (it.kind === 'polyline') {
      w.el(EL.LINE_WIDTH, w.p().f32(it.width ?? 0.18));
      w.el(EL.LINE_COLOUR, w.p().rgb(...rgb));
      /*
       * LINE TYPE 只在虚线项时写（ISO 8632：3 = dot）。
       * 实线不写 —— 默认线型就是 1，写一堆 LINE TYPE 1 属于冗余元素，
       * 而且实测会让部分查看器（Cortona2D）渲染异常。
       */
      if (it.dash) w.el(EL.LINE_TYPE, w.p().i16(3));
      // 棱边用 DISJOINT POLYLINE（每两点一段，互不相连）；
      // 图框/热点引线这类真正连续的线才用 POLYLINE。
      if (it.disjoint) w.disjointPolyline(it.pts);
      else w.polyline(it.pts);
      // 虚线用完立刻恢复实线，后面的图框/引线不受影响
      if (it.dash) w.el(EL.LINE_TYPE, w.p().i16(1));
    } else if (it.kind === 'ellipse') {
      // 热点轮廓是"数字外框 +0.05mm"的椭圆，长宽比通常不等于 1，
      // 所以用 CGM 原生 ELLIPSE（三个共轭直径参数），不用折线近似。
      w.el(EL.LINE_WIDTH, w.p().f32(it.width ?? 0.25));
      w.el(EL.LINE_COLOUR, w.p().rgb(...rgb));
      const ratio = it.rx / Math.max(it.ry, 1e-9);
      if (Math.abs(ratio - 1) < 0.02) {
        w.circle(it.cx, it.cy, (it.rx + it.ry) / 2);
      } else {
        w.ellipse(it.cx, it.cy, it.rx, it.ry);
      }
    } else if (it.kind === 'text') {
      w.el(EL.TEXT_COLOUR, w.p().rgb(...rgb));
      w.el(EL.CHARACTER_HEIGHT, w.p().f32(it.height));
      w.el(EL.CHARACTER_EXPANSION_FACTOR, w.p().f32(1.0));
      w.text(it.x, it.y, it.str, it.alignH ?? ENUM.TEXT_CENTRE, it.alignV ?? ENUM.TEXT_CAP);
    }
  }

  /*
   * 热点：CGM 语义下的热点 = 文字 + PICK IDENTIFIER（不画外圈）。
   * 查看器里点在数字上就能拿到编号；引线是横平竖直的折线。
   *
   * 图册模式跳过：那一版的热点（数字 + 直引线、带 PICK IDENTIFIER）
   * 已经作为 item 写进去了，再写一遍就会叠字。
   */
  for (const hs of (opts.plate ? [] : (hotspots || []))) {
    w.el(EL.PICK_IDENTIFIER, w.p().i16(hs.label));

    // 引线（先横后竖）：零件锚点 → 折点 → 数字接点
    w.el(EL.LINE_WIDTH, w.p().f32(0.16));
    w.el(EL.LINE_COLOUR, w.p().rgb(0, 0, 0));
    const ex = hs.ex ?? hs.tx;
    const ey = hs.ey ?? hs.ty;
    w.polyline([hs.ax, hs.ay, ex, hs.ay, ex, ey]);
    w.circle(hs.ax, hs.ay, 0.12);

    // 数字
    w.el(EL.TEXT_COLOUR, w.p().rgb(0, 0, 0));
    w.el(EL.CHARACTER_HEIGHT, w.p().f32(hs.charHeight ?? 2.056));
    w.el(EL.TEXT_FONT_INDEX, w.p().i16(FONT_ARIAL));
    w.el(EL.CHARACTER_EXPANSION_FACTOR, w.p().f32(1.0));
    w.text(hs.cx, hs.cy - (hs.charHeight ?? 2.056) / 2, String(hs.label),
      ENUM.TEXT_CENTRE, ENUM.TEXT_BASE);
  }

  w.endPicture();
  return w;
}

export function downloadCgm(sheetData, filename) {
  const w = sheetToCgm(sheetData);
  const blob = w.toBlob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename || 'drawing.cgm';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  return blob.size;
}
