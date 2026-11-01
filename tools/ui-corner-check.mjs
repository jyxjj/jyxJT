/**
 * ui-corner-check.mjs —— 角点落位检验（对形状不对称仍有效的免配对法）
 * 取世界包围盒 8 角 + 若干内部参考点，投影到屏幕（y 下）；
 * A4 线条点云归一化；比较两个点云沿 x 与 y 的"分位数指纹"是否同序：
 *   对每个角点，算它在屏幕点云中的 u/v 百分位，再算 A4 点云同一物体
 *   （同投影基）的对应…角点无对应物，改为：
 *   直接比较两个点云的一维 CDF 形状（KS 统计量 + 符号），并镜像/翻转
 *   两种变换哪个能把 CDF 距离降得更低。
 * 判定：flipX 后距离显著下降 → 左右镜像；flipY 后显著下降 → 上下颠倒。
 * 用法: node tools/ui-corner-check.mjs [jt路径] [view]
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9343;
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
    const a4 = [];
    const items = (sd.pages && sd.pages[0] && sd.pages[0].items) || sd.items || [];
    for (const it of items) {
      if (it.kind !== 'polyline' || it.leadFor || it.link) continue;
      for (let k = 0; k < it.pts.length; k += 2) a4.push([it.pts[k], it.pts[k + 1]]);
    }
    const viewEl = document.getElementById('view');
    const vw = viewEl.clientWidth, vh = viewEl.clientHeight;
    const scr = [];
    for (const [, rec] of S.meshes) {
      if (!rec || !rec.body || !rec.body.visible) continue;
      const pos = rec.body.geometry.attributes && rec.body.geometry.attributes.position;
      if (!pos) continue;
      rec.body.updateWorldMatrix(true, false);
      const v = new THREE.Vector3();
      const step = Math.max(1, Math.floor(pos.count / 300));
      for (let i = 0; i < pos.count; i += step) {
        v.fromBufferAttribute(pos, i).applyMatrix4(rec.body.matrixWorld).project(camera);
        scr.push([(v.x * 0.5 + 0.5) * vw, (1 - (v.y * 0.5 + 0.5)) * vh]);
      }
    }
    // 一维值域归一化后的 EMD（Wasserstein-1 的离散近似，分位距平均）
    const quant = (vals, q) => { const a = [...vals].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.max(0, Math.floor(q * a.length)))]; };
    const nrmAxis = (vals) => { const lo = quant(vals, 0.001), hi = quant(vals, 0.999); return vals.map(v => (v - lo) / Math.max(hi - lo, 1e-9)); };
    const emd = (a, b) => {
      const N = 64, h1 = new Float64Array(N), h2 = new Float64Array(N);
      for (const v of a) { const i = Math.min(N - 1, Math.max(0, Math.floor(v * N))); h1[i]++; }
      for (const v of b) { const i = Math.min(N - 1, Math.max(0, Math.floor(v * N))); h2[i]++; }
      let d = 0, c1 = 0, c2 = 0;
      const s1 = a.length, s2 = b.length;
      for (let i = 0; i < N; i++) { c1 += h1[i] / s1; c2 += h2[i] / s2; d += Math.abs(c1 - c2); }
      return d;
    };
    const au = nrmAxis(a4.map(p => p[0])), av = nrmAxis(a4.map(p => p[1]));
    const su = nrmAxis(scr.map(p => p[0])), svUp = nrmAxis(scr.map(p => -p[1]));   // 屏幕转 y-up
    const dX_same = emd(au, su), dX_mirror = emd(au, su.map(v => 1 - v));
    const dY_same = emd(av, svUp), dY_flip = emd(av, svUp.map(v => 1 - v));
    return JSON.stringify({
      nA4: a4.length, nScr: scr.length,
      x: { same: +dX_same.toFixed(4), mirror: +dX_mirror.toFixed(4), verdict: dX_same < dX_mirror ? 'OK 同向' : 'MIRRORED 左右镜像' },
      y: { same: +dY_same.toFixed(4), flip: +dY_flip.toFixed(4), verdict: dY_same < dY_flip ? 'OK 同向' : 'FLIPPED 上下颠倒' },
    });
    } catch (err) { return JSON.stringify({ error: String(err && err.message || err) }); }
  })()`);
  console.log(VIEW, r);

  ws.close();
  edge.kill();
}

main().then(() => process.exit(0)).catch((e) => { console.error('FAIL', e.message); edge.kill(); process.exit(1); });
