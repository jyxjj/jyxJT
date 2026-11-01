/**
 * ui-hand-check.mjs —— 对比出图基矢 right/up 与 3D 相机基矢是否同向
 * 判据：dot(sheetRight, camRight) < 0 → 出图左右镜像
 * 用法: node tools/ui-hand-check.mjs [jt路径]
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

  const r = await evalJs(`JSON.stringify((() => {
    const { THREE, camera, controls } = window.__jt;
    // 相机基矢（three.js lookAt 结果：列0=right, 列1=up, 列2=back）
    const e = camera.matrixWorld.elements;
    const camRight = new THREE.Vector3(e[0], e[1], e[2]);
    const camUp    = new THREE.Vector3(e[4], e[5], e[6]);
    // 复刻 index.html currentBasis() 的构造
    const eye = camera.position, target = controls.target;
    const dir = eye.clone().sub(target).normalize();
    const upHint = Math.abs(dir.y) > 0.999 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0);
    const right = dir.clone().cross(upHint).normalize();   // 现有代码：dir × upHint
    const up = right.clone().cross(dir).normalize();       // right × dir
    return {
      dir: dir.toArray().map(v => +v.toFixed(3)),
      sheetRight: right.toArray().map(v => +v.toFixed(3)),
      camRight:   camRight.toArray().map(v => +v.toFixed(3)),
      sheetUp:    up.toArray().map(v => +v.toFixed(3)),
      camUp:      camUp.toArray().map(v => +v.toFixed(3)),
      dotRight:   +right.dot(camRight).toFixed(3),
      dotUp:      +up.dot(camUp).toFixed(3),
      verdict: right.dot(camRight) < 0 ? 'MIRRORED (左右镜像)' : 'OK (同向)',
    };
  })())`);
  console.log(r);

  ws.close();
  edge.kill();
}

main().then(() => process.exit(0)).catch((e) => { console.error('FAIL', e.message); edge.kill(); process.exit(1); });
