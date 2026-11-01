/**
 * ui-hlr-tune.mjs —— 在页面里对同一投影跑不同 depthTol 的光栅消隐，统计可见段总长
 *
 * 目的：找到能救回"贴面被误删的可见线"的容差值。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9337;
const APP = 'http://127.0.0.1:8770/';
const JT = process.argv[2] || 'D:\\JT\\sample\\07_engine_4cyl_inline_assembly_step\\001_Cylinder_liner_1_612.jt';

const profile = fs.mkdtempSync('D:\\JT\\webjt\\_test\\edge-');
const edge = spawn(EDGE, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--window-size=1600,1000', APP,
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
  const page = targets.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  });
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const mid = ++id;
    pending.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + JSON.stringify(r.exceptionDetails.exception));
    return r.result.value;
  };

  await send('Page.enable');
  await send('Runtime.enable');

  await send('Page.navigate', { url: APP + '?open=' + encodeURIComponent(JT) });
  await sleep(1500);
  for (let i = 0; i < 60; i++) {
    const ready = await evalJs('typeof window.__sp !== "undefined"');
    if (ready) break;
    await sleep(400);
  }
  for (let i = 0; i < 180; i++) {
    const st = await evalJs('window.__jtState ? JSON.stringify(window.__jtState()) : null');
    if (st && JSON.parse(st).loaded > 0) break;
    await sleep(500);
  }
  console.log('LOADED');

  // 页面里跑同一投影 + 不同 depthTol 的 raster 消隐
  const result = await evalJs(`(async () => {
    const m = await import('/static/js/drawing.js');
    const J = window.__jt;
    if (!J || !J.S || !J.S.meshes) return { err: 'no __jt.S.meshes' };
    const meshRecords = J.S.meshes;
    const keys = [...meshRecords.keys()].filter((k) => meshRecords.get(k));
    if (!keys.length) return { err: 'no mesh records loaded' };
    const THREE = J.THREE;
    const dir = new THREE.Vector3(0.9, 0.72, 1.0).normalize();
    const upHint = new THREE.Vector3(0, 1, 0);
    const right = new THREE.Vector3().crossVectors(upHint, dir).normalize();
    const up = new THREE.Vector3().crossVectors(dir, right).normalize();
    const basis = { dir, right, up };
    const proj = m.projectGroup(meshRecords, keys, basis, 25);
    const out = { nRec: keys.length, nEdge: proj.edges.uv.length / 4 };
    // analytic（几何精确）做参照
    try {
      const t0 = performance.now();
      const ra = m.removeHiddenLinesGrouped(proj, { method: 'analytic' });
      let visLen = 0;
      for (const [k, rec] of ra) {
        const v = (rec && rec.visible) ? rec.visible : rec;
        for (let i = 0; i < v.length; i += 4) {
          visLen += Math.hypot(v[i + 2] - v[i], v[i + 3] - v[i + 1]);
        }
      }
      out.analytic = { visLen: Math.round(visLen), ms: Math.round(performance.now() - t0) };
    } catch (e) {
      out.analytic = { err: String(e) };
    }
    for (const tol of [3e-3, 6e-3, 1e-2, 2e-2, 4e-2]) {
      const r = m.removeHiddenLinesGrouped(proj, { depthTol: tol });
      let visLen = 0, groups = 0;
      for (const [k, rec] of r) {
        const v = (rec && rec.visible) ? rec.visible : rec;
        groups++;
        for (let i = 0; i < v.length; i += 4) {
          visLen += Math.hypot(v[i + 2] - v[i], v[i + 3] - v[i + 1]);
        }
      }
      out[String(tol)] = { visLen: Math.round(visLen), groups };
    }
    // 复刻 grid 分格路径：单组 removeHiddenLines（现在的默认 analytic）
    const uv = m.removeHiddenLines(proj, {});
    let segLen = 0, segCount = 0;
    for (let i = 0; i < uv.length; i += 4) {
      segCount++;
      segLen += Math.hypot(uv[i + 2] - uv[i], uv[i + 3] - uv[i + 1]);
    }
    out.gridPath = { segCount, segLen: Math.round(segLen) };
    return out;
  })()`);
  console.log('TOL PROBE', JSON.stringify(result, null, 1));
  ws.close();
  edge.kill();
}

main().then(() => process.exit(0)).catch((e) => { console.error('FAIL', e.message); edge.kill(); process.exit(1); });
