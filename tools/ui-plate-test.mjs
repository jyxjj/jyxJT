/**
 * ui-plate-test.mjs —— 用本机 Edge 的 CDP 驱动页面，验证"图册三件套"的界面链路
 *
 * 不用 playwright：直接开 Edge --headless=new --remote-debugging-port，
 * 用 WebSocket 发 Runtime.evaluate / Input 事件。
 *
 * 用法：node tools/ui-plate-test.mjs [jt路径] [图号]
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9333;
const APP = 'http://127.0.0.1:8770/';
const JT = process.argv[2] || 'D:\\JT\\sample\\07_engine_4cyl_inline_assembly_step\\001_Cylinder_liner_1_612.jt';
const NO = process.argv[3] || 'HTEAM-04021';

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
  if (!targets) throw new Error('Edge 没起来');
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
    const r = await send('Runtime.evaluate', {
      expression: expr, awaitPromise: true, returnByValue: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + JSON.stringify(r.exceptionDetails.exception));
    return r.result.value;
  };
  // 页面里的 S / spBuild 都是模块作用域，外面看不到；
  // 只有 window.__jt 和 window.__sp 是露出来的，够用了。
  const jtState = async () => evalJs('window.__jtState ? JSON.stringify(window.__jtState()) : null');

  await send('Page.enable');
  await send('Runtime.enable');
  const logs = [];
  send('Log.enable');

  // 收集浏览器控制台错误
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') logs.push('EXC ' + JSON.stringify(m.params.exceptionDetails.text));
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') logs.push('ERR ' + m.params.entry.text);
  });

  // 页面支持 ?open=<路径>，直接用它打开 JT（走和界面同一条加载流程）
  await send('Page.navigate', { url: APP + '?open=' + encodeURIComponent(JT) });
  await sleep(1500);

  // 等页面模块加载完
  for (let i = 0; i < 60; i++) {
    const ready = await evalJs('typeof window.__sp !== "undefined"');
    if (ready) break;
    await sleep(400);
  }
  console.log('OPEN  ', JT);

  for (let i = 0; i < 180; i++) {
    const st = await jtState();
    if (st && JSON.parse(st).loaded > 0) break;
    await sleep(500);
  }
  console.log('STATE ', await jtState());

  // 2) 出图面板：勾图册、填图号
  await evalJs(`(() => {
    document.getElementById('btnSheet').click();
    const p = document.getElementById('spPlate');
    p.checked = true;
    p.dispatchEvent(new Event('change'));
    document.getElementById('spDrawingNo').value = ${JSON.stringify(NO)};
    return true;
  })()`);

  // 3) 出图（面板按钮：预览 A4）
  await evalJs(`document.getElementById('spPreview').click()`);
  let built = '';
  for (let i = 0; i < 240; i++) {
    await sleep(500);
    const d = await evalJs(`window.__sp && window.__sp.sheetData
      ? JSON.stringify({ plate: window.__sp.sheetData.plate, no: window.__sp.sheetData.drawingNo,
          hs: window.__sp.sheetData.hotspots.length, pages: window.__sp.sheetData.pageCount })
      : ''`);
    if (d) { built = d; break; }
  }
  console.log('BUILD ', built || 'timeout: ' + await evalJs(`document.getElementById('spReport').innerText`));

  // 4) 点"生成图册三件套"
  await evalJs(`document.getElementById('spPlateExport').click()`);
  let report = '';
  for (let i = 0; i < 90; i++) {
    await sleep(500);
    report = await evalJs(`document.getElementById('spReport').innerText`);
    if (/已生成|失败/.test(report)) break;
  }
  console.log('EXPORT', report.replace(/\\n/g, ' | '));
  if (logs.length) console.log('CONSOLE', logs.slice(0, 8).join(' | '));
  ws.close();
  edge.kill();
}

main().then(() => process.exit(0)).catch((e) => { console.error('FAIL', e.message); edge.kill(); process.exit(1); });
