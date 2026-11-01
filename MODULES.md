# 模块说明 —— 代码位置与作用

> 本文对应仓库当前代码，逐个模块说明"在哪、干什么、怎么配合"。
> 使用与安装见 [README.md](README.md)，工程背景与踩坑记录见 [HANDOVER.md](HANDOVER.md)。

## 总览

```
webjt/
├── app.py                 后端：FastAPI，静态页 + JT 打开/上传 + 网格下发 + 导出落盘
├── jtio.py                后端：JT 读取层（层级树 + 三角网格，底层调 D:\JT\pydxjt）
├── exportkit.py           后端：图册三件套落盘（SVG→PNG→GIF，Edge 无头渲染 + Pillow）
├── selftest.py            后端自检
├── start.cmd              一键启动
├── static/
│   ├── index.html         前端整页 UI（左树右 3D + 出图面板）
│   └── js/
│       ├── drawing.js     核心：3D → A4 二维线图（投影/消隐/排版/热点/SVG）
│       ├── hlr.js         消隐之一：解析法（几何精确，默认）
│       ├── hlr_raster.js  消隐之二：光栅法（深度图采样，备选）
│       ├── cgm.js         ISO 8632-3 二进制 CGM 写入器
│       ├── sheetcgm.js    图层中间表示 → CGM 文件
│       ├── xlsx.js        最小 XLSX 读取器（纯 JS，读检验表）
│       ├── hotspot-map.js Excel 表 ↔ 装配分组匹配，生成热点表
│       └── ai-place.js    大模型辅助热点布点（排版问题 → JSON 坐标）
└── tools/                 自动化测试与验证脚本（Node/Python，见下文）
```

## 后端（Python）

### `app.py` —— FastAPI 后端
启动：`python app.py` → <http://127.0.0.1:8770>。

| 路由 | 作用 |
|---|---|
| `GET /` | 前端页面（静态托管 `static/`，带 NoCache） |
| `GET /api/samples` | 列样本目录下的 .jt / 装配文件夹 |
| `POST /api/open` / `POST /api/upload` | 打开本机 JT（或装配文件夹）/ 上传 .jt |
| `GET /api/tree/{doc_id}` | 装配层级树 |
| `GET /api/mesh/{doc_id}?key=` | 单节点三角网格（二进制 JTM1，浏览器端组装） |
| `POST /api/export/plate` | 图册三件套落盘：浏览器算好的 SVG + CGM(base64) → 写 CGM/SVG，并渲染 A4 300dpi GIF |
| `GET /api/export/file` | 把 `out/` 里的产物回吐下载（防路径穿越） |
| `GET /api/docs`、`DELETE /api/doc/{doc_id}` | 已开文档管理 |

> 注：前端 `ai-place.js` 调用的 `/api/ai/chat` 转发路由**尚未实现**（模型类 `AiRequest` 已定义），
> 属规划中的待办：接入后 Key 只留在服务端内存，不落盘。

### `jtio.py` —— JT 读取层
- 打开 ISO 14306 `.jt`（含 JT 10.10 版本头兼容补丁），产出装配树 + 每节点三角网格
- 兜底：NX 导出的"装配 .jt + 同名零件文件夹"结构读不了时，按文件夹零件建树（子文件自带世界坐标）
- 网格按需加载 + 缓存（`REGISTRY`），供前端按节点拉取

### `exportkit.py` —— 图册三件套落盘
浏览器端出图（保证所见即所得），这里只负责：
- `render_svg_to_png()`：本机 Edge 无头模式把 SVG 精确光栅化成 A4 300dpi PNG
- `png_to_gif()`：Pillow 量化 256 色 GIF（与 CGM/SVG 同名同版式）
- `export_plate()`：一次写 `<图号>.cgm/.svg/.gif` 三个文件

## 前端（static/js）

### `drawing.js` —— 核心：从 3D 场景生成 A4 二维线图
约 2300 行，屏幕预览与 CGM 导出共用同一套几何，单位统一毫米（与 A4 同坐标系）。

主流程：
1. `collectGroups()` 按层级树顶层节点分组
2. `projectGroup()` / `projectGroupScreen()` / `projectManyScreen()` 正交投影出特征边 + 三角面（屏幕毫米坐标）
3. 消隐（`removeHiddenLinesGrouped()`，见下）—— **整机一次投影一次消隐**，外壳才能遮住内部零件
4. `buildSheet()` 排到 A4：图册版面（plate）/ 取景框（frame）/ 整机（single）/ 分格（grid，装不下自动分页）
5. `placeHotspots()` 热点布点（数字 + 正交引线），`checkHotspotOverlap()` 复检重叠
6. `sheetPageToSVG()` / `sheetToSVGMultiPage()` 出 SVG（disjoint 段逐段 `M/L`，圆头圆角）
7. `dashSegments()` 物理切短划（隐藏线备用，当前默认不画隐藏线）

关键参数集中在头部常量：`A4` / `SHEET`（图框）/ `HOTSPOT`（标注规范）/ `LEGEND` / `PLATE`（图册版面）/ `FRAME`。

### `hlr.js` —— 解析消隐（默认）
线段 ∩ 凸多边形求遮挡参数区间的**几何精确**解：把每条边与投影后三角面做 1D 深度差函数，解 `f(t) > 0` 的精确区间。没有采样，就没有"贴面可见边被误判遮挡"的问题。空间网格 + `triNear` 粗剔除保证大装配（295 件）约 2s。

返回 `{ segVisible, segHidden }`：segHidden 是被遮挡区间（当前不画，留作可选"隐藏线"开关）。

### `hlr_raster.js` —— 光栅消隐（备选）
深度图 + 逐点采样的经典做法，观感"稳"但对贴面边有系统性误删（实测低容差下只保住 64% 可见线长——这就是"可见线消失"的根源），现在只在显式传 `{ method: 'raster' }` 时启用。

### `cgm.js` —— ISO 8632-3 二进制 CGM 写入器
纯 JS 无依赖，按标准写：命令头（class|id|len，短/长格式）、字对齐补齐、IEEE 754 float32 VDC。元素表 `EL`、线型枚举 `ENUM`。`LINE TYPE` 只在虚线项时写（实线不写冗余元素——部分查看器对大量 LINE TYPE 异常）。

### `sheetcgm.js` —— 图层中间表示 → CGM
- A4 = VDC extent (0,0)-(210,297)，SCALING METRIC，1 VDC = 1 mm，1:1 打印尺寸即准
- 棱边用 DISJOINT POLYLINE（每两点一段）；图框/引线用 POLYLINE
- 每个热点先写 `PICK IDENTIFIER`（查看器里点热点能取到编号）；热点数字 = 纯编号无外框
- 多页 = 多 PICTURE（分格装不下自动分页）

### `xlsx.js` —— 最小 XLSX 读取器
ZIP 中央目录 + raw deflate + 单元格抽取（共享字符串/内联/数值/日期序列号），读检验表的编号-名称列。

### `hotspot-map.js` —— Excel ↔ 分组匹配
把 xlsx 读出的行映射到 `collectGroups()` 的分组（列映射可手动覆盖），产出热点表（编号、名称、数量、附加列）。

### `ai-place.js` —— 大模型辅助布点
把排版问题（可用区、锚点、包围盒、最小间距）结构化成 JSON 发给大模型，只要回 `{id,x,y}`；前端 `sanitizePositions()` 夹取越界 + 去重叠 + 网格回落，模型输出再离谱也不会画飞。接口地址/Key/模型名存 localStorage（只留本机）。**依赖后端 `/api/ai/chat` 转发（待接入）**。

## 前端页面 `static/index.html`
单页应用，模块化 script type=module 引入上面所有 js：
- 左侧装配树 + 右侧 three.js 3D（爆炸、透明、剖切、消隐线框预览）
- 右侧出图面板：视向（等轴测默认/当前视角/前/俯/右）、整机/分格、图册、消隐开关、图号、Excel 匹配、AI 布点
- 取景框模式：所见即所得（框选 3D 视口 → 直接映射 A4）
- 出图产物预览 + 一键下载 CGM / 三件套导出

## tools/ —— 自动化测试与验证

| 脚本 | 作用 |
|---|---|
| `ui-plate-test.mjs` | 端到端：无头 Edge 打开 JT → 点"生成图册" → 导出三件套 → 落盘 `out/`（CDP 端口 9333） |
| `ui-cgm-dl-test.mjs` | 复刻"直接点下载 CGM"的用户路径，捕获 blob 保存（CDP 9335） |
| `ui-visual-ab.mjs` | 3D 截图 + A4 取景框 SVG 对照（CDP 9340） |
| `ui-hlr-tune.mjs` | 消隐调参探针：同一投影跑 analytic / raster 各容差，统计可见线长（CDP 9337） |
| `verify-plate.mjs` | CGM 图册校验 16 项（版式/热点/引线/字高/图区） |
| `verify-cgm.mjs` | CGM 结构校验 13 项（元文件头/VDC/字体/可拾取性） |
| `make-sheet.mjs` | 独立出一张 A4 线图（不依赖浏览器 UI） |
| `make-plate.py` / `make-test-xlsx.py` / `dump-mesh.py` | 样例数据与调试工具 |
| `ui-*-check.mjs` | 各专项回归（翻转/朝向/基向量/取景框角点…） |

## 关键设计决定（为什么是这样）

1. **消隐默认解析法**：光栅法有贴面边误删（用户可见线消失），解析法几何精确且 295 件 ~2s。
2. **不画隐藏线**：用户拍板"看不见的不显示"；segHidden 数据保留，将来做可选开关。
3. **CGM 里 LINE TYPE 只在虚线写**：实线不写冗余元素，部分查看器（Cortona2D）对大量 LINE TYPE 渲染异常。
4. **服务端不重算几何**：图册导出时版式已在浏览器算好，后端只落盘 + 渲染 GIF，保证两条路径不漂移。
5. **取景框模式与等轴测是两套坐标来源**：前者屏幕→A4 映射，后者固定视向正交投影；不要合并。

## 已知待办

- [ ] `/api/ai/chat` 后端转发路由未实现（`AiRequest` 模型已就位）
- [ ] 光栅消隐（hlr_raster.js）贴面误删问题：如需启用需先修 3×3 min 采样偏置
