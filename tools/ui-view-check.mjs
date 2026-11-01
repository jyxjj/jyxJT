/**
 * ui-view-check.mjs —— 检查 3D 视口与 A4 出图方向是否一致
 * 用法: node tools/ui-view-check.mjs [jt路径]
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9334;
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
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg.result);
      pending.delete(msg.id);
    }
  });
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  const send = (method, params = {}) => new Promise((resolve) => {
    const mid = ++id;
    pending.set(mid, resolve);
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
  console.log('STATE ', await evalJs('window.__jtState ? JSON.stringify(window.__jtState()) : null'));

  // 3D 视口截图（不带头）
  await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  // 直接用 Emulation 截图不行，用带 clip 的方式：截整个视口
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('D:\\JT\\webjt\\_test\\viewport3d.png', Buffer.from(shot.data, 'base64'));
  console.log('SHOT   _test/viewport3d.png saved');

  // 点出图预览
  await evalJs(`(() => {
    document.getElementById('btnSheet').click();
    const p = document.getElementById('spPlate');
    p.checked = true; p.dispatchEvent(new Event('change'));
    document.getElementById('spDrawingNo').value = 'HTEAM-04021';
    document.getElementById('spPreview').click();
    return true;
  })()`);
  for (let i = 0; i < 240; i++) {
    await sleep(500);
    const d = await evalJs('window.__sp && window.__sp.sheetData ? 1 : 0');
    if (d) break;
  }
  console.log('BUILD  done');

  const info = await evalJs(`JSON.stringify((() => {
    const { camera, controls, S } = window.__jt;
    // 世界包围盒
    let box = null;
    for (const rec of S.meshes.values()) {
      const g = rec.group || rec;
      const b = new window.__jt.THREE.Box3().setFromObject(g);
      if (!box) box = b; else box.union(b);
    }
    const size = box ? box.getSize(new window.__jt.THREE.Vector3()).toArray().map(v=>+v.toFixed(1)) : null;
    const center = box ? box.getCenter(new window.__jt.THREE.Vector3()).toArray().map(v=>+v.toFixed(1)) : null;
    return {
      camPos: camera.position.toArray().map(v=>+v.toFixed(1)),
      target: controls.target.toArray().map(v=>+v.toFixed(1)),
      camUp: camera.up.toArray(),
      bboxSize: size,
      bboxCenter: center,
    };
  })())`);
  console.log('CAM   ', info);

  ws.close();
  edge.kill();
}

main().then(() => process.exit(0)).catch((e) => { console.error('FAIL', e.message); edge.kill(); process.exit(1); });
