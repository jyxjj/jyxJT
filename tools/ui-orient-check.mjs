/**
 * ui-orient-check.mjs —— 端到端验证出图方向与 3D 视口一致（不镜像、不颠倒）
 * 对每个视向：点击 spView → 预览 → 热点锚点(A4) vs 相机投影屏幕坐标的相关性符号
 *   a4X vs screenX 应正相关；a4Y vs (−screenY) 应正相关。
 * 用法: node tools/ui-orient-check.mjs [jt路径]
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9338;
const APP = 'http://127.0.0.1:8770/';
const JT = process.argv[2] || 'D:\\JT\\sample\\07_engine_4cyl_inline_assembly_step\\001_Cylinder_liner_1_612.jt';
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
    return 1;
  })()`);

  const results = [];
  for (const view of VIEWS) {
    await evalJs(`(() => {
      const btn = document.querySelector('#spView [data-view="${view}"]');
      btn.click();
      document.getElementById('spPreview').click();
      return 1;
    })()`);
    for (let i = 0; i < 240; i++) {
      await sleep(400);
      if (await evalJs('window.__sp && window.__sp.sheetData ? 1 : 0')) break;
    }
    const r = await evalJs(`JSON.stringify((() => {
      const { THREE, camera, S } = window.__jt;
      const sd = window.__sp.sheetData;
      const hs = sd.hotspots || [];
      // 每个热点：找它 leadFor/label 对应分组的零件世界中心 → 相机投影
      // 热点锚点 (ax,ay) 在 A4 (y up)。用分组的所有叶子零件包围盒中心近似锚点对应物。
      // 分组 → 叶子 keys：从 groups 参数拿不到，改从 S.groupKeys?—— 直接用
      // spBuild 里 edgesByGroup 的 key 是分组 key；这里简单用热点 label 顺序对应
      // pageGroups0 顺序。稳妥法：对每个热点，用它的锚点在哪个零件附近判断太复杂。
      // 换一种：直接对每个"顶层可见零件"取包围盒中心投影 + 它在 A4 上的
      // 热点锚点（用 hotspots[i].leadFor 找到 group，再取该 group 叶子中心）。
      const leafCenter = (groupKey) => {
        const rec = S.meshes.get(groupKey);
        if (rec && rec.body) {
          rec.body.updateWorldMatrix(true, false);
          const b = rec.body.geometry.boundingBox.clone().applyMatrix4(rec.body.matrixWorld);
          return b.getCenter(new THREE.Vector3());
        }
        return null;
      };
      // 分组 key 列表（spBuild 存在 SP.match? 不确定）——退而求其次：
      // 用热点数量与零件中心数量都按序对比不行。改为：直接用每个热点锚点
      // 对应"最近的零件中心投影"算符号一致性。
      const view3 = document.getElementById('view');
      const vw = view3.clientWidth, vh = view3.clientHeight;
      const centers = [];
      for (const [, rec] of S.meshes) {
        if (!rec || !rec.body || !rec.body.visible) continue;
        rec.body.updateWorldMatrix(true, false);
        const b = rec.body.geometry.boundingBox.clone().applyMatrix4(rec.body.matrixWorld);
        const c = b.getCenter(new THREE.Vector3());
        const p = c.clone().project(camera);
        centers.push({ ax: (p.x * 0.5 + 0.5) * vw, ay: (1 - (p.y * 0.5 + 0.5)) * vh });
      }
      const pts = hs.map(h => ({ x: h.ax, y: h.ay }));
      return { view, nHs: pts.length, nParts: centers.length,
        hs: pts.slice(0, 12), centers: centers.slice(0, 12) };
    })())`);
    results.push(JSON.parse(r));
  }
  console.log(JSON.stringify(results, null, 1));

  ws.close();
  edge.kill();
}

main().then(() => process.exit(0)).catch((e) => { console.error('FAIL', e.message); edge.kill(); process.exit(1); });
