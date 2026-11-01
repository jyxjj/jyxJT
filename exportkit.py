"""
exportkit.py —— 图册三件套（CGM / SVG / GIF）的服务端落盘与光栅化

为什么 GIF 要在服务端做：
  浏览器里没有 GIF 编码器，而图册要求 GIF 与 CGM/SVG **同名、同版式**。
  这里用本机 Edge 的无头模式把 SVG 精确渲染成 PNG（矢量 → 位图不会跑位），
  再用 Pillow 量化成 256 色 GIF（与 HTEAM-04021.gif 同规格：A4 300dpi、白底）。

对外函数：
  render_svg_to_png(svg_path, png_path, dpi=300)   SVG → PNG（A4 300dpi = 2480×3508）
  png_to_gif(png_path, gif_path, colors=256)      PNG → GIF（白底 256 色）
  export_plate(name, svg_text, cgm_bytes, out_dir) → 写三个文件，返回清单
"""

from __future__ import annotations

import os
import re
import subprocess
import tempfile

# A4 的物理尺寸（mm）
A4_MM_W = 210.0
A4_MM_H = 297.0

EDGE_CANDIDATES = [
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
]

# 图册号允许的字符：字母数字和 - _ .（和模板 HTEAM-04021 一致）
_NAME_RE = re.compile(r"[^A-Za-z0-9._-]+")


def safe_name(name: str, fallback: str = "drawing") -> str:
    """把图册号清洗成安全的文件名。不做中文转拼音 —— 中文图号也允许，只挡路径字符。"""
    s = (name or "").strip()
    s = s.replace("\\", "_").replace("/", "_")
    s = _NAME_RE.sub("_", s)
    s = s.strip("._-")
    return s or fallback


def find_browser() -> str | None:
    for c in EDGE_CANDIDATES:
        if os.path.exists(c):
            return c
    return None


def render_svg_to_png(svg_path: str, png_path: str, dpi: int = 300) -> tuple[int, int]:
    """
    用本机 Edge/Chrome 无头模式把 SVG 渲染成 PNG。

    尺寸按 A4 物理尺寸算（不按 viewBox），这样 GIF 和 CGM/SVG 打出来是同一个比例：
    300dpi → 2480 × 3508，和模板 HTEAM-04021.gif 的 2483×3508 基本一致。
    返回 (宽, 高)。
    """
    browser = find_browser()
    if browser is None:
        raise RuntimeError("找不到 Edge/Chrome，无法把 SVG 渲染成 GIF")

    width = round(A4_MM_W / 25.4 * dpi)
    height = round(A4_MM_H / 25.4 * dpi)

    svg_uri = "file:///" + os.path.abspath(svg_path).replace("\\", "/")
    html = f"""<!doctype html><html><head><meta charset="utf-8">
<style>html,body{{margin:0;padding:0;background:#fff;overflow:hidden}}
img{{display:block;width:{width}px;height:{height}px}}</style></head>
<body><img src="{svg_uri}"></body></html>"""
    fd, tmp_html = tempfile.mkstemp(suffix=".html")
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        fh.write(html)

    out_abs = os.path.abspath(png_path)
    if os.path.exists(out_abs):
        os.remove(out_abs)

    cmd = [
        browser, "--headless=new", "--disable-gpu", "--hide-scrollbars",
        "--force-device-scale-factor=1", "--allow-file-access-from-files",
        "--disable-extensions", "--no-first-run", "--no-default-browser-check",
        f"--window-size={width},{height}",
        f"--screenshot={out_abs}",
        "file:///" + tmp_html.replace("\\", "/"),
    ]
    try:
        subprocess.run(cmd, check=False, timeout=120,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    finally:
        try:
            os.unlink(tmp_html)
        except OSError:
            pass

    if not os.path.exists(out_abs):
        raise RuntimeError("Edge 渲染 SVG 失败（没有生成 PNG）")
    return width, height


def png_to_gif(png_path: str, gif_path: str, colors: int = 256) -> str:
    """PNG → GIF（白底、256 色、抖动开）。线条图用 256 色已经和矢量看着一样。"""
    from PIL import Image

    im = Image.open(png_path)
    if im.mode in ("RGBA", "LA") or (im.mode == "P" and "transparency" in im.info):
        im = im.convert("RGBA")
        bg = Image.new("RGB", im.size, "white")
        bg.paste(im, mask=im.split()[-1])
        im = bg
    else:
        im = im.convert("RGB")

    method = Image.MEDIANCUT if im.size[0] * im.size[1] < 4_000_000 else Image.FASTOCTREE
    q = im.quantize(colors=max(2, min(256, colors)), method=method, dither=Image.FLOYDSTEINBERG)
    q.save(gif_path, "GIF", optimize=True)
    return gif_path


def export_plate(name: str, svg_text: str, cgm_bytes: bytes, out_dir: str) -> dict:
    """
    写出 <name>.cgm / <name>.svg / <name>.gif 三个文件（与模板 HTEAM-04021 同名同规格）。

    返回 { name, dir, files: [{ext, path, size}] }
    """
    base = safe_name(name)
    out_dir = out_dir or os.path.join(os.path.dirname(os.path.abspath(__file__)), "out")
    os.makedirs(out_dir, exist_ok=True)

    svg_path = os.path.join(out_dir, base + ".svg")
    cgm_path = os.path.join(out_dir, base + ".cgm")
    gif_path = os.path.join(out_dir, base + ".gif")

    with open(svg_path, "w", encoding="utf-8") as fh:
        fh.write(svg_text)
    with open(cgm_path, "wb") as fh:
        fh.write(cgm_bytes)

    png_path = os.path.join(out_dir, base + ".png")
    try:
        render_svg_to_png(svg_path, png_path, dpi=300)
        png_to_gif(png_path, gif_path)
    finally:
        # PNG 只是中间产物；要留着方便看就把 jtbrowser.keep_png 建出来
        keep = os.path.join(os.path.dirname(os.path.abspath(__file__)), "jtbrowser.keep_png")
        if not os.path.exists(keep) and os.path.exists(png_path):
            try:
                os.remove(png_path)
            except OSError:
                pass

    files = []
    for p in (cgm_path, svg_path, gif_path):
        files.append({"ext": os.path.splitext(p)[1].lstrip("."), "path": p,
                      "size": os.path.getsize(p) if os.path.exists(p) else 0})
    return {"name": base, "dir": os.path.abspath(out_dir), "files": files}
