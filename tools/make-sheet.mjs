/**
 * 分组 → 热点 → 出图 的一站式命令行入口
 *
 * 用法：
 *   node tools\make-sheet.mjs <mesh.json> <out.cgm> [选项]
 *
 * 选项：
 *   --sheet  <分组表.xlsx|csv>   Excel/CSV 分组表；给了就按表出热点并画图例
 *   --mode   grid|single         版面（默认 grid，分格）
 *   --view   iso|front|top|right 观察方向（默认 iso）
 *   --angle  <deg>               特征边二面角阈值（默认 25）
 *   --hlr    0|1                 是否做隐藏线消除（默认 1）
 *   --res    <px>                HLR 深度图分辨率（默认 1400）
 *   --no-legend                  不画热点图例表
 *   --report                     打印匹配报告
 *   --svg                        同时输出 SVG
 *   --plate                      图册版面（对齐 HTEAM-04021：整机单视图、无图框、
 *                                左上角写图册号、热点=数字+短引线）
 *   --no                        <HTEAM-04021>  图册号（决定页面上的编号与 metafile 名）
 */

import fs from 'node:fs';
import path from 'node:path';
import * as THREE from 'three';
import {
  collectGroups, projectGroup, removeHiddenLines, buildSheet, sheetToSVGMultiPage, PLATE,
} from '../static/js/drawing.js';
import { sheetToCgm } from '../static/js/sheetcgm.js';
import { readWorkbook } from '../static/js/xlsx.js';
import { matchSheet, formatReport } from '../static/js/hotspot-map.js';

const args = process.argv.slice(2);
const flag = (n) => args.includes('--' + n);
const opt = (n, d) => {
  const i = args.indexOf('--' + n);
  return i >= 0 && args[i + 1] != null && !args[i + 1].startsWith('--') ? args[i + 1] : d;
};

const inJson = args[0];
const outCgm = args[1];
if (!inJson || !outCgm || inJson.startsWith('--')) {
  console.error('用法: node make-sheet.mjs <mesh.json> <out.cgm> [--sheet x.xlsx] [--mode grid|single] [--view iso|front|top|right]');
  process.exit(2);
}

const mode = opt('mode', 'grid');
const view = opt('view', 'iso');
const angle = Number(opt('angle', '25'));
const useHlr = opt('hlr', '1') !== '0';
const res = Number(opt('res', '1400'));
const sheetPath = opt('sheet', '');
const wantSvg = flag('svg') || true; // 默认也出 SVG，便于核对
const usePlate = flag('plate');
const drawingNo = opt('no', '');

const data = JSON.parse(fs.readFileSync(inJson, 'utf8'));

/* ---------- 重建 three 对象 ---------- */
const meshRecords = new Map();
for (const part of data.parts) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(part.positions, 3));
  geo.setIndex(new THREE.Uint32BufferAttribute(part.indices, 1));
  const body = new THREE.Mesh(geo, new THREE.MeshBasicMaterial());
  body.updateMatrixWorld(true);
  meshRecords.set(part.key, { body, key: part.key });
}

/* ---------- 观察方向 ---------- */
const CAM = {
  iso: [0.9, 0.72, 1.0],
  front: [0, 0, 1],
  top: [0, 1, 0.0001],
  right: [1, 0, 0.0001],
};
const dir = new THREE.Vector3(...(CAM[view] || CAM.iso)).normalize();
const upHint = Math.abs(dir.y) > 0.999 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0);
const right = new THREE.Vector3().crossVectors(dir, upHint).normalize();
const up = new THREE.Vector3().crossVectors(right, dir).normalize();
const basis = { dir, right, up };

/* ---------- 分组 ---------- */
const groups = collectGroups(data.tree);
console.log(`分组 ${groups.length} 个`);

/* ---------- 每组建边并投影（可选消隐） ---------- */
const edgesByGroup = new Map();
let totalSegs = 0;
const t0 = Date.now();
for (const g of groups) {
  const proj = projectGroup(meshRecords, g.leafKeys, basis, angle);
  const uv = useHlr ? removeHiddenLines(proj, { res }) : proj.edges.uv;
  if (uv.length < 4) continue;
  totalSegs += uv.length / 4;
  edgesByGroup.set(g.key, uv);
}
console.log(`有效分组 ${edgesByGroup.size} 个，线段 ${totalSegs} 条，耗时 ${Date.now() - t0}ms`);

/* ---------- Excel 匹配 ---------- */
let hotspotByGroup = null;
let matchResult = null;
if (sheetPath) {
  if (!fs.existsSync(sheetPath)) {
    console.error(`找不到分组表: ${sheetPath}`);
    process.exit(1);
  }
  const buf = fs.readFileSync(sheetPath);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const wb = await readWorkbook(ab, path.basename(sheetPath));
  const sheet = wb.sheets[0];
  console.log(`分组表: ${path.basename(sheetPath)}  工作表「${sheet.name}」  ${sheet.rows.length} 行`);

  matchResult = matchSheet(groups, sheet.rows, {});
  console.log(`列映射: 分组名=${colLetter(matchResult.columns.name)}`
    + `  编号=${matchResult.columns.label >= 0 ? colLetter(matchResult.columns.label) : '(无)'}`
    + `  说明=${matchResult.columns.title >= 0 ? colLetter(matchResult.columns.title) : '(无)'}`
    + `  数量=${matchResult.columns.qty >= 0 ? colLetter(matchResult.columns.qty) : '(无)'}`);
  console.log(`识别到表头: ${matchResult.header.map((h) => String(h || '')).join(' | ')}`);

  hotspotByGroup = new Map();
  for (const h of matchResult.hotspots) {
    // 一行 Excel 可能命中多个同名分组（如 10 个 screw），每个分组都挂上这个热点
    const keys = h.groupKeys && h.groupKeys.length ? h.groupKeys : [h.groupKey];
    for (const k of keys) {
      if (!hotspotByGroup.has(k)) hotspotByGroup.set(k, []);
      hotspotByGroup.get(k).push(h);
    }
  }
  const coveredGroups = hotspotByGroup.size;
  console.log(`热点 ${matchResult.hotspots.length} 条，覆盖分组 ${coveredGroups} 个`);
  if (flag('report')) {
    console.log('\n--- 匹配报告 ---');
    console.log(formatReport(matchResult));
    console.log('---------------\n');
  } else {
    console.log(`热点 ${matchResult.hotspots.length} 个，`
      + `未匹配行 ${matchResult.unmatchedRows.length}，无热点分组 ${matchResult.unmatchedGroups.length}`);
    for (const f of matchResult.hotspots.filter((h) => h.matchType === 'fuzzy' || h.matchType === 'contains').slice(0, 8)) {
      console.log(`  模糊: 行${f.rowIndex + 1} 「${f.excelName}」→「${f.groupName}」 ${(f.matchScore * 100).toFixed(0)}%`);
    }
  }
} else {
  console.log('未给 --sheet，热点按顺序自动编号');
}

/* ---------- 出图 ---------- */
const sheetData = buildSheet(groups, {
  mode,
  edgesByGroup,
  sheet: { width: 210, height: 297 },
  sourceName: data.name || 'JT Model',
  hotspotByGroup,
  labelUnmatched: flag('label-unmatched'),
  drawLegend: !flag('no-legend'),
  drawBorder: flag('border'),
  drawTitleBlock: flag('title'),
  plate: usePlate,
  drawingNo,
});

fs.writeFileSync(outCgm, sheetToCgm(sheetData, { metafileName: path.basename(outCgm) }).toUint8Array());
console.log(`写入 ${outCgm}  ${fs.statSync(outCgm).size} 字节`);

if (wantSvg) {
  const svgPath = outCgm.replace(/\.cgm$/i, '') + '.svg';
  fs.writeFileSync(svgPath, sheetToSVGMultiPage(sheetData), 'utf8');
  console.log(`预览 ${svgPath}`);
}

console.log(`页数 ${sheetData.pageCount}，图层元素 ${sheetData.items.length}，热点 ${sheetData.hotspots.length}`);

/* 列号 → A/B/C… */
function colLetter(i) {
  if (i == null || i < 0) return '(无)';
  let s = '';
  let n = i;
  do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0);
  return s;
}
