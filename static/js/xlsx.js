/**
 * xlsx.js —— 最小 XLSX 读取器（纯 JS，浏览器/Node 通用，无依赖）
 *
 * XLSX 本质是 ZIP 里装 XML：
 *   xl/workbook.xml        → 工作表清单与名字
 *   xl/sharedStrings.xml   → 共享字符串表（单元格 t="s" 时是它的下标）
 *   xl/worksheets/*.xml    → 每个表的单元格
 *
 * 这里只实现读数据需要的部分：ZIP 中央目录解析 + raw deflate 解压 + 单元格抽取。
 * 支持：共享字符串、内联字符串、数值、布尔、日期序列号（转 ISO 字符串）。
 * 不支持：公式求值（读到的是缓存值）、样式、合并单元格（按首格取值）。
 */

/* ------------------------------ ZIP ------------------------------ */

const SIG_EOCD = 0x06054b50;
const SIG_CEN = 0x02014b50;
const SIG_LOC = 0x04034b50;

async function inflateRaw(bytes) {
  // 浏览器 & Node 18+ 都有 DecompressionStream
  if (typeof DecompressionStream !== 'undefined') {
    const ds = new DecompressionStream('deflate-raw');
    const stream = new Blob([bytes]).stream().pipeThrough(ds);
    const buf = await new Response(stream).arrayBuffer();
    return new Uint8Array(buf);
  }
  // 退回 Node 的 zlib
  const { inflateRawSync } = await import('node:zlib');
  return new Uint8Array(inflateRawSync(bytes));
}

/**
 * 解析 ZIP，返回 { 文件名(小写) → Uint8Array }。
 * 只处理 store(0) 与 deflate(8)，这两种覆盖了所有正常 XLSX。
 */
export async function unzip(arrayBuffer) {
  const buf = new Uint8Array(arrayBuffer);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  // 从尾部找 EOCD（注释最长 65535 字节）
  let eocd = -1;
  const minPos = Math.max(0, buf.length - 22 - 65535);
  for (let i = buf.length - 22; i >= minPos; i--) {
    if (dv.getUint32(i, true) === SIG_EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 ZIP/XLSX：找不到 EOCD');

  const entryCount = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);

  const files = Object.create(null);
  for (let i = 0; i < entryCount; i++) {
    if (dv.getUint32(p, true) !== SIG_CEN) break;
    const method = dv.getUint16(p + 10, true);
    const compSize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const localOff = dv.getUint32(p + 42, true);
    const name = new TextDecoder('utf-8').decode(buf.subarray(p + 46, p + 46 + nameLen));

    // 读本地头拿真实数据起点
    if (dv.getUint32(localOff, true) !== SIG_LOC) { p += 46 + nameLen + extraLen + commentLen; continue; }
    const lNameLen = dv.getUint16(localOff + 26, true);
    const lExtraLen = dv.getUint16(localOff + 28, true);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compSize);

    try {
      files[name.toLowerCase()] = method === 0 ? raw : await inflateRaw(raw);
    } catch (e) {
      files[name.toLowerCase()] = null;
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

/* ------------------------------ XML 小工具 ------------------------------ */

const decodeXml = (s) => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
  .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&amp;/g, '&');

const textOf = (xml) => {
  // 去掉嵌套标签后取纯文本（<t> 里可能有 <r> 分段）
  const noTags = xml.replace(/<[^>]*>/g, '');
  return decodeXml(noTags);
};

const attr = (xml, name) => {
  const m = xml.match(new RegExp(`${name}\\s*=\\s*"([^"]*)"`));
  return m ? decodeXml(m[1]) : null;
};

/** "AB12" → { col: 27, row: 11 }（0 基） */
function refToCell(ref) {
  const m = ref.match(/^([A-Z]+)(\d+)$/i);
  if (!m) return null;
  let col = 0;
  const letters = m[1].toUpperCase();
  for (let i = 0; i < letters.length; i++) col = col * 26 + (letters.charCodeAt(i) - 64);
  return { col: col - 1, row: parseInt(m[2], 10) - 1 };
}

/** Excel 序列日期 → ISO 字符串（只处理 1900 体系，够用） */
function serialToDate(n) {
  const ms = Math.round((n - 25569) * 86400 * 1000);
  const d = new Date(ms);
  if (isNaN(d.getTime())) return null;
  const iso = d.toISOString();
  return iso.slice(0, 10);
}

/* ------------------------------ 工作表 ------------------------------ */

function parseSharedStrings(xml) {
  const out = [];
  if (!xml) return out;
  const re = /<si>([\s\S]*?)<\/si>/g;
  let m;
  while ((m = re.exec(xml))) out.push(textOf(m[1]).trim());
  return out;
}

function parseSheet(xml, shared) {
  const rows = [];
  if (!xml) return rows;
  const rowRe = /<row[^>]*>([\s\S]*?)<\/row>/g;
  let rm;
  while ((rm = rowRe.exec(xml))) {
    const rowXml = rm[1];
    const cellRe = /<c\s+([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cm;
    const cells = [];
    let maxCol = -1;
    while ((cm = cellRe.exec(rowXml))) {
      const attrs = cm[1];
      const body = cm[2] || '';
      const r = attr(attrs, 'r');
      const t = attr(attrs, 't') || 'n';
      const pos = r ? refToCell(r) : null;
      const col = pos ? pos.col : cells.length;

      let value = '';
      const vMatch = body.match(/<v>([\s\S]*?)<\/v>/);
      const isMatch = body.match(/<is>([\s\S]*?)<\/is>/);
      if (t === 's') {
        const idx = vMatch ? parseInt(textOf(vMatch[1]), 10) : -1;
        value = (idx >= 0 && shared[idx] != null) ? shared[idx] : '';
      } else if (t === 'inlineStr') {
        value = isMatch ? textOf(isMatch[1]).trim() : '';
      } else if (t === 'b') {
        value = vMatch && textOf(vMatch[1]).trim() === '1' ? 'TRUE' : 'FALSE';
      } else if (t === 'str') {
        value = vMatch ? textOf(vMatch[1]) : '';
      } else if (t === 'd') {
        value = vMatch ? textOf(vMatch[1]) : '';
      } else {
        const raw = vMatch ? textOf(vMatch[1]).trim() : '';
        if (raw !== '' && /^-?\d+(\.\d+)?$/.test(raw)) {
          const n = Number(raw);
          // 20000~60000 之间当作日期序列号（Excel 常见范围）
          if (Number.isInteger(n) && n > 20000 && n < 60000) value = serialToDate(n) ?? raw;
          else value = raw;
        } else value = raw;
      }
      cells[col] = value;
      if (col > maxCol) maxCol = col;
    }
    for (let i = 0; i <= maxCol; i++) if (cells[i] === undefined) cells[i] = '';
    rows.push(cells);
  }
  return rows;
}

/* ------------------------------ 对外接口 ------------------------------ */

/**
 * 读 XLSX / CSV。
 * @param {ArrayBuffer} arrayBuffer
 * @param {string} [fileName] 用于判断是不是 CSV
 * @returns {Promise<{sheets: {name: string, rows: string[][]}[], active: number}>}
 */
export async function readWorkbook(arrayBuffer, fileName = '') {
  // CSV 直接当一张表
  if (/\.csv$/i.test(fileName)) {
    let text = new TextDecoder('utf-8').decode(new Uint8Array(arrayBuffer));
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    // GBK 兜底：UTF-8 解码出现大量替换字符时试 gbk
    if ((text.match(/\uFFFD/g) || []).length > 3 && typeof TextDecoder !== 'undefined') {
      try { text = new TextDecoder('gbk').decode(new Uint8Array(arrayBuffer)); } catch (e) { /* 保持 utf-8 */ }
    }
    const rows = parseCsv(text);
    return { sheets: [{ name: 'CSV', rows }], active: 0 };
  }

  const files = await unzip(arrayBuffer);
  const enc = (u8) => (u8 ? new TextDecoder('utf-8').decode(u8) : null);

  const shared = parseSharedStrings(enc(files['xl/sharedstrings.xml']));

  // 工作表清单：把 r:id 映射到文件名
  const wbXml = enc(files['xl/workbook.xml']) || '';
  const relsXml = enc(files['xl/_rels/workbook.xml.rels']) || '';
  const relMap = new Map();
  const relRe = /<Relationship\s+([^>]*?)\/?>/g;
  let rm;
  while ((rm = relRe.exec(relsXml))) {
    const id = attr(rm[1], 'Id');
    const target = attr(rm[1], 'Target');
    if (id && target) relMap.set(id, target.replace(/^\/?xl\//, '').replace(/^\//, ''));
  }

  const sheets = [];
  const sheetRe = /<sheet\s+([^>]*?)\/?>/g;
  let sm;
  let index = 0;
  while ((sm = sheetRe.exec(wbXml))) {
    const name = attr(sm[1], 'name') || `Sheet${index + 1}`;
    const rid = attr(sm[1], 'r:id') || '';
    let path = relMap.get(rid);
    if (!path) path = `worksheets/sheet${index + 1}.xml`;
    const xml = enc(files[`xl/${path}`]) || enc(files[path]) || null;
    sheets.push({ name, rows: parseSheet(xml, shared) });
    index++;
  }

  // workbook.xml 缺失时兜底：扫所有 worksheets/sheetN.xml
  if (!sheets.length) {
    const names = Object.keys(files)
      .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
      .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
    for (const n of names) {
      sheets.push({ name: n.replace(/.*\//, '').replace(/\.xml$/, ''), rows: parseSheet(enc(files[n]), shared) });
    }
  }
  if (!sheets.length) throw new Error('XLSX 里读不到工作表');
  return { sheets, active: 0 };
}

/** 极简 CSV 解析（支持引号、双引号转义、CRLF） */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQ = false;
      } else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c === '\r') { /* 跳过 */ }
    else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}
