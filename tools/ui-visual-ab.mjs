/**
 * ui-visual-ab.mjs —— 目视 A/B：3D 视口截图 vs A4 预览 SVG
 * 输出: _test/ab-<view>-3d.png 与 _test/ab-<view>-a4.png
 * 用法: node tools/ui-visual-ab.mjs [jt路径] [view]
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9340;
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

  // 3D 视口截图（clip 到 #view 元素）
  const rect = await evalJs(`(() => { const r = document.getElementById('view').getBoundingClientRect();
    return JSON.stringify({ x: r.x, y: r.y, w: r.width, h: r.height }); })()`);
  const rc = JSON.parse(rect);
  const shot = await send('Page.captureScreenshot', {
    format: 'png', captureBeyondViewport: false,
    clip: { x: rc.x, y: rc.y, width: Math.floor(rc.w), height: Math.floor(rc.h), scale: 1 },
  });
  fs.writeFileSync(`D:\\JT\\webjt\\_test\\ab-${VIEW}-3d.png`, Buffer.from(shot.data, 'base64'));
  console.log(`3D  -> _test/ab-${VIEW}-3d.png`);

  // 设置视向并出图，取预览 SVG 字符串
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
  const svg = await evalJs(`(function(){
    const el = document.querySelector('#spPreviewInner svg');
    return el ? el.outerHTML : '';
  })()`);
  if (svg) {
    fs.writeFileSync(`D:\\JT\\webjt\\_test\\ab-${VIEW}-a4.svg`, svg);
    console.log(`A4  -> _test/ab-${VIEW}-a4.svg (${svg.length} bytes)`);
  } else {
    // 找不到预览 DOM，就把 sheetData 存下来备查
    const dump = await evalJs('JSON.stringify(window.__sp.sheetData ? Object.keys(window.__sp.sheetData) : null)');
    console.log('NO SVG FOUND; sheetData keys:', dump);
  }

  ws.close();
  edge.kill();
}

main().then(() => process.exit(0)).catch((e) => { console.error('FAIL', e.message); edge.kill(); process.exit(1); });
