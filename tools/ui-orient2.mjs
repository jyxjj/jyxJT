/**
 * ui-orient2.mjs —— 用整机装配验证每个视向的出图方向（不镜像、不颠倒）
 * 方法：每个零件包围盒中心 → 当前相机投影屏幕坐标；
 *       每个热点锚点(A4) 与之最近邻配对；统计 x/x 与 y/(−screenY) 的符号一致率。
 *       正相关(>60%) = 方向一致；≈0 或负 = 镜像/颠倒。
 * 用法: node tools/ui-orient2.mjs [jt路径]
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9339;
const APP = 'http://127.0.0.1:8770/';
const JT = process.argv[2] || 'D:\\JT\\sample\\07_engine_4cyl_inline_assembly_step.jt';
const VIEWS = ['current', 'iso', 'front', 'top', 'right'];

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
  // 等加载稳定（连续 6 次数量不变）
  let last = -1, stable = 0;
  for (let i = 0; i < 360 && stable < 6; i++) {
    const st = await evalJs('window.__jtState ? window.__jtState().loaded : 0');
    if (st === last) stable++; else { stable = 0; last = st; }
    await sleep(500);
  }
  // fit 一下保证相机就位
  await evalJs('window.__jtFit ? window.__jtFit() : 0');
  await sleep(1000);
  console.log('STATE', await evalJs('window.__jtState ? JSON.stringify(window.__jtState()) : null'));

  await evalJs(`(() => {
    document.getElementById('btnSheet').click();
    const p = document.getElementById('spPlate');
    p.checked = true; p.dispatchEvent(new Event('change'));
    document.getElementById('spDrawingNo').value = 'T';
    return 1;
  })()`);

  const out = [];
  for (const view of VIEWS) {
    await evalJs(`(() => {
      document.querySelector('#spView [data-view="${view}"]').click();
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
      const hsAll = (sd && sd.hotspots) || [];
      // 图册模式锚点在 h.lead = [ax,ay,ex,ey]；常规模式在 h.ax/h.ay
      const anchorOf = (h) => Array.isArray(h.lead) ? [h.lead[0], h.lead[1]] : [h.ax, h.ay];
      const hs = hsAll.map(h => anchorOf(h))
        .filter(a => Number.isFinite(a[0]) && Number.isFinite(a[1]));
      const viewEl = document.getElementById('view');
      const vw = viewEl.clientWidth, vh = viewEl.clientHeight;
      const centers = [];
      for (const [, rec] of S.meshes) {
        if (!rec || !rec.body || !rec.body.visible) continue;
        const geo = rec.body.geometry;
        if (!geo) continue;
        let bb = geo.boundingBox;
        if (!bb) { geo.computeBoundingBox(); bb = geo.boundingBox; }
        rec.body.updateWorldMatrix(true, false);
        const b = bb.clone().applyMatrix4(rec.body.matrixWorld);
        const c = b.getCenter(new THREE.Vector3()).clone().project(camera);
        centers.push({ x: (c.x * 0.5 + 0.5) * vw, y: (1 - (c.y * 0.5 + 0.5)) * vh });
      }
      // 归一化到 [0,1] 后最近邻配对（A4 mm 与屏幕 px 量纲不同）
      const nrm = (arr, fx, fy) => {
        const xs = arr.map(fx), ys = arr.map(fy);
        const x0 = Math.min(...xs), x1 = Math.max(...xs);
        const y0 = Math.min(...ys), y1 = Math.max(...ys);
        return arr.map(p => ({
          u: (fx(p) - x0) / Math.max(x1 - x0, 1e-6),
          v: (fy(p) - y0) / Math.max(y1 - y0, 1e-6),
        }));
      };
      const hsN = nrm(hs, a => a[0], a => a[1]);
      const ctN = nrm(centers, c => c.x, c => c.y);
      // 最近邻配对 + 符号一致率
      let n = 0, sx = 0, sy = 0;
      const pairs = [];
      for (const h of hsN) {
        let best = null, bd = Infinity;
        for (const c of ctN) {
          const d = (c.u - h.u) ** 2 + (c.v - h.v) ** 2;
          if (d < bd) { bd = d; best = c; }
        }
        if (!best) continue;
        pairs.push({ au: h.u, av: h.v, su: best.u, sv: best.v });
        n++;
      }
      // 以各自均值为参考算符号（u 对 u、v 对 −屏幕y：屏幕y向下）
      const mx = (a, f) => a.reduce((s, p) => s + f(p), 0) / Math.max(a.length, 1);
      const aum = mx(pairs, p => p.au), avm = mx(pairs, p => p.av);
      const sum_ = mx(pairs, p => p.su), svm = mx(pairs, p => p.sv);
      for (const p of pairs) {
        if ((p.au - aum) * (p.su - sum_) > 0) sx++;
        if ((p.av - avm) * (-(p.sv) - (-svm)) > 0) sy++;
      }
      return { nHs: hsAll.length, nParts: centers.length, paired: n,
        xAgree: n ? +(sx / n).toFixed(2) : null,
        yAgree: n ? +(sy / n).toFixed(2) : null };
      } catch (err) {
        return { error: String(err && err.message || err) };
      }
    })()`);
    out.push({ view, ...(typeof r === 'string' ? JSON.parse(r) : r) });
  }
  console.log(JSON.stringify(out, null, 1));

  ws.close();
  edge.kill();
}

main().then(() => process.exit(0)).catch((e) => { console.error('FAIL', e.message); edge.kill(); process.exit(1); });
