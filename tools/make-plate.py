#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
make-plate.py —— 命令行出「图册三件套」：<图号>.cgm + <图号>.svg + <图号>.gif

和界面上的「生成图册三件套」是**同一条链路**：
  1) node tools/make-sheet.mjs 出 CGM + SVG（图册版面，--plate）
  2) exportkit.render_svg_to_png 用本机 Edge 把 SVG 渲染成 A4 300dpi PNG
  3) exportkit.png_to_gif 量化成 256 色 GIF

用法:
    python tools\\make-plate.py <mesh.json> <图号> [--sheet 分组表.xlsx] [--out out]
    python tools\\make-plate.py _test\\engine.json HTEAM-04021 ^
           --sheet "_test\\engine_分组表.xlsx" --out out

出完自动跑两项校验（都通过才返回 0）：
    node tools\\verify-plate.mjs   16 项图册规格
    node tools\\verify-cgm.mjs     13 项 CGM 结构
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, HERE)

import exportkit  # noqa: E402


def run(cmd: list[str]) -> int:
    print('>', ' '.join(cmd))
    return subprocess.call(cmd, cwd=HERE)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('mesh_json', help='tools/dump-mesh.py 产出的网格 JSON')
    ap.add_argument('drawing_no', help='图号，例如 HTEAM-04021（决定三个文件名）')
    ap.add_argument('--sheet', default='', help='分组表 .xlsx / .csv')
    ap.add_argument('--out', default='out', help='输出目录（默认 webjt/out）')
    ap.add_argument('--view', default='iso', help='iso|front|top|right（默认 iso）')
    ap.add_argument('--skip-verify', action='store_true')
    a = ap.parse_args()

    name = exportkit.safe_name(a.drawing_no)
    out_dir = os.path.abspath(a.out)
    os.makedirs(out_dir, exist_ok=True)

    # 临时文件名直接用图号：BEGIN METAFILE 名取自文件名，会写进 CGM
    tmp_cgm = os.path.join(out_dir, f'{name}.cgm')
    tmp_svg = os.path.join(out_dir, f'{name}.svg')

    # 1) 出 CGM + SVG（图册版面）
    cmd = ['node', os.path.join('tools', 'make-sheet.mjs'), a.mesh_json, tmp_cgm,
           '--plate', '--no', a.drawing_no, '--view', a.view]
    if a.sheet:
        cmd += ['--sheet', a.sheet]
    if run(cmd) != 0:
        print('出图失败', file=sys.stderr)
        return 2
    if not os.path.exists(tmp_svg):
        print('没生成 SVG', file=sys.stderr)
        return 3

    # 2) 落盘成三件套（同名、同版式；GIF 由 Edge 渲染 + Pillow 量化）
    svg_text = open(tmp_svg, encoding='utf-8').read()
    cgm_bytes = open(tmp_cgm, 'rb').read()
    result = exportkit.export_plate(name, svg_text, cgm_bytes, out_dir)

    for f in result['files']:
        print(f"  {f['ext'].upper():4} {f['path']}  {f['size'] / 1024:.0f} KB")

    # 临时名与最终名相同时不能删（export_plate 直接落在同一文件）
    for p in (tmp_cgm, tmp_svg):
        if os.path.abspath(p) not in {os.path.abspath(f['path']) for f in result['files']}:
            try:
                os.remove(p)
            except OSError:
                pass

    if a.skip_verify:
        return 0

    # 3) 校验
    cgm_path = os.path.join(out_dir, name + '.cgm')
    ok1 = run(['node', os.path.join('tools', 'verify-plate.mjs'), cgm_path, '--no', a.drawing_no]) == 0
    ok2 = run(['node', os.path.join('tools', 'verify-cgm.mjs'), cgm_path]) == 0
    return 0 if (ok1 and ok2) else 1


if __name__ == '__main__':
    raise SystemExit(main())
