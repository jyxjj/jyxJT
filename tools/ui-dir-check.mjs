/**
 * ui-dir-check.mjs —— 对比 3D 视口与 A4 出图的 y 方向
 * 用法: node tools/ui-dir-check.mjs [jt路径]
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9336;
const APP = 'http://127.0.0.1:8770/';
const JT = process.argv[2] || 'D:\\JT\\sample\\07_engine_4cyl_inline_assembly_step\\001_Cylinder_liner_1_612.jt';

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
  for (let i = 0; i < 240; i++) {
    const st = await evalJs('window.__jtState ? JSON.stringify(window.__jtState()) : null');
    if (st && JSON.parse(st).loaded > 0) break;
    await sleep(500);
  }

  await evalJs(`(() => {
    document.getElementById('btnSheet').click();
    const p = document.getElementById('spPlate');
    p.checked = true; p.dispatchEvent(new Event('change'));
    document.getElementById('spDrawingNo').value = 'T';
    document.getElementById('spPreview').click();
    return 1;
  })()`);
  for (let i = 0; i < 240; i++) {
    await sleep(500);
    if (await evalJs('window.__sp && window.__sp.sheetData ? 1 : 0')) break;
  }

  const r = await evalJs(`JSON.stringify((() => {
    const { THREE, camera, S } = window.__jt;
    let box = null;
    for (const rec of S.meshes.values()) {
      const g = rec.group || rec;
      const b = new THREE.Box3().setFromObject(g);
      if (!box) box = b; else box.union(b);
    }
    const view = document.getElementById('view');
    const vw = view.clientWidth, vh = view.clientHeight;
    const top = new THREE.Vector3((box.min.x + box.max.x) / 2, box.max.y, (box.min.z + box.max.z) / 2);
    const bot = new THREE.Vector3((box.min.x + box.max.x) / 2, box.min.y, (box.min.z + box.max.z) / 2);
    const proj = (v) => { const p = v.clone().project(camera); return { sx: +((p.x * 0.5 + 0.5) * vw).toFixed(1), sy: +((1 - (p.y * 0.5 + 0.5)) * vh).toFixed(1) }; };
    const t3 = proj(top), b3 = proj(bot);
    const sd = window.__sp.sheetData;
    let maxY = -1e9, minY = 1e9, at = null, ab = null;
    const scan = (items) => {
      for (const it of items || []) {
        if (it.kind === 'polyline') {
          for (let i = 0; i < it.pts.length; i += 2) {
            if (it.pts[i + 1] > maxY) { maxY = it.pts[i + 1]; at = [it.pts[i], it.pts[i + 1]]; }
            if (it.pts[i + 1] < minY) { minY = it.pts[i + 1]; ab = [it.pts[i], it.pts[i + 1]]; }
          }
        }
      }
    };
    scan(sd.items);
    if (sd.pages) for (const p of sd.pages) scan(p.items);
    return {
      viewport: { w: vw, h: vh },
      worldTopScreen: t3, worldBotScreen: b3,
      a4MaxY: at, a4MinY: ab,
      worldBoxMinY: +box.min.y.toFixed(1), worldBoxMaxY: +box.max.y.toFixed(1),
    };
  })())`);
  console.log(r);

  ws.close();
  edge.kill();
}

main().then(() => process.exit(0)).catch((e) => { console.error('FAIL', e.message); edge.kill(); process.exit(1); });
