/**
 * ui-basis-check.mjs —— 决定性基矢检验
 * 对每个固定视向：把相机真正摆到该视向 pose（position = target + CAM*dist, lookAt），
 * 对比 basisFor 公式（复刻页面新代码）的 right/up 与 camera.matrixWorld 的 right/up 点积。
 * dot=+1 → 出图与 3D 视口同向；dot=−1 → 镜像/颠倒。
 * 用法: node tools/ui-basis-check.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9344;
const APP = 'http://127.0.0.1:8770/';
const JT = process.argv[2] || 'D:\\JT\\sample\\07_engine_4cyl_inline_assembly_step.jt';
const VIEWS = { iso: [0.9, 0.72, 1.0], front: [0, 0, 1], top: [0, 1, 0.0001], right: [1, 0, 0.0001] };

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

  const results = {};
  for (const [name, cam] of Object.entries(VIEWS)) {
    const r = await evalJs(`(() => {
      try {
      const { THREE, camera, controls } = window.__jt;
      const target = controls.target.clone();
      const dir = new THREE.Vector3(${cam[0]}, ${cam[1]}, ${cam[2]}).normalize();
      // 把相机摆到该视向的 pose（与 fitView 相同的摆放语义）
      camera.position.copy(target).addScaledVector(dir, 1000);
      camera.up.set(0, 1, 0);
      camera.lookAt(target);
      camera.updateMatrixWorld(true);
      const e = camera.matrixWorld.elements;
      const camRight = new THREE.Vector3(e[0], e[1], e[2]);
      const camUp    = new THREE.Vector3(e[4], e[5], e[6]);
      // 复刻页面 basisFor 的新公式（upHint × dir, dir × right；极点 upHint = −水平分量）
      let upHint = new THREE.Vector3(0, 1, 0);
      if (Math.abs(dir.y) > 0.999) {
        upHint = new THREE.Vector3(-dir.x, 0, -dir.z).normalize();
        if (upHint.lengthSq() < 1e-12) upHint.set(0, 0, -1);
      }
      const right = new THREE.Vector3().crossVectors(upHint, dir).normalize();
      const up = new THREE.Vector3().crossVectors(dir, right).normalize();
      return JSON.stringify({
        view: '${name}',
        dotRight: +right.dot(camRight).toFixed(4),
        dotUp: +up.dot(camUp).toFixed(4),
        sheetRight: right.toArray().map(v => +v.toFixed(3)),
        camRight: camRight.toArray().map(v => +v.toFixed(3)),
      });
      } catch (err) { return JSON.stringify({ error: String(err && err.message || err) }); }
    })()`);
    results[name] = JSON.parse(r);
  }
  console.log(JSON.stringify(results, null, 1));

  ws.close();
  edge.kill();
}

main().then(() => process.exit(0)).catch((e) => { console.error('FAIL', e.message); edge.kill(); process.exit(1); });
