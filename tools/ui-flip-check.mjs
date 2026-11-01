/**
 * ui-flip-check.mjs —— 免配对分布检验：A4 线条点云 vs 3D 屏幕投影点云
 * 2D 直方图 Pearson 相关：r_x<0=左右镜像；r_y<0=上下颠倒
 * 用法: node tools/ui-flip-check.mjs [jt路径] [view]
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9342;
const APP = 'http://127.0.0.1:8770/';
const JT = process.argv[2] || 'D:\\JT\\sample\\07_engine_4cyl_inline_assembly_step.jt';
const VIEW = process.argv[3] || 'iso';

const profile = fs.mkdtempSync('D:\\JT\\webjt\\_test\\edge-');
const edge = spawn(EDGE, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--disable-gpu', '--no-first-run', '--window-size=1600,1000', APP + '?open=' + encodeURIComponent(JT),
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getJson(path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path }, (res) => {
      let s = '';
      res.on('data', (c) => { s += c; });
      res.on('end', () => { try { resolve(JSON.parse(s)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

async function main() {
  let targets = null;
  for (let i = 0; i < 60; i++) {
    try { targets = await getJson('/json/list'); break; } catch { await sleep(500); }
  }
  if (!targets) throw new Error('Edge 没起来');
  const page = targets.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg.result); pending.delete(msg.id); }
  });
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  const send = (method, params = {}) => new Promise((resolve) => {
    const mid = ++id; pending.set(mid, resolve);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    return r.result && r.result.value;
  };

  await send('Page.enable');
  await send('Runtime.enable');
  for (let i = 0; i < 300; i++) {
    const st = await evalJs('window.__jtState ? JSON.stringify(window.__jtState()) : null');
    if (st && JSON.parse(st).loaded > 0) break;
    await sleep(500);
  }
  let last = -1, stable = 0;
  for (let i = 0; i < 360 && stable < 6; i++) {
    const st = await evalJs('window.__jtState ? window.__jtState().loaded : 0');
    if (st === last) stable++; else { stable = 0; last = st; }
    await sleep(500);
  }
  await evalJs('window.__jtFit ? window.__jtFit() : 0');
  await sleep(800);

  await evalJs(`(() => {
    document.getElementById('btnSheet').click();
    const p = document.getElementById('spPlate');
    p.checked = true; p.dispatchEvent(new Event('change'));
    document.getElementById('spDrawingNo').value = 'T';
    document.querySelector('#spView [data-view="${VIEW}"]').click();
    document.getElementById('spPreview').click();
    return 1;
  })()`);
  for (let i = 0; i < 300; i++) {
    await sleep(400);
    if (await evalJs('window.__sp && window.__sp.sheetData ? 1 : 0')) break;
  }

  const r = await evalJs(`(() => {
    try {
    const { THREE, camera, S } = window.__jt;
    const sd = window.__sp.sheetData;
    // A4 点云：所有 polyline 顶点（跳过热点引线/图例）
    const a4 = [];
    const items = (sd.pages && sd.pages[0] && sd.pages[0].items) || sd.items || [];
    for (const it of items) {
      if (it.kind !== 'polyline' || it.leadFor || it.link) continue;
      for (let k = 0; k < it.pts.length; k += 2) a4.push([it.pts[k], it.pts[k + 1]]);
    }
    // 世界点云：所有可见 body 顶点（抽样），投影到屏幕（y 向下）
    const viewEl = document.getElementById('view');
    const vw = viewEl.clientWidth, vh = viewEl.clientHeight;
    const scr = [];
    for (const [, rec] of S.meshes) {
      if (!rec || !rec.body || !rec.body.visible) continue;
      const geo = rec.body.geometry;
      const pos = geo.attributes && geo.attributes.position;
      if (!pos) continue;
      rec.body.updateWorldMatrix(true, false);
      const e = rec.body.matrixWorld.elements;
      const v = new THREE.Vector3();
      const step = Math.max(1, Math.floor(pos.count / 400));
      for (let i = 0; i < pos.count; i += step) {
        v.fromBufferAttribute(pos, i).applyMatrix4(rec.body.matrixWorld).project(camera);
        scr.push([(v.x * 0.5 + 0.5) * vw, (1 - (v.y * 0.5 + 0.5)) * vh]);
      }
    }
    // 归一化
    const nrm = (c) => {
      let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
      for (const p of c) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); }
      return c.map(p => [(p[0] - x0) / Math.max(x1 - x0, 1e-9), (p[1] - y0) / Math.max(y1 - y0, 1e-9)]);
    };
    const A = nrm(a4), B = nrm(scr);   // A: v 向上; B: v 向下
    // 2D 直方图 24x24；B 的 v 取 1-v 转成向上后对比
    const N = 24;
    const hist = (c, flipV) => {
      const h = new Float64Array(N * N);
      for (const [u, v] of c) {
        const iu = Math.min(N - 1, Math.max(0, Math.floor(u * N)));
        const iv = Math.min(N - 1, Math.max(0, Math.floor((flipV ? 1 - v : v) * N)));
        h[iv * N + iu]++;
      }
      return h;
    };
    const hA = hist(A, false), hB = hist(B, true);
    const mean = (h) => h.reduce((s, x) => s + x, 0) / h.length;
    const corr = (h1, h2) => {
      const m1 = mean(h1), m2 = mean(h2);
      let num = 0, d1 = 0, d2 = 0;
      for (let i = 0; i < h1.length; i++) {
        num += (h1[i] - m1) * (h2[i] - m2);
        d1 += (h1[i] - m1) ** 2; d2 += (h2[i] - m2) ** 2;
      }
      return num / Math.sqrt(Math.max(d1 * d2, 1e-12));
    };
    // x 相关 / y 相关（把 2D 压到一维轴上算更稳）
    const axis = (h, alongX) => {
      const out = new Float64Array(N);
      for (let iv = 0; iv < N; iv++) for (let iu = 0; iu < N; iu++) out[alongX ? iu : iv] += h[iv * N + iu];
      return out;
    };
    const corrAxis = (a1, a2) => {
      const m1 = a1.reduce((s, x) => s + x, 0) / N, m2 = a2.reduce((s, x) => s + x, 0) / N;
      let num = 0, d1 = 0, d2 = 0;
      for (let i = 0; i < N; i++) { num += (a1[i] - m1) * (a2[i] - m2); d1 += (a1[i] - m1) ** 2; d2 += (a2[i] - m2) ** 2; }
      return num / Math.sqrt(Math.max(d1 * d2, 1e-12));
    };
    const rX = corrAxis(axis(hA, true), axis(hB, true));
    const rY = corrAxis(axis(hA, false), axis(hB, false));
    return JSON.stringify({ nA4: a4.length, nScr: scr.length, rX: +rX.toFixed(3), rY: +rY.toFixed(3),
      verdict: (rX > 0.5 ? 'x OK' : 'x MIRRORED') + ' / ' + (rY > 0.5 ? 'y OK' : 'y FLIPPED') });
    } catch (err) { return JSON.stringify({ error: String(err && err.message || err) }); }
  })()`);
  console.log(VIEW, r);

  ws.close();
  edge.kill();
}

main().then(() => process.exit(0)).catch((e) => { console.error('FAIL', e.message); edge.kill(); process.exit(1); });
