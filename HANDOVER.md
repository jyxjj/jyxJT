# JT Browser —— 交接文档

> 最后更新：加入「图册版面 + 三件套（CGM/SVG/GIF）」。本文档给接手的人看：
> **它是什么、怎么跑、代码怎么组织、哪些地方踩过坑、哪里还能改**。
>
> 更偏使用说明的内容在 `README.md`；本文偏工程交接。

---

## 一、这个东西是干什么的

用 **Python + Web** 复刻 NX 的两个能力：

1. **JT 识别与线框预览** —— 直接读 ISO 14306 的 `.jt`，左栏出装配层级，右边 three.js 实时 3D
2. **JT → A4 二维线图 + 热点标注** —— 出 CGM（ISO 8632）、SVG、GIF，编号（热点）自动布点

典型场景：把装配的 JT 丢进来，在 3D 里拖动零件做爆炸图，然后出一张带编号的 A4 检验图，
交给下游做尺寸/外观检验。

**产物**：`<图号>.cgm`（主）、`<图号>.svg`（矢量预览）、`<图号>.gif`（A4 300dpi 位图），
三件套**同名、同版式**，对齐甲方模板 `HTEAM-04021`。

---

## 二、怎么跑

```bat
cd D:\JT\webjt
python app.py            :: 或者双击 start.cmd
:: 浏览器打开 http://127.0.0.1:8770
```

**依赖**

| 侧 | 依赖 | 说明 |
|---|---|---|
| 后端 | Python 3.12、fastapi、uvicorn | `pydxjt`（`D:\JT\pydxjt`）读 JT，走 `sys.path` 注入 |
| 后端 | Pillow | **GIF 量化**（`exportkit.png_to_gif`） |
| 后端 | 本机 Edge / Chrome | **SVG → PNG**（无头渲染，A4 300dpi）；找不到浏览器时三件套会报错 |
| 后端 | 无 | 不需要 NX；**本版本不调用 NX** |
| 前端 | three.js r169 | 已 vendored 到 `static/vendor/`，不联网 |
| 工具 | Node 24（可选） | `tools/` 下的命令行出图与 CGM 校验用 |

**JT 读取链**：`jtio.py` → `pydxjt`（ctypes）→ `dxjt_shim.dll` → `dxjt_toolkit.dll` + `libdximpjt.dll`。
JT 10.10 的头会被就地改写成 10.5 再交给它读（写进 `_cache/`，不动原文件）。

---

## 三、目录与文件职责

```
webjt/
├── app.py                  FastAPI 后端（含 /api/export/plate 三件套落盘）
├── exportkit.py            SVG→PNG（Edge 无头）→GIF；按图号写三件套
├── jtio.py                 JT 读取 + 版本头修补 + 网格序列化（核心资产）
├── selftest.py             后端自检
├── start.cmd               一键启动
├── JT热点分组模板.xlsx      Excel 导入模板
│
├── static/
│   ├── index.html          单页前端：树 / three.js / 出图面板 / 分组 / IPC / 连线
│   └── js/
│       ├── drawing.js      出图核心：分组→提边→投影→消隐→A4 排版→热点→SVG（含 PLATE 图册版面）
│       ├── hlr.js          解析消隐（线段 ∩ 三角面求遮挡区间）
│       ├── cgm.js          ISO 8632 二进制写入器
│       ├── sheetcgm.js     图层中间表示 → CGM
│       ├── xlsx.js         最小 XLSX/CSV 读取器（无第三方库）
│       ├── hotspot-map.js  Excel ↔ 分组 匹配
│       └── ai-place.js     AI 布点：组包 / 调模型 / 解析 / 校验
│
├── tools/
│   ├── make-sheet.mjs      命令行出图（--plate 走图册版面）
│   ├── make-plate.py       ★ 命令行出三件套 + 自动校验
│   ├── verify-cgm.mjs      独立 CGM 解析器 + 13 项结构校验  ← 传统版面验收
│   ├── verify-plate.mjs    ★ 图册规格 16 项校验            ← 图册验收
│   ├── ui-plate-test.mjs   Edge CDP 跑一遍界面链路（不等人工点）
│   └── dump-mesh.py / make-test-xlsx.py
├── out/                    三件套输出目录（>400 个文件自动清理最旧的）
├── _test/                  测试数据（coffee.json / 分组表 / mock-ai.py）
└── _shots/sheet/           各功能截图，README 里引用
```

---

## 四、核心数据流

```
JT 文件
  │  jtio.Document._build()
  ▼
层级树 JSON + 每个叶子的三角形网格（二进制 JTM2，按需懒加载）
  │  GET /api/open  →  GET /api/mesh/{doc}/{key}
  ▼
浏览器：S.meshes（key → {group, body, edge}）
  │
  ├─ 3D 预览：three.js + OrbitControls
  │    左键单击=选取 / 左键拖动=框选 / 右键=拖动零件 / Alt+左键=旋转 / 中键=平移
  │
  └─ 出图：
       collectGroups(树)  或  自定义分组
        → projectGroup / projectGroupScreen（3D → 2D uv）
        → removeHiddenLines（解析消隐）
        → buildSheet（A4 排版 + 热点布点 + 图例；plate 模式走图册版面）
        → sheetToSVG / sheetToCgm
        → POST /api/export/plate（后端：落盘 + Edge 渲染 PNG + Pillow 量化 GIF）
```

**关键：3D 与 2D 是两条独立的取线路径。**
3D 用 `THREE.EdgesGeometry(geo, 20)`；2D 用 `drawing.js` 里自己的 `buildEdgeTable`。
两者判据都对齐了 `|dot| <= cos(20°)`，但实现不同，边数差约 1.5%。

---

## 五、关键算法与踩过的坑

### 1. CGM 写入（`cgm.js`）

- 16 位命令头：`class(4bit) | id(7bit) | len(5bit)`；`len==31` 表示长格式，后跟 16 位长度
- 单个元素参数 **不得超过 32767 字节** → `polyline()` 自动按 4000 点切片
- 多个不相连的线段必须用 **DISJOINT_POLYLINE(4,2)**，用 POLYLINE 会把它们首尾连起来
- 16 位对齐补齐


### 1.5 视向基向量（`basisFor` / `currentBasis`）
出图和 3D 视图必须同一个朝向，否则图会"反了"。

three.js `Matrix4.lookAt` 的约定（`vendor/three.module.js` 里 `_z = eye − target`，`_x = up × _z`，
`_y = _z × _x`）就是权威参照：**相机右矢 = upHint × 后向**。基向量必须按这个语义来算：

- `basisFor(view)` 固定视向：`dir = CAM[view]` 本身就是**后向**（相机位置方向，与 fitView 摆放一致），
  所以 `right = upHint × dir`、`up = dir × right`。
- `currentBasis()` 当前视角：`dir = target − eye` 是**前向**，公式恰好相反：
  `right = dir × (0,1,0)`、`up = right × dir`。
  注意 `dir × (0,1,0)` 恒等于 lookAt 的相机右矢（展开即 `(−dir.z, 0, dir.x)`），**包括近极点**，
  所以这里不需要换 upHint 轴，只有恰在极点（叉积零向量，OrbitControls 实际到不了）才兜底。

两处公式看似"不统一"，其实都是 lookAt 同一约定的展开，**不要强行统一**，否则必镜像其一。

踩过的坑（用户报"浏览器看视角还是反着的"）：

1. 固定视向曾写成 `right = dir × upHint`（把后向当前向用）→ 等轴测/前/顶/右整张图左右镜像。
2. 近极点 upHint 曾固定取 `(0,0,1)`：顶视时 lookAt 的真实滚转是"屏幕上 = −Z"（up 恒为世界 +Y，
   滚转由视线水平分量的反方向决定），固定 `(0,0,1)` 会给出转 180° 的一套。
   正确做法：`upHint = −(dir 的水平分量).normalize()`（俯视得 (0,0,−1)、仰视得 (0,0,+1)）。
3. 排查手段：**别用配对/直方图探针**——直列发动机整机左右对称，分布统计没有分辨力，
   会出现两个探针结论打架。决定性方法是 `tools/ui-basis-check.mjs`：把相机真摆到该视向 pose，
   对比 basisFor 复刻公式与 camera.matrixWorld 的 right/up 点积，全 +1 才算过。

深度定义不受影响：`dep = -(dir·p)`，越小越靠近相机（对前向/后向 dir 都成立）。

### 2. 消隐（`hlr.js`）—— 这是本轮最大的改动

旧做法是**光栅深度图 + 3×3 采样**。三个致命缺陷：

- 采样点和边的采样点不重合 → 贴着表面的**可见边被判成遮挡**，线条碎成虚线
- 只能回答"这一点可见/不可见"，可见段被切成采样粒度的小段
- 容差是全局的，装配体深度跨一大怎么调都不对

现在的做法是**解析求交**：

1. 每条棱边投影成二维线段，和投影后的三角面做**线段 ∩ 凸多边形**（Liang–Barsky 半平面裁剪）
2. 得到被遮挡的精确参数区间 `[t0,t1]`
3. 区间内深度差是 `t` 的一次函数，解出真正被遮挡的子区间
4. 从 `[0,1]` 里减掉 → 精确可见段

**加速**（整机 26412 边 / 72351 三角，从 2.3 s 降到 1.47 s）：

| 手段 | 效果 |
|---|---|
| 三角面塞进二维均匀网格 | 每条边只查附近三角形 |
| 沿线段走格子（Amanatides–Woo），不取包围盒矩形 | 长斜边候选少很多 |
| 预存每个三角面的"最近深度"，比边的最远深度还靠后就跳过 | 测试数 28.5M → 16.6M |

**容差 `eps`**：只用来吸收浮点噪声，`max(spanD*5e-4, span*1e-5, 1e-9)`。
不要再放大 —— 放大到能"解决"某些零件时就说明是别的问题。

### 3. 提边（`buildEdgeTable`）

- 按位置焊接顶点（`Math.round(pos*1e4)`），JT 常按面拆顶点
- 判据必须写 **`Math.abs(dot) <= cos(thresh)`**：
  写成 `dot < cos` 会把**反绕序三角形**（点积 −1）误判成 180° 硬边。
  JT 里有 1~3% 的三角形绕序是反的。
- **共面判据**：平面被剖成两个三角形后，法线可能因为 float32 误差刚越过 20°，
  平面上就会冒出一条斜对角剖分线。所以再判一次"对面顶点到本三角形平面的距离"：

  ```js
  const tol = 2e-3 * max(两个三角形的最长边);   // 必须按三角形尺寸算
  if (d1 <= tol && d2 <= tol) feature = false;
  ```

  **容差不能按零件包围盒算** —— 薄壁件的包围盒对角线比壁厚大两个数量级，
  按它算会把真实棱边一起误杀（实测热点 28 → 19，零件整块消失）。

### 4. 热点布点（`placeHotspots`）

默认逻辑：

1. **以一组为准**，求该组二维线条的**边缘矩形**
2. 锚点取沿"向外方向"投影**最远的那个图线端点**（在边缘矩形上，且真的落在图线上）
3. 编号沿正交方向往外让出 `数字半宽 + 1.8mm`
4. 同一组多条热点沿垂直方向等距排开

**不折叠的三道保险**（顺序不能改）：

1. 迭代推开（**循环里不夹取**，夹取会把热点推回重叠位置）
2. 循环结束后夹进可用区
3. 仍有重叠 → **网格回落**：按"离各自零件最近的空格子"分配，
   格子 = 最大热点尺寸 + 间隙，**构造上不可能重叠**

`checkHotspotOverlap(sheetData)` 是验收函数，返回 `{overlaps, pairs, minDist, count}`。

**图例带有硬上限**（不超过绘图区 40%，且必须给绘图区留两格高度）——
不加这个上限时，图例一多就把格子高度压成负数，整格被 `return` 跳过，
**零件和热点一起消失**。这个坑排查了很久。

### 5. 热点样式 = CGM 语义

`HOTSPOT.style = 'cgm'`（默认）：**只有数字，不画外框**，编号靠 `PICK IDENTIFIER` 表达；
引线是**横平竖直**的折线（锚点 →(水平)→ 折点 →(竖直)→ 数字）。
`'balloon'` 是旧的椭圆气球样式，保留没删。

### 5.5 图册版面（`PLATE`，对齐 HTEAM-04021）

模板是别人给的一张 A4 GIF/SVG/CGM，**没有源文件**，所以规格全是从模板上**量**出来的：

| 量什么 | 怎么量 | 结果 |
|---|---|---|
| 图号位置 | 找页面顶部唯一的墨迹块 | 墨迹 x 10.2–53.7mm，y(自上而下) 12.1–17.1mm |
| 图号字高 | 墨迹高 5.0mm ÷ Arial cap 比例 0.716 ≈ 4.91 | `PLATE.titleHeight = 4.91` |
| 绘图区 | 页面中段墨迹块的包围盒 | x 17.5–202.0，y 81.7–195.1 |
| 引线 | 模板 SVG 里 `<path d="M70,42.972 L64.841,42.972"/>` | 长 **5.16mm**；数字左边缘 x=71，线端 64.841 → 留 **1.0mm** |
| 热点字高 | 模板 SVG `<text font-size="2.82">` × 0.716 | **2.056mm**（和原规范一致） |
| 线宽 | GIF 墨迹竖跑长 2px × 0.0846mm/px | 0.15mm |

实现要点：

1. `buildSheet({ plate: true, drawingNo })` —— 强制单页单视图、不画图框/图例/分格标题，
   图形区固定成 `PLATE.area`，排版时再扣掉一圈标注边距（否则靠边的热点被夹回来、引线缩水）。
2. 热点 = **数字 + 一条正交短引线**，数字和引线**成对输出**，各自带同一个 `PICK IDENTIFIER`。
3. 引线算法：模板是"直线 5.16mm"，但一张整机图 70+ 个热点必然触发去重叠，
   数字会被推开。所以**第一段永远严格 5.16mm**，多出来的位移用一段正交折线吸收 → 永远没有斜线。

### 5.6 图册三件套（CGM / SVG / GIF）

浏览器算几何 → 同一份中间表示出 SVG 和 CGM → `POST /api/export/plate` 落盘：

```
<图号>.cgm   sheetToCgm（ISO 8632-3；PICK IDENTIFIER；A4 METRIC）
<图号>.svg   sheetToSVG（逐点一致）
<图号>.gif   sheetToSVG → Edge 无头渲染 A4 300dpi PNG → Pillow 量化 256 色
```

**为什么 GIF 非要走后端**：浏览器没有 GIF 编码器；用 Edge 渲染 SVG 能保证
"GIF 和 SVG/CGM 是同一张图"，不会出现两套排版。

**踩过的坑**：模板 `HTEAM-04021.cgm` 是 **CGM 1999 (version 4) + 私有字符串编码**，
`uniconvertor` / `sdk1` 都读不了（`verify-cgm` 也只认 ISO 8632-3）。
所以**不要去转模板**，而是按量出来的规格**自己重新生成**一份 ISO 8632-3 的 CGM。

**CGM 头部编码坑（2026-11-01 实测定案）**：自生成的 CGM 曾在
Cortona2D Editor Pro（用户实际查看器）里"打不开"（进程直接退出）。用最小探针
+ 真实文件二分逐字段排除后，锁定两处：

1. `COLOUR VALUE EXTENT` 必须按 `COLOUR PRECISION=8` 写 **6 个字节**
   （R/G/B 各 min,max 各 1 字节）。写成 6 个 i16（12 字节）时 Cortona2D
   按字节解析长度错位，直接退出。这也是最终的根因。
2. `REAL PRECISION` / `VDC REAL PRECISION` 写 **(0, 9, 23)** 三个 i16——
   techdraw.cgm、uniconvertor 产物、用户模板三者一致；ISO 浮点写法
   (1, 8, 23) Cortona2D 拒绝加载（uniconvertor 则报
   `Unsupported real precision (8, 23)`）。
3. 其余精度描述符写**位数**（INTEGER=16、INDEX=16、COLOUR=8、
   COLOUR INDEX=8），`MAXIMUM COLOUR INDEX` 是 1 字节。

验收流程：`uniconvertor.exe <file>.cgm <out>.svg` exit=0 **且**
Cortona2D 打开后窗口标题为 `<file>.cgm (...) - Cortona2D Editor Pro`
（标题无文件名 = 只弹了空壳窗口，等于没打开）。

### 6. Excel 匹配（`hotspot-map.js`）

两级归一化 + 多档匹配：

| 档 | 说明 |
|---|---|
| `exact` | 完全相等，**允许一对多**（多个零件共用一个编号） |
| `normalized` | 去空格/统一大小写/全角转半角 |
| `tail-stripped` | 去掉末尾 `_数字` 后再比 |
| `similar` | 相似度兜底，要求唯一才认 |

**绝对不能做**：把下划线合并。`Sump_flange_fastener__204__118` 和 `..._204_118`
合并过一次，结果一行 Excel 炸成 65 个热点。

---

## 六、验收方法

### 图册版面（默认，交付用）

```bat
:: 一条命令：出三件套 + 两项校验（全过才返回 0）
python tools\make-plate.py _test\engine.json HTEAM-04021 ^
       --sheet "_test\engine_分组表.xlsx" --out out

:: 分开跑也行
node tools\make-sheet.mjs _test\engine.json _test\p.cgm --sheet "_test\engine_分组表.xlsx" --plate --no HTEAM-04021
node tools\verify-plate.mjs _test\p.cgm --no HTEAM-04021    :: 应该是 16/16
node tools\verify-cgm.mjs   _test\p.cgm                     :: 应该是 13/13
```

`verify-plate.mjs` 是**独立实现的 CGM 解析器**（不是复用 `cgm.js`），16 项里除结构项外，
专查"像不像模板"：图号 4.91mm 且在 (9.7,280)、引线全程无斜线、第一段 5.16mm、
线端离数字 1.0mm、引线与数字按 PICK 一一对应、没有端点小圆/图例、图形落在模板绘图区内。

界面链路也能自动跑（开 Edge CDP，不弹窗）：

```bat
node tools\ui-plate-test.mjs "D:\JT\sample\07_engine_4cyl_inline_assembly_step" HTEAM-04021
:: 期望：BUILD  hotspots=72 / overlaps=0，EXPORT ✓ 已生成 …cgm / .svg / .gif
```

### 传统版面（分格 + 图例）

```bat
node tools\make-sheet.mjs _test\coffee.json _test\t.cgm --sheet "_test\分组表.xlsx" --mode grid --hlr 1
node tools\verify-cgm.mjs _test\t.cgm            :: 13/13
```

`verify-cgm.mjs` 的 13 项包含：结构无错、版本、VDC 类型/精度、METRIC 映射、
A4 幅面、Arial、字高 2.056mm、PICK IDENTIFIER、热点为纯数字（无外框）、数字文本存在。

**基准数据**（CoffeeMaker，42 组 / 15 行 Excel）：

| 指标 | 值 |
|---|---|
| 匹配 | 14/15 行（1 行故意不匹配） |
| 热点 | 28 个 |
| 页面 | 1 页 |
| 重叠 | 0 |
| CGM | 约 119 KB |

**图册基准**（`07_engine_4cyl_inline_assembly_step`，295 件）：

| 指标 | 值 |
|---|---|
| 分组 | 295 |
| 热点 | 72（整机可见零件；外壳完全遮住的不标） |
| 页面 | 1 |
| 重叠 | 0 |
| CGM / SVG / GIF | 521 KB / 1.1 MB / 317 KB |
| GIF 尺寸 | 2480×3508（A4 300dpi；模板是 2483×3508） |

---

## 七、已知限制

1. **网格 vs B-Rep**
   JT 给的是三角网格。低多边形零件（如 `bushing`，206 三角里 1/3 的边二面角接近 90°）
   出图会比 NX 多很多线。这是网格本身的剖分决定的，纯网格合不出来。
   要彻底解决必须换成 B-Rep 曲面（NX、或自建曲面重建）。

2. **分格模式不画 3D 连线**
   一条跨格子的连线没有意义，所以只在整机/取景框模式画。

3. **AI 布点依赖外部模型**
   质量取决于模型；坐标回来后会过 `sanitizePositions` + 三道保险，
   但模型漏答的热点会保持本地位置。

4. **不调用 NX**
   本轮曾接过 NX（NX Open journal 出 CGM），验证可行（能开 JT、建 A4 图纸视图、
   导出 1296 段线），但按要求**已整段回退**，代码不在仓库里。

5. **图册版面里"没有热点"不等于漏标**
   整机视图是一次性全局消隐：被外壳完全遮住的零件在图上一根线都没有，
   给它标号没有意义，所以不给它热点。295 件的发动机装配只标 72 个。
   想要"每个零件都标"就用传统分格版面（取消勾选「图册」）。

6. **图像格式**
   GIF 是 256 色调色板图，线条会有轻微色阶（模板也一样）。
   要无损就发 SVG，要 CGM 查看器/下游系统就发 CGM。

---

## 八、几个开关

| 位置 | 开关 | 默认 | 作用 |
|---|---|---|---|
| `drawing.js` `PLATE` | 图册规格常量 | 见 5.5 | 绘图区 / 图号位置 / 引线长度与间隙 / 线宽 |
| `buildSheet` `plate` | 界面勾「图册」= true | **true**（界面） | 图册版面（单视图、无图例、写图号） |
| `buildSheet` `drawingNo` | 界面「图号」 | 空 → 退回文档名 | 页面左上角那行字 + 文件名 |
| `drawing.js` `HOTSPOT.style` | `'cgm'` / `'balloon'` | cgm | 纯数字 / 椭圆气球（传统版面用） |
| `drawing.js` `HOTSPOT.leaderGap` | 1.8mm | | 传统版面里数字离零件的距离 |
| `buildSheet` `drawBorder` | false | | 是否画外围图框 |
| `buildSheet` `drawTitleBlock` | false | | 是否画标题栏 |
| `buildSheet` `labelUnmatched` | 图册/取景框强制 true | | 未匹配分组是否也编号 |
| `projectGroup` `thresholdDeg` | 20 | | 提边二面角阈值 |
| 命令行 | `--plate --no <图号>` | 关 | 走图册版面 |
| 命令行 | `--border --title` | 关 | 恢复传统图框/标题栏 |

---

## 九、如果要继续做

按价值排序：

1. **接 B-Rep**：把 JT 的精确边界表示（或 Step）拿来，一处解决提边和消隐
2. **多视图**：现在一页一个视向，可加主视图 + 俯/侧视图标准布局
3. **尺寸标注**：热点只到"编号"，下一步是引出尺寸
4. **AI 布点调优**：把"避让走线"也加进 prompt（当前只避让热点之间）
5. **CGM 里写 WebCGM APS**：现在热点靠 `PICK IDENTIFIER`，
   如果下游要"点热点跳页面"，得再加 APS(region/linkuri)，参考 `D:\JT\cgm-toolkit\tools\cgm_tool.py`

---

## 十、给接手者的话

- **改动前先跑一遍验收**（第六节）。基线：图册 `verify-plate` 16/16 + `verify-cgm` 13/13；
  传统版面 `verify-cgm` 13/13，CoffeeMaker 28 个热点
- 图形算法改动后，`checkHotspotOverlap` 的 `overlaps` 必须仍为 0
- 图册规格（`PLATE` 常量）在 `drawing.js` 和 `tools/verify-plate.mjs` 里各有一份，
  **改一边必须改另一边**，否则校验会开始报错 —— 这是故意的，校验器不能依赖被测代码
- `_shots/sheet/` 里的截图是各功能的样子，改完可以对着看
- 模板三件套 `HTEAM-04021.cgm/.svg/.gif` 留在根目录当参考，**不要覆盖**；
  生成物写在 `out/` 下，同名也没关系
