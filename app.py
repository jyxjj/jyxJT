"""
app.py —— JT 浏览器后端（FastAPI）

接口：
  GET  /                      前端页面
  GET  /api/samples           列出样本目录下的 .jt / 装配文件夹
  POST /api/open              打开一个 JT（或装配文件夹），返回 doc_id + 层级树
  POST /api/upload            上传 .jt 后打开
  GET  /api/tree/{doc_id}     重新取层级树
  GET  /api/node/{doc_id}     单个节点的真实三角形数 / 包围盒
  GET  /api/mesh/{doc_id}     单个节点的三角网格（二进制 JTM1）
  GET  /api/docs              当前已打开文档
  DELETE /api/doc/{doc_id}    关闭

启动：python app.py  → http://127.0.0.1:8770
"""

from __future__ import annotations

import json
import os
import shutil
import tempfile
import time
import traceback
import urllib.error
import urllib.request
from typing import Optional

from fastapi import FastAPI, HTTPException, Query, UploadFile, File, Form
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import jtio

HERE = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(HERE, "static")
UPLOADS = os.path.join(HERE, "_uploads")
os.makedirs(UPLOADS, exist_ok=True)

DEFAULT_SAMPLES = r"D:\JT\sample"

app = FastAPI(title="JT Browser", version="1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class OpenReq(BaseModel):
    path: str
    name: Optional[str] = None


@app.get("/")
def index() -> FileResponse:
    # 首页也不许缓存：否则改了 js 之后，HTML 还指向老的模块
    return FileResponse(
        os.path.join(STATIC, "index.html"),
        headers={"Cache-Control": "no-store, must-revalidate", "Pragma": "no-cache"},
    )


@app.get("/api/samples")
def samples(root: str = Query(default=DEFAULT_SAMPLES)) -> JSONResponse:
    try:
        items = jtio.list_samples(root)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"读取目录失败: {exc}")
    return JSONResponse({"root": root, "items": items})


@app.post("/api/open")
def open_doc(req: OpenReq) -> JSONResponse:
    p = req.path
    if not os.path.exists(p):
        raise HTTPException(status_code=404, detail=f"路径不存在: {p}")
    try:
        doc = jtio.REGISTRY.open(p)
    except Exception as exc:
        traceback.print_exc()
        raise HTTPException(status_code=422, detail=str(exc))
    payload = {
        "id": doc.id,
        "name": doc.name,
        "path": doc.path,
        "mode": doc.mode,
        "units": doc.units,
        "note": doc.error,
        "tree": doc.root.to_dict() if doc.root else None,
    }
    return JSONResponse(payload)


@app.post("/api/upload")
async def upload(file: UploadFile = File(...)) -> JSONResponse:
    safe = os.path.basename(file.filename or "upload.jt")
    dest = os.path.join(UPLOADS, safe)
    with open(dest, "wb") as fh:
        shutil.copyfileobj(file.file, fh)
    try:
        doc = jtio.REGISTRY.open(dest)
    except Exception as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    return JSONResponse(
        {
            "id": doc.id,
            "name": doc.name,
            "path": doc.path,
            "mode": doc.mode,
            "units": doc.units,
            "note": doc.error,
            "tree": doc.root.to_dict() if doc.root else None,
        }
    )


@app.get("/api/tree/{doc_id}")
def tree(doc_id: str) -> JSONResponse:
    doc = jtio.REGISTRY.get(doc_id)
    if doc is None:
        raise HTTPException(status_code=404, detail="文档未打开")
    return JSONResponse({"id": doc.id, "tree": doc.root.to_dict() if doc.root else None})


@app.get("/api/node/{doc_id}")
def node(doc_id: str, key: str = Query(...)) -> JSONResponse:
    doc = jtio.REGISTRY.get(doc_id)
    if doc is None:
        raise HTTPException(status_code=404, detail="文档未打开")
    info = doc.node_info(key)
    return JSONResponse(info)


@app.get("/api/mesh/{doc_id}")
def mesh(doc_id: str, key: str = Query(...)) -> Response:
    doc = jtio.REGISTRY.get(doc_id)
    if doc is None:
        raise HTTPException(status_code=404, detail="文档未打开")
    data = doc.mesh_bytes(key)
    if data is None:
        raise HTTPException(status_code=404, detail="该节点没有三角网格")
    return Response(content=data, media_type="application/octet-stream")


@app.get("/api/docs")
def docs() -> JSONResponse:
    return JSONResponse({"items": jtio.REGISTRY.list_open()})


class AiRequest(BaseModel):
    """AI 布点用的转发请求：URL / Key / 模型都由前端填，这里只做代理。"""
    url: str
    key: str = ""
    body: dict


class PlateExportReq(BaseModel):
    """
    图册三件套导出请求。

    版式已经在浏览器里算好（buildSheet + sheetToSVG + sheetToCgm），
    这里只负责落盘、渲染 GIF —— 不在服务端重算几何，避免两条出图路径不一致。
    """
    name: str                      # 图册号，例如 HTEAM-04021
    svg: str                       # 单页 SVG 文本
    cgm: str                       # CGM 字节（base64）
    out_dir: Optional[str] = None  # 不给就写到 webjt/out/


@app.post("/api/export/plate")
def export_plate(req: PlateExportReq) -> JSONResponse:
    import base64

    import exportkit

    if not req.svg.lstrip().startswith("<svg"):
        raise HTTPException(status_code=400, detail="svg 内容不是 SVG 文档")
    try:
        cgm_bytes = base64.b64decode(req.cgm or "")
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"CGM base64 解码失败: {exc}")
    if not cgm_bytes:
        raise HTTPException(status_code=400, detail="CGM 内容为空")

    out_dir = req.out_dir or os.path.join(HERE, "out")
    try:
        result = exportkit.export_plate(req.name, req.svg, cgm_bytes, out_dir)
    except Exception as exc:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"导出失败: {exc}")
    _cleanup_out()
    return JSONResponse(result)


@app.get("/api/export/file")
def export_file(path: str = Query(...)) -> FileResponse:
    """把导出目录里的文件回吐给浏览器下载（限 out 目录内，防路径穿越）。"""
    root = os.path.realpath(os.path.join(HERE, "out"))
    target = os.path.realpath(path)
    if not target.startswith(root + os.sep) or not os.path.isfile(target):
        raise HTTPException(status_code=404, detail="文件不存在")
    return FileResponse(target, filename=os.path.basename(target))


def _cleanup_out(max_keep: int = 400) -> None:
    """out/ 只留最近 max_keep 个文件，防止反复导出让目录膨胀。"""
    root = os.path.join(HERE, "out")
    if not os.path.isdir(root):
        return
    files = []
    for name in os.listdir(root):
        p = os.path.join(root, name)
        if os.path.isfile(p):
            files.append((os.path.getmtime(p), p))
    files.sort(reverse=True)
    for _, p in files[max_keep:]:
        try:
            os.remove(p)
        except OSError:
            pass


@app.delete("/api/doc/{doc_id}")
def close_doc(doc_id: str) -> JSONResponse:
    return JSONResponse({"closed": jtio.REGISTRY.close(doc_id)})


@app.post("/api/ai/chat")
def ai_chat(req: AiRequest) -> JSONResponse:
    """
    AI 布点转发：浏览器直连上游 API 会被 CORS 拦，
    前端把 {url, key, body} 发到本机后端，这里用 urllib 原样转发。
    Key 只在本次请求内存里用一下，不落盘、不进日志。
    """
    import urllib.error

    if not req.url.startswith(("http://", "https://")):
        raise HTTPException(status_code=400, detail="接口地址必须是 http(s) URL")
    payload = json.dumps(req.body).encode("utf-8")
    r = urllib.request.Request(
        req.url,
        data=payload,
        headers={
            "Content-Type": "application/json",
            **({"Authorization": f"Bearer {req.key}"} if req.key else {}),
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(r, timeout=120) as resp:
            data = resp.read()
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:500]
        raise HTTPException(status_code=502, detail=f"上游 HTTP {exc.code}: {detail}")
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"转发失败: {exc}")
    try:
        return JSONResponse(json.loads(data))
    except Exception:
        raise HTTPException(status_code=502, detail="上游返回不是 JSON")



class NoCacheStatic(StaticFiles):
    """
    静态文件不让浏览器缓存。

    默认的 StaticFiles 只发 ETag / Last-Modified，不发 Cache-Control，
    Edge/Chrome 在同一个标签页里会直接用内存缓存 —— 改了 js 刷新还是老样子，
    排查时会误以为"改动没生效"。这里强制每次回源校验。
    """

    async def get_response(self, path, scope):
        resp = await super().get_response(path, scope)
        resp.headers["Cache-Control"] = "no-store, must-revalidate"
        resp.headers["Pragma"] = "no-cache"
        return resp


app.mount("/static", NoCacheStatic(directory=STATIC), name="static")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8770, log_level="info")
