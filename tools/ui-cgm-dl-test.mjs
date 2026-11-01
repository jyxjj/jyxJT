/**
 * ui-cgm-dl-test.mjs —— 复现"直接点生成 CGM"（spCgm）的下载产物并存盘
 *
 * 用户报：直接点"下载 CGM"出的文件打不开、没有热点。
 * 这个脚本：不勾图册（默认 grid 模式）、点 spCgm、hook createObjectURL
 * 把 blob 内容抓回来存到 _test/spCgm-download.cgm。
 *
 * 用法：node tools/ui-cgm-dl-test.mjs [jt路径]
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9335;
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
  const jtState = async () => evalJs('window.__jtState ? JSON.stringify(window.__jtState()) : null');

  await send('Page.enable');
  await send('Runtime.enable');
  const logs = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') logs.push('EXC ' + JSON.stringify(m.params.exceptionDetails.text));
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') logs.push('ERR ' + m.params.entry.text);
  });

  await send('Page.navigate', { url: APP + '?open=' + encodeURIComponent(JT) });
  await sleep(1500);
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

  // 打开出图面板，不勾图册（模拟用户"直接点生成 CGM"）
  await evalJs(`document.getElementById('btnSheet').click()`);
  await evalJs(`document.getElementById('spPreview').click()`);
  for (let i = 0; i < 240; i++) {
    await sleep(500);
    const d = await evalJs(`window.__sp && window.__sp.sheetData ? 'built' : ''`);
    if (d) break;
  }
  console.log('BUILD done', await evalJs(`window.__sp && window.__sp.sheetData
    ? JSON.stringify({ pages: window.__sp.sheetData.pageCount, mode: window.__sp.sheetData.mode,
        hs: window.__sp.sheetData.hotspots.length,
        items0: window.__sp.sheetData.pages ? window.__sp.sheetData.pages[0].items.length : -1 })
    : 'no data'`));

  // hook：截获下载 blob
  await evalJs(`(() => {
    window.__cgmB64 = null;
    const orig = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (blob) => {
      if (blob && blob.type === 'image/cgm') {
        blob.arrayBuffer().then((ab) => {
          const u8 = new Uint8Array(ab);
          let bin = '';
          const CH = 0x8000;
          for (let i = 0; i < u8.length; i += CH) bin += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
          window.__cgmB64 = btoa(bin);
        });
      }
      return orig(blob);
    };
    return true;
  })()`);

  await evalJs(`document.getElementById('spCgm').click()`);
  let b64 = null;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    b64 = await evalJs('window.__cgmB64');
    if (b64) break;
  }
  if (!b64) { console.log('DOWNLOAD not captured'); }
  else {
    fs.writeFileSync('_test/spCgm-download.cgm', Buffer.from(b64, 'base64'));
    console.log('SAVED _test/spCgm-download.cgm', Buffer.from(b64, 'base64').length, 'bytes');
  }
  if (logs.length) console.log('CONSOLE', logs.slice(0, 8).join(' | '));
  ws.close();
  edge.kill();
}

main().then(() => process.exit(0)).catch((e) => { console.error('FAIL', e.message); edge.kill(); process.exit(1); });
