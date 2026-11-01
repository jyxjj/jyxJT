/**
 * hotspot-map.js —— Excel 表格 ↔ 左侧层级分组 的匹配与热点表构建
 *
 * 输入：
 *   · groups   drawing.js 的 collectGroups() 结果 [{key, name, kind, leafKeys}]
 *   · rows     xlsx.js 读出的二维数组（第一行是表头）
 *
 * 输出：
 *   · columns   识别到的列映射（可被用户覆盖）
 *   · hotspots  每个 Excel 数据行 → 一个热点（可多行指向同一分组）
 *   · matched / unmatchedGroups / unmatchedRows  匹配报告
 *
 * 匹配策略（从强到弱，逐级回退）：
 *   1. 完全相等（trim 后）
 *   2. 规范化后相等：去序号前缀（000_）、去扩展名、去 _612 之类的后缀、
 *      统一小写、去掉空格/下划线/连字符
 *   3. 包含关系（一方是另一方子串，且长度差不超过阈值）
 *   4. 编辑距离相似度 ≥ 阈值（默认 0.72）
 */

/* ------------------------- 列名识别 ------------------------- */

/** 常见表头别名（全部按小写比较） */
const ALIAS = {
  name: [
    '分组', '分组名', '分组名称', '组名', '零件', '零件名', '零件名称', '名称', '部件',
    '装配', '装配体', '节点', '节点名', '模型', '对象', '对象名',
    'group', 'groupname', 'group name', 'part', 'partname', 'part name',
    'name', 'component', 'assembly', 'node', 'item', 'object',
  ],
  label: [
    '编号', '序号', '热点', '热点号', '热点编号', '标记', '标号', '号码', '数字',
    'no', 'no.', 'number', 'num', 'id', 'index', 'seq', 'code', 'tag', 'mark',
    'hotspot', 'balloon', 'callout',
  ],
  title: [
    '检验项目', '检查项目', '检测项目', '检验', '检查', '检测', '项目', '工序',
    '要求', '规范', '标准', '标题', '名称说明', '说明', '描述', '备注', '内容',
    'title', 'desc', 'description', 'note', 'remark', 'comment', 'spec', 'requirement',
    'check', 'inspect', 'criterion', 'item',
  ],
  qty: ['数量', '件数', 'qty', 'quantity', 'count', 'amount'],
};

const norm = (s) => String(s == null ? '' : s)
  .replace(/^\s+|\s+$/g, '')
  .toLowerCase();

/**
 * 从表头行识别列。返回 {name, label, title, qty, extra: [{index, header}]}
 * 识别不出来时，按位置兜底（第 1 列分组名，第 2 列编号）。
 */
export function detectColumns(headerRow) {
  const cols = { name: -1, label: -1, title: -1, qty: -1, extra: [] };
  const taken = new Set();

  const score = (header, aliases) => {
    const h = norm(header);
    if (!h) return 0;
    for (const a of aliases) {
      if (h === a) return 3;
    }
    for (const a of aliases) {
      if (h.includes(a) || a.includes(h)) return 2;
    }
    return 0;
  };

  // 每个字段挑得分最高的列，避免同一列被两个字段抢走
  for (const field of ['name', 'label', 'title', 'qty']) {
    let best = -1;
    let bestScore = 0;
    for (let i = 0; i < headerRow.length; i++) {
      if (taken.has(i)) continue;
      const s = score(headerRow[i], ALIAS[field]);
      // name 优先，避免"零件编号"被 label 抢走
      const bonus = field === 'name' ? 0.3 : 0;
      if (s + bonus > bestScore) { bestScore = s + bonus; best = i; }
    }
    if (bestScore >= 2) {
      cols[field] = best;
      taken.add(best);
    }
  }

  // 兜底：没有识别到分组名列 → 第 1 列；没有编号列 → 第 2 列（若有）
  if (cols.name < 0 && headerRow.length) { cols.name = 0; taken.add(0); }
  if (cols.label < 0) {
    for (let i = 0; i < headerRow.length; i++) {
      if (!taken.has(i)) { cols.label = i; taken.add(i); break; }
    }
  }
  // 其余列作为附加信息
  for (let i = 0; i < headerRow.length; i++) {
    if (!taken.has(i)) cols.extra.push({ index: i, header: String(headerRow[i] || `列${i + 1}`) });
  }
  return cols;
}

/* ------------------------- 名称规范化 ------------------------- */

/**
 * 名称规范化，两个级别：
 *
 *   stripTail = false  —— 只去扩展名 / 前导序号（000_）/ 空白 / 小写。
 *                         保留尾部的 `_612`、`_1007` 等编号。
 *   stripTail = true   —— 额外去掉尾部 3~4 位数字后缀。
 *
 * 为什么要两级：
 *   尾部的编号有时是**区分不同零件的关键**（Flywheel_..._1007 vs _1026 vs _1045
 *   是 65 个不同零件），有时又只是导出噪声（U_Bracket_612 → U_Bracket）。
 *   单用哪一级都会错，所以匹配时逐级尝试、只有唯一命中才采纳。
 */
export function normalizeName(s, stripTail = false) {
  let v = String(s == null ? '' : s).trim();
  if (!v) return '';
  // 去扩展名
  v = v.replace(/\.(jt|jtm|prt|asm|step|stp|igs|iges|x_t|model)$/i, '');
  // 去前导序号：000_ 12- 3. 4空格
  v = v.replace(/^[\d]{1,4}\s*[_\-.、．)）]\s*/, '');
  if (stripTail) {
    // 去 JT 常见尾缀：_612 / _1007 / -1
    v = v.replace(/[_\-.\s]+\d{3,4}$/, '');
  }
  /*
   * 不能折叠或抹掉下划线：Sump_flange_fastener__204__118 与
   * Sump_flange_fastener_204_118 是两个不同零件，归一后会撞名。
   */
  v = v.replace(/\s+/g, '');
  v = v.replace(/^[_\-./\\]+|[_\-./\\]+$/g, ''); // 去掉首尾分隔符
  return v.toLowerCase();
}

/** Levenshtein 相似度 0..1 */
export function similarity(a, b) {
  if (a === b) return 1;
  const la = a.length, lb = b.length;
  if (!la || !lb) return 0;
  if (Math.abs(la - lb) / Math.max(la, lb) > 0.6) return 0;
  // 两行滚动数组
  let prev = new Array(lb + 1);
  let cur = new Array(lb + 1);
  for (let j = 0; j <= lb; j++) prev[j] = j;
  for (let i = 1; i <= la; i++) {
    cur[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= lb; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  const dist = prev[lb];
  return 1 - dist / Math.max(la, lb);
}

/* ------------------------- 匹配 ------------------------- */

/**
 * 把 Excel 数据行匹配到分组。
 *
 * @param {Array<{key:string,name:string}>} groups
 * @param {string[][]} rows 含表头的二维数组
 * @param {{columns?:object, threshold?:number, headerRow?:number}} opts
 * @returns {{
 *   columns: object,
 *   hotspots: Array<{groupKey, groupName, label, title, qty, extra, rowIndex, matchType, matchScore}>,
 *   matched: Map<string, object[]>,
 *   unmatchedGroups: Array<object>,
 *   unmatchedRows: Array<object>,
 *   warnings: string[],
 * }}
 */
export function matchSheet(groups, rows, opts = {}) {
  const headerRow = opts.headerRow ?? 0;
  const header = rows[headerRow] || [];
  const columns = opts.columns && opts.columns.name >= 0
    ? { ...detectColumns(header), ...opts.columns }
    : detectColumns(header);
  const threshold = opts.threshold ?? 0.72;

  const warnings = [];
  if (columns.name < 0) warnings.push('未能识别"分组名"列，请手动指定');
  if (columns.label < 0) warnings.push('未能识别"编号"列，热点编号将自动生成');

  // 预建索引：三级键，逐级尝试
  //   raw     —— 原样（trim + 小写），最严格
  //   norm    —— 去前导序号/扩展名，保留尾部编号
  //   normLoose —— 再去尾部编号，用于 U_Bracket_612 → U_Bracket 这类
  const byRaw = new Map();
  const byNorm = new Map();
  const byLoose = new Map();
  const push = (map, key, g) => {
    if (!key) return;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(g);
  };
  for (const g of groups) {
    push(byRaw, norm(g.name), g);
    push(byNorm, normalizeName(g.name, false), g);
    push(byLoose, normalizeName(g.name, true), g);
  }

  const hotspots = [];
  const matched = new Map();
  const unmatchedRows = [];
  const ambiguousRows = [];

  const dataStart = headerRow + 1;
  for (let r = dataStart; r < rows.length; r++) {
    const row = rows[r];
    if (!row || row.every((c) => c == null || String(c).trim() === '')) continue; // 空行

    const rawName = columns.name >= 0 ? String(row[columns.name] ?? '').trim() : '';
    if (!rawName) { unmatchedRows.push({ rowIndex: r, reason: '分组名为空', row }); continue; }

    // ---- 逐级匹配 ----
    //  1. 原样精确 —— 命中几个就取几个（同名零件天然共享一个热点编号，
    //     比如 10 个 screw 都该指向 Excel 里的同一行）
    //  2~5. 规范化 / 去尾号 / 包含 / 编辑距离 —— 这几级要求**唯一命中**，
    //     因为它们是"猜"的，猜出多个就只能算不确定。
    let hits = byRaw.get(norm(rawName)) || null;
    let matchType = hits ? 'exact' : null;
    let matchScore = hits ? 1 : 0;

    if (!hits) {
      const h2 = byNorm.get(normalizeName(rawName, false));
      if (h2 && h2.length >= 1) { hits = h2; matchType = 'normalized'; matchScore = 1; }
    }
    if (!hits) {
      const h3 = byLoose.get(normalizeName(rawName, true));
      if (h3 && h3.length >= 1) { hits = h3; matchType = 'tail-stripped'; matchScore = 0.95; }
    }
    if (!hits) {
      const n = normalizeName(rawName, true);
      let bestKey = null;
      let bestScore = -Infinity;
      for (const key of byLoose.keys()) {
        if (!n || !key) continue;
        if (key.includes(n) || n.includes(key)) {
          const score = Math.min(n.length, key.length) - Math.abs(key.length - n.length) * 0.5;
          if (score > bestScore) { bestScore = score; bestKey = key; }
        }
      }
      if (bestKey) {
        const cand = byLoose.get(bestKey);
        if (cand.length === 1) { hits = cand; matchType = 'contains'; matchScore = 0.85; }
      }
    }
    if (!hits) {
      const n = normalizeName(rawName, true);
      let bestKey = null;
      let bestSim = 0;
      for (const key of byLoose.keys()) {
        const s = similarity(n, key);
        if (s > bestSim) { bestSim = s; bestKey = key; }
      }
      if (bestKey && bestSim >= threshold) {
        const cand = byLoose.get(bestKey);
        if (cand.length === 1) { hits = cand; matchType = 'fuzzy'; matchScore = bestSim; }
      }
    }

    if (!hits || !hits.length) {
      unmatchedRows.push({ rowIndex: r, name: rawName, reason: '找不到对应分组', row });
      continue;
    }

    const label = columns.label >= 0 ? String(row[columns.label] ?? '').trim() : '';
    const title = columns.title >= 0 ? String(row[columns.title] ?? '').trim() : '';
    const qty = columns.qty >= 0 ? String(row[columns.qty] ?? '').trim() : '';
    const extra = columns.extra.map((c) => ({ header: c.header, value: String(row[c.index] ?? '').trim() }))
      .filter((e) => e.value !== '');

    const hs = {
      groupKeys: hits.map((g) => g.key),
      groupNames: hits.map((g) => g.name),
      groupKey: hits[0].key,          // 兼容单值时取第一个
      groupName: hits[0].name,
      label,
      title,
      qty,
      extra,
      rowIndex: r,
      excelName: rawName,
      matchType,
      matchScore,
    };
    hotspots.push(hs);
    for (const g of hits) {
      if (!matched.has(g.key)) matched.set(g.key, []);
      matched.get(g.key).push(hs);
    }
  }

  // 编号补齐：Excel 没给编号的行，按出现顺序补 1..N（跳过已用的号）
  const used = new Set(hotspots.map((h) => h.label).filter(Boolean));
  let next = 1;
  for (const h of hotspots) {
    if (h.label) continue;
    while (used.has(String(next))) next++;
    h.label = String(next);
    used.add(h.label);
    next++;
  }

  // 报告：没有热点覆盖的分组
  const unmatchedGroups = groups.filter((g) => !matched.has(g.key));

  return { columns, hotspots, matched, unmatchedGroups, unmatchedRows, warnings, header };
}

/**
 * 把匹配结果渲染成可读的报表文本（便于核对/贴日志）。
 */
export function formatReport(result, limit = 40) {
  const { hotspots, unmatchedGroups, unmatchedRows, warnings } = result;
  const lines = [];
  // 一条 Excel 行可能命中多个同名分组，统计时要展开
  const covered = new Set();
  for (const h of hotspots) {
    const keys = h.groupKeys && h.groupKeys.length ? h.groupKeys : [h.groupKey];
    for (const k of keys) covered.add(k);
  }
  lines.push(`Excel 数据行 ${hotspots.length} 条 → 热点覆盖 ${covered.size} 个分组`);
  const byType = hotspots.reduce((m, h) => (m[h.matchType] = (m[h.matchType] || 0) + 1, m), {});
  lines.push(`匹配方式: ${Object.entries(byType).map(([k, v]) => `${k}=${v}`).join('  ')}`);
  if (warnings.length) lines.push('警告: ' + warnings.join('；'));
  if (unmatchedRows.length) {
    lines.push(`未匹配的 Excel 行 ${unmatchedRows.length} 条:`);
    for (const r of unmatchedRows.slice(0, limit)) {
      lines.push(`  行${r.rowIndex + 1}  ${r.name || '(空)'}  — ${r.reason}`);
    }
  }
  if (unmatchedGroups.length) {
    lines.push(`没有热点的分组 ${unmatchedGroups.length} 个:`);
    for (const g of unmatchedGroups.slice(0, limit)) lines.push(`  ${g.name}`);
  }
  const fuzz = hotspots.filter((h) => h.matchType === 'fuzzy' || h.matchType === 'contains');
  if (fuzz.length) {
    lines.push(`模糊匹配 ${fuzz.length} 条（建议核对）:`);
    for (const h of fuzz.slice(0, limit)) {
      lines.push(`  行${h.rowIndex + 1}  Excel「${h.excelName}」→ 分组「${h.groupName}」  ${(h.matchScore * 100).toFixed(0)}%`);
    }
  }
  return lines.join('\n');
}
