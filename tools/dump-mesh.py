"""dump-mesh.py —— 把 JT 的装配树 + 三角网格导成 JSON，供 Node 侧绘图/CGM 校验用。

用法:
    python tools\\dump-mesh.py <jt路径> <out.json>
"""

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import jtio


def node_to_dict(n):
    return {
        "name": n.name,
        "kind": n.kind,
        "key": n.key,
        "tris": n.tris,
        "children": [node_to_dict(c) for c in n.children],
    }


def main():
    src = sys.argv[1]
    out = sys.argv[2]
    doc = jtio.REGISTRY.open(src)

    parts = []

    def walk(n):
        if not n.children:
            b = doc.mesh_bytes(n.key)
            if b is None:
                return
            import struct
            nv, nt = struct.unpack_from("<II", b, 4)
            import numpy as np
            off = 12 + 24 + 32
            pos = np.frombuffer(b, dtype="<f4", count=nv * 3, offset=off)
            idx = np.frombuffer(b, dtype="<u4", count=nt * 3, offset=off + nv * 24)
            parts.append({
                "key": n.key,
                "name": n.name,
                "positions": pos.tolist(),
                "indices": idx.tolist(),
            })
            return
        for c in n.children:
            walk(c)

    walk(doc.root)

    payload = {
        "name": doc.name,
        "mode": doc.mode,
        "units": doc.units,
        "tree": node_to_dict(doc.root),
        "parts": parts,
    }
    with open(out, "w", encoding="utf-8") as f:
        json.dump(payload, f)
    print(f"写入 {out}: {len(parts)} 个零件")


if __name__ == "__main__":
    main()
