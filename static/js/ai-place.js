/**
 * ai-place.js —— 让大模型给热点挑"最优位置"
 *
 * 思路：把"排版问题"结构化地丢给模型，让它只输出 JSON 坐标。
 *   · 输入：图纸可用区、每个热点的锚点（零件上的点）、零件包围盒、最小间距
 *   · 输出：[{id, x, y}]，坐标是 A4 毫米
 *
 * 模型不需要懂 JT，只要会做二维摆放；后端 /api/ai/chat 负责转发（绕开 CORS）。
 */

/** 组织发给模型的输入（尽量紧凑，省 token） */
export function buildPlacementPayload(sheetData, opts = {}) {
  const { sheet, hotspots } = sheetData;
  const rect = opts.rect || { x0: 0, y0: 0, x1: sheet.width, y1: sheet.height };
  const items = hotspots.map((hs) => ({
    id: hs.id || `${hs.g ? hs.g.key : 'g'}#${hs.recIndex ?? 0}`,
    label: String(hs.label),
    // 锚点 = 零件上要指的位置
    ax: round(hs.ax ?? hs.anchor?.[0] ?? hs.cx, 2),
    ay: round(hs.ay ?? hs.anchor?.[1] ?? hs.cy, 2),
    // 零件包围盒（用来避免数字压在零件上）
    bx0: round(hs.box?.x0, 2),
    by0: round(hs.box?.y0, 2),
    bx1: round(hs.box?.x1, 2),
    by1: round(hs.box?.y1, 2),
  }));
  return {
    sheet: {
      x0: round(rect.x0, 2), y0: round(rect.y0, 2),
      x1: round(rect.x1, 2), y1: round(rect.y1, 2),
      unit: 'mm',
    },
    labelSize: { w: 2.6, h: 2.056 },
    minGap: 0.6,
    items,
  };
}

const round = (v, n = 2) => (Number.isFinite(v) ? +Number(v).toFixed(n) : 0);

const SYSTEM_PROMPT = `你是机械制图标注排版专家。任务：给一张 A4 图纸上的编号（热点）选最佳位置。

约束（必须全部满足）：
1. 每个编号是一个字符高度 2.056mm 的文本，宽约 2.6mm（多位数按比例更宽）。
2. 编号之间不能重叠，任意两个编号的中心距离至少 3.2mm。
3. 编号必须完全落在 sheet 范围内（x0..x1, y0..y1），且离边界至少 1.5mm。
4. 编号尽量靠近它自己的锚点 (ax, ay)（引线越短越好），但不要压在零件包围盒 (bx0..bx1, by0..by1) 里面。
5. 优先放在锚点的左/右/上/下四个方向（工程图引线习惯横平竖直），不要斜着绕。

只输出 JSON，格式：
{"positions":[{"id":"...","x":123.4,"y":56.7}, ...]}
不要输出任何解释文字。`;

/**
 * 调模型拿位置。
 * @param {object} cfg { url, key, model, temperature }
 * @param {object} payload buildPlacementPayload 的产物
 * @returns {Promise<{map: Map<string,{x:number,y:number}>, raw: string, usage?: object}>}
 */
export async function aiPlaceHotspots(cfg, payload) {
  const userContent =
    '图纸与热点如下（JSON）。请给出每个 id 的最佳坐标：\n' +
    JSON.stringify(payload);

  const body = {
    model: cfg.model,
    temperature: cfg.temperature ?? 0.2,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userContent },
    ],
  };

  const res = await fetch('/api/ai/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: cfg.url, key: cfg.key, body }),
  });
  if (!res.ok) throw new Error(`转发失败 HTTP ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(data.error);

  const content =
    data?.choices?.[0]?.message?.content ??
    data?.choices?.[0]?.message?.reasoning_content ??
    '';
  if (!content) throw new Error('模型没有返回内容：' + JSON.stringify(data).slice(0, 300));

  const positions = parsePositions(content);
  if (!positions.length) throw new Error('模型返回里没有坐标 JSON：' + content.slice(0, 300));

  const map = new Map();
  for (const p of positions) {
    if (p && p.id != null && Number.isFinite(p.x) && Number.isFinite(p.y)) {
      map.set(String(p.id), { x: p.x, y: p.y });
    }
  }
  return { map, raw: content, usage: data.usage };
}

/** 从模型回复里抠出 JSON（容忍 ```json 围栏、前后废话） */
export function parsePositions(text) {
  const tryParse = (s) => {
    try {
      const j = JSON.parse(s);
      if (Array.isArray(j)) return j;
      if (Array.isArray(j.positions)) return j.positions;
      // 有些模型会包一层
      for (const k of Object.keys(j)) {
        if (Array.isArray(j[k])) return j[k];
      }
    } catch (e) { /* 继续尝试 */ }
    return null;
  };

  const fenced = [...String(text).matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((m) => m[1]);
  for (const f of fenced) {
    const r = tryParse(f.trim());
    if (r) return r;
  }
  const direct = tryParse(String(text).trim());
  if (direct) return direct;

  // 最后手段：找第一个 {...} / [...] 片段
  const start = text.search(/[[{]/);
  if (start >= 0) {
    const slice = text.slice(start);
    const end = Math.max(slice.lastIndexOf('}'), slice.lastIndexOf(']'));
    if (end > 0) {
      const r = tryParse(slice.slice(0, end + 1));
      if (r) return r;
    }
  }
  return [];
}

/**
 * 校验并修正模型给的坐标：
 *   · 越界的夹回可用区（按字号留边）
 *   · 缺失的热点保持原位（返回 null 表示"没给"）
 * @returns {{applied:number, clamped:number, missing:string[]}}
 */
export function sanitizePositions(map, sheetData, rect) {
  let applied = 0;
  let clamped = 0;
  const missing = [];
  for (const hs of sheetData.hotspots || []) {
    const id = hs.id || `${hs.g ? hs.g.key : 'g'}#${hs.recIndex ?? 0}`;
    const p = map.get(String(id));
    if (!p) { missing.push(String(hs.label)); continue; }
    const rx = (hs.rx || 1.3) + 1.5;
    const ry = (hs.ry || 1.1) + 1.5;
    const x = Math.max(rect.x0 + rx, Math.min(rect.x1 - rx, p.x));
    const y = Math.max(rect.y0 + ry, Math.min(rect.y1 - ry, p.y));
    if (Math.abs(x - p.x) > 1e-6 || Math.abs(y - p.y) > 1e-6) clamped++;
    p.x = x;
    p.y = y;
    applied++;
  }
  return { applied, clamped, missing };
}
