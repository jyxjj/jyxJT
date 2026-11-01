"""直接跑 jtio 层的自检（不经 HTTP）。"""

import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import jtio


def show(node, depth=0, limit=3):
    print("  " * depth + f"[{node.kind}] {node.name}  tris={node.tris} key={node.key[:60]}")
    if depth < limit:
        for c in node.children[:6]:
            show(c, depth + 1, limit)


def probe(path):
    t0 = time.time()
    try:
        doc = jtio.REGISTRY.open(path)
    except Exception as exc:
        print(f"FAIL {os.path.basename(path)}: {exc}")
        return
    dt = time.time() - t0
    print(f"=== {os.path.basename(path)}  mode={doc.mode} units={doc.units or '-'} open={dt*1000:.0f}ms")
    show(doc.root)
    # 拿一个叶子的网格
    leaf = None
    stack = [doc.root]
    while stack:
        n = stack.pop(0)
        if not n.children:
            leaf = n
            break
        stack.extend(n.children)
    if leaf:
        t = time.time()
        b = doc.mesh_bytes(leaf.key)
        print(f"    mesh[{leaf.name[:34]}] {len(b) if b else 0} bytes in {(time.time()-t)*1000:.0f}ms")


if __name__ == "__main__":
    targets = sys.argv[1:] or [
        r"D:\JT\jt_samples\dxjt_example_block_jt10.3.jt",
        r"D:\JT\jt_samples\dxjt_CoffeeMaker.jt",
        r"D:\JT\jttest2\part2__MODEL.jt",
        r"D:\JT\sample\07_engine_4cyl_inline_assembly_step.jt",
        r"D:\JT\sample\07_engine_4cyl_inline_assembly_step\000_Cylinder_block_and_hollow_crankcase_612.jt",
    ]
    for t in targets:
        probe(t)
