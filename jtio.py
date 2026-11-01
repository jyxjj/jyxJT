"""
jtio.py —— JT 读取层（Python 侧）

职责：
  1. 打开 .jt（含 JT 10.10 的版本头兼容补丁），产出装配层级树 + 三角网格
  2. 对"装配体 .jt + 同名零件文件夹"这种 NX 导出结构做兜底：
     装配 .jt 读不了时，按文件夹里的零件文件建树（子文件已含世界坐标）
  3. 网格按需加载并缓存，供 Web 前端按节点拉取

底层读器：D:\\JT\\pydxjt（jt_toolkit + C ABI shim，ctypes 调用）
"""

from __future__ import annotations

import hashlib
import os
import shutil
import struct
import threading
import time
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

import numpy as np

# ---- 让 dxjt 可导入 ----
_PYDXJT = r"D:\JT\pydxjt"
if _PYDXJT not in os.environ.get("PYTHONPATH", ""):
    os.environ["PYTHONPATH"] = _PYDXJT + os.pathsep + os.environ.get("PYTHONPATH", "")

import sys

if _PYDXJT not in sys.path:
    sys.path.insert(0, _PYDXJT)

try:
    import dxjt  # noqa: E402
except Exception as exc:  # pragma: no cover
    dxjt = None
    _DXJT_ERR = exc
else:
    _DXJT_ERR = None


CACHE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "_cache")
os.makedirs(CACHE_DIR, exist_ok=True)

# ----------------------------------------------------------------------------
# JT 版本头兼容
# ----------------------------------------------------------------------------
# NX 2512 默认导出 "Version 10.10"。本机 jt_toolkit 构建只认到 10.3/10.5 头，
# 而 10.10 相对 10.5 在本项目的样本里只是 TOC 段类型号有增量，几何段结构一致，
# 所以把 80 字节版本头改写后再读是安全的（只动头的 14 个字符，不动任何数据段）。
_VERSION_FIXES = {
    "Version 10.10": "Version 10.5  ",
    "Version 10.11": "Version 10.5  ",
}


def _cache_key(path: str) -> str:
    st = os.stat(path)
    raw = f"{os.path.abspath(path)}|{st.st_size}|{int(st.st_mtime)}"
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:16]


def prepare(path: str) -> str:
    """返回一个底层读器能接受的路径（必要时写出版本头补丁副本）。"""
    with open(path, "rb") as fh:
        head = fh.read(80)
    text = head.decode("latin-1", "ignore")
    patch = None
    for bad, good in _VERSION_FIXES.items():
        if text.startswith(bad):
            patch = good
            break
    if patch is None:
        return path

    key = _cache_key(path)
    ext = os.path.splitext(path)[1] or ".jt"
    out = os.path.join(CACHE_DIR, key + ext)
    if os.path.exists(out) and os.path.getsize(out) == os.path.getsize(path):
        return out

    with open(path, "rb") as fh:
        data = bytearray(fh.read())
    new_head = (patch + text[len(patch):])[:80]
    data[:80] = new_head.encode("latin-1")
    tmp = out + ".tmp"
    with open(tmp, "wb") as fh:
        fh.write(data)
    os.replace(tmp, out)
    return out


# ----------------------------------------------------------------------------
# 网格
# ----------------------------------------------------------------------------
@dataclass
class MeshData:
    positions: np.ndarray  # (N,3) float32
    normals: np.ndarray    # (N,3) float32
    indices: np.ndarray    # (M,3) uint32
    bbox_min: Tuple[float, float, float]
    bbox_max: Tuple[float, float, float]
    material: Dict[str, object] = field(default_factory=dict)

    def to_binary(self) -> bytes:
        """JTM2: magic|nv|nt|bbox(6f)|mat(8f: rgb, spec rgb, shininess, opacity)|pos|nrm|idx"""
        nv = int(self.positions.shape[0])
        nt = int(self.indices.shape[0])
        head = struct.pack("<4sII", b"JTM2", nv, nt)
        bbox = struct.pack("<6f", *self.bbox_min, *self.bbox_max)
        m = self.material or {}
        col = m.get("color") or [0.62, 0.66, 0.71]
        spec = m.get("specular") or [0.15, 0.15, 0.15]
        mat = struct.pack(
            "<8f",
            float(col[0]), float(col[1]), float(col[2]),
            float(spec[0]), float(spec[1]), float(spec[2]),
            float(m.get("shininess", 30.0) or 30.0),
            float(m.get("opacity", 1.0) or 1.0),
        )
        return b"".join(
            [
                head,
                bbox,
                mat,
                self.positions.astype("<f4").tobytes(),
                self.normals.astype("<f4").tobytes(),
                self.indices.astype("<u4").tobytes(),
            ]
        )


def _srgb_to_linear(c: float) -> float:
    """sRGB → 线性。目前材质走"原值直用"策略（见 material_of），保留备用。"""
    if c <= 0.04045:
        return c / 12.92
    return ((c + 0.055) / 1.055) ** 2.4


def material_of(mesh) -> Dict[str, object]:
    """从 dxjt mesh 抽出材质。

    注意：这里**不做 sRGB→线性转换**。JT 里的颜色值是给可视化器按"看起来对"
    的语义写的，直接当线性值喂给 three.js 才与 NX / JT2Go 的观感一致
    （转换后 0.28 会被压成 0.064，整个模型发黑）。
    """
    fallback = {"color": [0.62, 0.66, 0.71], "shininess": 30.0, "opacity": 1.0}
    try:
        mat = mesh.material
    except Exception:
        return fallback
    if mat is None:
        return fallback

    def tone(attr):
        try:
            v = getattr(mat, attr)
        except Exception:
            return None
        if not v or len(v) < 3:
            return None
        return [max(0.0, min(1.0, float(x))) for x in v[:3]]

    diffuse = tone("diffuse") or fallback["color"]
    spec = tone("specular") or [0.15, 0.15, 0.15]
    try:
        shininess = float(getattr(mat, "shininess", 30.0) or 30.0)
    except Exception:
        shininess = 30.0

    alpha = 1.0
    try:
        raw = getattr(mat, "diffuse")
        if raw is not None and len(raw) >= 4:
            a = float(raw[3])
            # 0.3 / 1.0 是两种常见占位值；只有 0<alpha<0.999 且不是 0.3 才算真透明
            if 0.0 < a < 0.999 and abs(a - 0.3) > 1e-3:
                alpha = a
    except Exception:
        pass

    return {
        "color": diffuse,
        "specular": spec,
        "shininess": shininess,
        "opacity": alpha,
    }


def _flat_normals(pos: np.ndarray, idx: np.ndarray) -> np.ndarray:
    """无顶点法线时，用面法线近似（按顶点累加后归一化）。"""
    nrm = np.zeros_like(pos, dtype=np.float64)
    tri = pos[idx]
    fn = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
    for k in range(3):
        np.add.at(nrm, idx[:, k], fn)
    ln = np.linalg.norm(nrm, axis=1, keepdims=True)
    ln[ln == 0] = 1.0
    return (nrm / ln).astype(np.float32)


def mesh_from_dxjt(mesh) -> MeshData:
    v, f = mesh.as_arrays()
    pos = np.ascontiguousarray(v, dtype=np.float32)
    idx = np.ascontiguousarray(f, dtype=np.uint32)
    try:
        n = np.ascontiguousarray(np.asarray(mesh.normals, dtype=np.float32))
        if n.shape != pos.shape:
            n = _flat_normals(pos.astype(np.float64), idx)
    except Exception:
        n = _flat_normals(pos.astype(np.float64), idx)
    lo = pos.min(axis=0) if len(pos) else np.zeros(3, dtype=np.float32)
    hi = pos.max(axis=0) if len(pos) else np.zeros(3, dtype=np.float32)
    return MeshData(pos, n, idx, tuple(float(x) for x in lo), tuple(float(x) for x in hi), material_of(mesh))


# ----------------------------------------------------------------------------
# 节点树
# ----------------------------------------------------------------------------
@dataclass
class JNode:
    name: str
    kind: str  # assembly | part | file
    key: str   # 网格取回用的键
    children: List["JNode"] = field(default_factory=list)
    props: Dict[str, object] = field(default_factory=dict)
    material: Optional[Dict[str, object]] = None
    tris: int = 0
    bbox: Optional[List[List[float]]] = None
    note: str = ""

    def to_dict(self) -> Dict[str, object]:
        return {
            "name": self.name,
            "kind": self.kind,
            "key": self.key,
            "tris": self.tris,
            "bbox": self.bbox,
            "props": self.props,
            "material": self.material,
            "note": self.note,
            "children": [c.to_dict() for c in self.children],
        }


def _clean_props(props) -> Dict[str, object]:
    out: Dict[str, object] = {}
    try:
        items = props.items()
    except Exception:
        return out
    for k, v in items:
        try:
            if isinstance(v, (int, float, bool, str)):
                out[str(k)] = v
            else:
                out[str(k)] = str(v)
        except Exception:
            continue
    return out


def _mat_dict(m) -> Optional[Dict[str, object]]:
    if m is None:
        return None
    out: Dict[str, object] = {}
    for attr in ("diffuse", "specular", "ambient", "emission", "shininess"):
        try:
            val = getattr(m, attr)
            out[attr] = list(val) if isinstance(val, (tuple, list)) else float(val)
        except Exception:
            continue
    return out or None


class Document:
    """一个已打开的 JT（或"装配 .jt + 零件文件夹"数据集）。"""

    def __init__(self, path: str, name: str = "") -> None:
        self.path = os.path.abspath(path)
        self.name = name or os.path.basename(self.path)
        self.id = hashlib.sha1(self.path.encode("utf-8")).hexdigest()[:12]
        self.mode = "native"
        self._doc = None
        self._mesh_cache: Dict[str, MeshData] = {}
        self._lock = threading.Lock()
        self._node_mesh: Dict[str, object] = {}
        self.root: Optional[JNode] = None
        self.units = ""
        self.error = ""
        self.parts_dir: Optional[str] = None
        self._build()

    # -- 构建 ---------------------------------------------------------------
    def _build(self) -> None:
        target = self.path
        if os.path.isdir(target):
            self.mode = "folder"
            self.parts_dir = target
            self.root = self._tree_from_folder(target, os.path.basename(target.rstrip("\\/")))
            return

        try:
            self._doc = dxjt.open(prepare(target))
        except Exception as exc:
            # 装配 .jt 打不开 → 试同名零件文件夹
            alt = os.path.splitext(target)[0]
            if os.path.isdir(alt):
                self.mode = "folder+asm"
                self.error = str(exc)[:200]
                self.parts_dir = alt
                self.root = self._tree_from_folder(alt, os.path.splitext(os.path.basename(target))[0])
                return
            raise RuntimeError(f"无法读取 {self.name}: {exc}") from exc

        self.mode = "native"
        try:
            st = self._doc.stats
            self.units = st.unit_name or ""
        except Exception:
            pass
        self.root = self._tree_from_native()
        for m in self._doc.meshes:
            self._node_mesh[m.node_path] = m

    def _tree_from_native(self) -> JNode:
        def conv(node) -> JNode:
            kind = node.kind
            sub = [conv(c) for c in node.children]
            tris = 0
            bbox = None
            for m in node.meshes:
                try:
                    tris += int(m.triangle_count)
                except Exception:
                    pass
            if node.meshes:
                try:
                    b0, b1 = node.meshes[0].bbox
                    bbox = [[float(x) for x in b0], [float(x) for x in b1]]
                except Exception:
                    bbox = None
            for c in sub:
                tris += c.tris
                if bbox is None and c.bbox:
                    bbox = c.bbox
            return JNode(
                name=node.name or "(unnamed)",
                kind=kind,
                key=node.path,
                children=sub,
                props=_clean_props(node.properties) if hasattr(node, "properties") else {},
                material=_mat_dict(node.material) if hasattr(node, "material") else None,
                tris=tris,
                bbox=bbox,
            )

        return conv(self._doc.root)

    def _tree_from_folder(self, folder: str, title: str) -> JNode:
        files = sorted(
            [f for f in os.listdir(folder) if f.lower().endswith(".jt")],
            key=lambda s: s.lower(),
        )
        kids: List[JNode] = []
        for f in files:
            full = os.path.join(folder, f)
            stem = os.path.splitext(f)[0]
            # 去掉 NX 导出的 "000_" 序号前缀
            label = stem
            if len(stem) > 4 and stem[:3].isdigit() and stem[3] == "_":
                label = stem[4:]
            # 有同名零件文件夹 → 视作装配，展开成子节点（子文件已含世界坐标）
            sibling = os.path.join(folder, stem)
            if os.path.isdir(sibling) and any(
                n.lower().endswith(".jt") for n in os.listdir(sibling)
            ):
                sub = self._tree_from_folder(sibling, label)
                sub.kind = "assembly"
                sub.key = sibling
                sub.note = os.path.basename(sibling) + "\\"
                kids.append(sub)
            else:
                kids.append(
                    JNode(
                        name=label,
                        kind="part",
                        key=full,
                        note=os.path.relpath(full, folder),
                        tris=0,
                    )
                )
        return JNode(name=title, kind="assembly", key=folder, children=kids)

    # -- 网格 ---------------------------------------------------------------
    def mesh_bytes(self, key: str) -> Optional[bytes]:
        with self._lock:
            hit = self._mesh_cache.get(key)
            if hit is not None:
                return hit.to_binary() if isinstance(hit, MeshData) else None
        data = self._load_mesh(key)
        with self._lock:
            self._mesh_cache[key] = data if data is not None else False  # type: ignore[assignment]
        return data.to_binary() if data is not None else None

    def _load_mesh(self, key: str) -> Optional[MeshData]:
        if self.mode == "native":
            m = self._node_mesh.get(key)
            if m is None:
                return None
            try:
                return mesh_from_dxjt(m)
            except Exception:
                return None
        # folder 模式：key 是零件文件路径
        if not os.path.isfile(key):
            return None
        try:
            d = dxjt.open(prepare(key))
        except Exception:
            return None
        try:
            meshes = d.meshes
            if not meshes:
                return None
            if len(meshes) == 1:
                return mesh_from_dxjt(meshes[0])
            parts = [mesh_from_dxjt(m) for m in meshes]
            pos = np.concatenate([p.positions for p in parts])
            nrm = np.concatenate([p.normals for p in parts])
            pieces = []
            off = 0
            for p in parts:
                pieces.append(p.indices + off)
                off += p.positions.shape[0]
            idx = np.concatenate(pieces)
            return MeshData(
                np.ascontiguousarray(pos, dtype=np.float32),
                np.ascontiguousarray(nrm, dtype=np.float32),
                np.ascontiguousarray(idx, dtype=np.uint32),
                tuple(float(x) for x in pos.min(axis=0)),
                tuple(float(x) for x in pos.max(axis=0)),
                parts[0].material,
            )
        finally:
            try:
                d.close()
            except Exception:
                pass

    def node_info(self, key: str) -> Dict[str, object]:
        """点开节点时补一次真实三角形数与包围盒（文件夹模式建树时是懒的）。"""
        with self._lock:
            hit = self._mesh_cache.get(key)
        if isinstance(hit, MeshData):
            return {
                "tris": int(hit.indices.shape[0]),
                "verts": int(hit.positions.shape[0]),
                "bbox": [list(hit.bbox_min), list(hit.bbox_max)],
            }
        data = self._load_mesh(key)
        if data is None:
            return {"tris": 0, "verts": 0, "bbox": None}
        with self._lock:
            self._mesh_cache[key] = data
        return {
            "tris": int(data.indices.shape[0]),
            "verts": int(data.positions.shape[0]),
            "bbox": [list(data.bbox_min), list(data.bbox_max)],
        }

    def close(self) -> None:
        if self._doc is not None:
            try:
                self._doc.close()
            except Exception:
                pass
            self._doc = None


# ----------------------------------------------------------------------------
# 文档注册表
# ----------------------------------------------------------------------------
class Registry:
    def __init__(self) -> None:
        self._docs: Dict[str, Document] = {}
        self._lock = threading.Lock()

    def open(self, path: str) -> Document:
        with self._lock:
            existing = self._docs.get(os.path.abspath(path))
            if existing is not None:
                return existing
            doc = Document(path)
            self._docs[doc.path] = doc
            return doc

    def get(self, doc_id: str) -> Optional[Document]:
        with self._lock:
            for d in self._docs.values():
                if d.id == doc_id:
                    return d
        return None

    def close(self, doc_id: str) -> bool:
        with self._lock:
            for k, d in list(self._docs.items()):
                if d.id == doc_id:
                    d.close()
                    del self._docs[k]
                    return True
        return False

    def list_open(self) -> List[Dict[str, object]]:
        with self._lock:
            return [
                {"id": d.id, "name": d.name, "path": d.path, "mode": d.mode}
                for d in self._docs.values()
            ]


REGISTRY = Registry()


# ----------------------------------------------------------------------------
# 样本浏览
# ----------------------------------------------------------------------------
def list_samples(root: str) -> List[Dict[str, object]]:
    out: List[Dict[str, object]] = []
    if not os.path.isdir(root):
        return out
    for entry in sorted(os.scandir(root), key=lambda e: e.name.lower()):
        if entry.is_file() and entry.name.lower().endswith(".jt"):
            out.append(
                {
                    "name": entry.name,
                    "path": entry.path,
                    "kind": "file",
                    "size": entry.stat().st_size,
                    "has_parts": os.path.isdir(os.path.splitext(entry.path)[0]),
                }
            )
        elif entry.is_dir():
            jt = 0
            for _root, _dirs, files in os.walk(entry.path):
                jt += sum(1 for f in files if f.lower().endswith(".jt"))
            if jt:
                out.append(
                    {"name": entry.name, "path": entry.path, "kind": "folder", "parts": jt}
                )
    return out
