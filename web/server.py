# -*- coding: utf-8 -*-
"""本地 Web 控制台（FastAPI + 原生前端，无需 npm 构建）。

启动：
    python web/server.py
    # 或
    python scripts/web_server.py

默认地址：http://127.0.0.1:8765

功能：
- 交易日检测（复用 summary_today 的东方财富财经早餐逻辑）
- 新建任务：默认抓取当日复盘 docx / 粘贴 / 上传 / 自定义URL
- 任务列表、实时日志、进度、视频与封面预览
- 一键上传B站、B站 Cookie 与 Agnes Key 设置
"""
import base64
import json
import os
import queue
import re
import shutil
import subprocess
import sys
import threading
import time
import traceback
import uuid
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRIPTS = os.path.join(ROOT, "scripts")
sys.path.insert(0, SCRIPTS)

from common import (CONFIG_DIR, DEFAULT_ARTICLE_BASE_URL, DEFAULT_ARTICLE_PATTERN,
                    INPUT_DIR, OUT, SRC, cn_date_from_8, date8, date8_from,
                    llm_settings, load_config, save_config)

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
import uvicorn

WEB_DIR = os.path.join(ROOT, "web")
STATIC_DIR = os.path.join(WEB_DIR, "static")
DATA_DIR = os.path.join(WEB_DIR, "data")
ARTICLE_DIR = os.path.join(DATA_DIR, "articles")
LOG_DIR = os.path.join(DATA_DIR, "logs")
RUNS_DIR = os.path.join(OUT, "runs")
TASKS_FILE = os.path.join(DATA_DIR, "tasks.json")
for d in (DATA_DIR, ARTICLE_DIR, LOG_DIR, RUNS_DIR):
    os.makedirs(d, exist_ok=True)

_lock = threading.RLock()
_task_queue = queue.Queue()
_worker_started = False
_procs = {}
_trading_cache = {}

BILI_COOKIES = os.path.join(CONFIG_DIR, "bilibili_cookies.json")
BILI_LOGIN_STATUS = os.path.join(DATA_DIR, "bilibili_login.json")
BILI_LOGIN_LOG = os.path.join(LOG_DIR, "bilibili_login.log")
_bili_login_proc = None

STEP_RE = re.compile(r"^\[STEP\]\s*(\d+)/(\d+)\s+(.+)$")
STATUS_LABELS = {
    "queued": "排队中",
    "running": "运行中",
    "success": "已完成",
    "failed": "失败",
    "skipped": "非交易日跳过",
    "cancelled": "已取消",
}


# ── 任务存储 ────────────────────────────────────────────────────────────

def _now():
    return time.strftime("%Y-%m-%d %H:%M:%S")


def load_tasks():
    with _lock:
        if not os.path.exists(TASKS_FILE):
            return []
        try:
            with open(TASKS_FILE, encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return []


def save_tasks(tasks):
    with _lock:
        tmp = TASKS_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(tasks, f, ensure_ascii=False, indent=2)
        os.replace(tmp, TASKS_FILE)


def get_task(task_id):
    for t in load_tasks():
        if t["id"] == task_id:
            return t
    return None


def update_task(task_id, **fields):
    with _lock:
        tasks = load_tasks()
        for t in tasks:
            if t["id"] == task_id:
                t.update(fields)
                save_tasks(tasks)
                return t
    return None


def append_log(task_id, text):
    path = os.path.join(LOG_DIR, f"{task_id}.log")
    with open(path, "a", encoding="utf-8") as f:
        f.write(text)


def public_task(t):
    """给前端的任务对象（附带可访问的媒体 URL）。"""
    out = dict(t)
    if t.get("status") in ("success", "running") or t.get("video"):
        if t.get("video") and os.path.exists(t["video"]):
            out["video_url"] = f"/api/tasks/{t['id']}/video"
    if t.get("cover") and os.path.exists(t["cover"]):
        out["cover_url"] = f"/api/tasks/{t['id']}/cover"
    out["status_label"] = STATUS_LABELS.get(t.get("status"), t.get("status", ""))
    return out


# ── 交易日 ──────────────────────────────────────────────────────────────

def trading_status(date8_str=None, force=False):
    date8_str = date8_str or date8()
    if not force and date8_str in _trading_cache:
        cached = _trading_cache[date8_str]
        if time.time() - cached[2] < 600:
            return cached[0], cached[1]
    try:
        from trading_day import check_trading_day
        status, reason = check_trading_day(date8_str)
    except Exception as e:  # noqa: BLE001
        status, reason = None, f"交易日检测异常：{e}"
    _trading_cache[date8_str] = (status, reason, time.time())
    return status, reason


# ── 工具 ────────────────────────────────────────────────────────────────

def _safe_name(name):
    name = os.path.basename(name or "article")
    return re.sub(r"[^0-9A-Za-z_.\-\u4e00-\u9fff]", "_", name)[:80]


def _is_allowed_article_path(path):
    """只允许读取 web/data/articles 或 input/ 下的文件。"""
    try:
        p = os.path.abspath(path)
        for root in (ARTICLE_DIR, INPUT_DIR):
            if os.path.commonpath([p, os.path.abspath(root)]) == os.path.abspath(root):
                return True
    except (ValueError, OSError):
        return False
    return False


def _article_source_arg(task):
    """把任务的文章来源转换成 run_all.py --article 参数。"""
    mode = task.get("article_mode", "auto")
    if mode == "auto":
        return "auto"
    if mode == "url":
        return task.get("article_url") or "auto"
    path = task.get("article_path")
    if not path or not os.path.exists(path):
        raise RuntimeError("任务未找到原文文件，请重新创建任务")
    if not _is_allowed_article_path(path):
        raise RuntimeError("原文路径不在允许的目录内")
    return path


def _collect_artifacts(task):
    """把 out/ 产物复制到任务独立目录，避免下一次运行覆盖。"""
    run_dir = os.path.join(RUNS_DIR, task["id"])
    os.makedirs(run_dir, exist_ok=True)
    mapping = {
        "video": ("video_final.mp4", "video_final.mp4"),
        "cover": ("cover.png", "cover.png"),
        "desc": ("B站简介.md", "B站简介.md"),
        "tags": ("tags.txt", "tags.txt"),
    }
    result = {}
    for key, (src_name, dst_name) in mapping.items():
        src = os.path.join(OUT, src_name)
        if os.path.exists(src):
            dst = os.path.join(run_dir, dst_name)
            shutil.copy2(src, dst)
            result[key] = dst
    for src_name, dst_name in (
        ("article.md", "article.md"),
        ("sentences.json", "sentences.json"),
        ("timeline.json", "timeline.json"),
        ("config.json", "config.json"),
    ):
        src = os.path.join(INPUT_DIR, src_name) if src_name == "article.md" else os.path.join(SRC, src_name)
        if os.path.exists(src):
            shutil.copy2(src, os.path.join(run_dir, dst_name))
    result["run_dir"] = run_dir
    return result


# ── 流水线执行 ──────────────────────────────────────────────────────────

def _run_pipeline(task_id):
    task = get_task(task_id)
    if not task:
        return
    log_path = os.path.join(LOG_DIR, f"{task_id}.log")
    open(log_path, "w", encoding="utf-8").close()

    cmd = [
        sys.executable, os.path.join(SCRIPTS, "run_all.py"),
        "--date", task["date8"],
        "--article", _article_source_arg(task),
        "--concurrency", str(task.get("options", {}).get("concurrency") or 4),
    ]
    opts = task.get("options", {})
    if opts.get("force"):
        cmd.append("--force")
    if opts.get("skip_llm"):
        cmd.append("--skip-llm")
    if opts.get("upload"):
        cmd.append("--upload")

    env = os.environ.copy()
    env["PYTHONUNBUFFERED"] = "1"
    env["PYTHONIOENCODING"] = "utf-8"
    update_task(task_id, status="running", started_at=_now(), step="启动流水线",
                progress={"current": 0, "total": 0}, error="")
    append_log(task_id, f"[web] 执行命令：{' '.join(cmd)}\n")

    skipped = False
    proc = None
    try:
        proc = subprocess.Popen(
            cmd, cwd=ROOT, env=env,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, encoding="utf-8", errors="replace", bufsize=1,
        )
        _procs[task_id] = proc
        for line in proc.stdout:
            append_log(task_id, line)
            m = STEP_RE.match(line.strip())
            if m:
                update_task(task_id, step=m.group(3).strip(),
                            progress={"current": int(m.group(1)), "total": int(m.group(2))})
            if "[SKIP]" in line:
                skipped = True
        rc = proc.wait()
        _procs.pop(task_id, None)

        if skipped:
            update_task(task_id, status="skipped", finished_at=_now(),
                        step="非交易日，已停止", error="")
            append_log(task_id, "\n[web] 非交易日，任务已停止。\n")
            return
        if rc != 0:
            raise RuntimeError(f"流水线退出码 {rc}")

        artifacts = _collect_artifacts(task)
        fields = {
            "status": "success",
            "finished_at": _now(),
            "step": "全部完成",
            "progress": {"current": task.get("progress", {}).get("total", 0),
                         "total": task.get("progress", {}).get("total", 0)},
            "error": "",
            **artifacts,
        }
        # 如果 run_all 已上传B站，读取结果
        bili_result = os.path.join(OUT, "bilibili_result.json")
        if os.path.exists(bili_result):
            try:
                with open(bili_result, encoding="utf-8") as f:
                    br = json.load(f)
                fields["bvid"] = br.get("bvid", "")
                fields["bili_url"] = br.get("url", "")
            except Exception:
                pass
        update_task(task_id, **fields)
        append_log(task_id, "\n[web] 任务完成。\n")
    except Exception as e:  # noqa: BLE001
        _procs.pop(task_id, None)
        err = f"{type(e).__name__}: {e}"
        append_log(task_id, f"\n[web] 任务失败：{err}\n")
        update_task(task_id, status="failed", finished_at=_now(), step="失败", error=err)


def _worker_loop():
    while True:
        task_id = _task_queue.get()
        try:
            task = get_task(task_id)
            if not task or task.get("status") == "cancelled":
                continue
            _run_pipeline(task_id)
        except Exception:  # noqa: BLE001
            traceback.print_exc()
        finally:
            _task_queue.task_done()


def ensure_worker():
    global _worker_started
    with _lock:
        if _worker_started:
            return
        _worker_started = True
        threading.Thread(target=_worker_loop, daemon=True, name="pipeline-worker").start()


# ── FastAPI ─────────────────────────────────────────────────────────────

app = FastAPI(title="A股盘面吐槽大会 控制台", version="1.0.0")


@app.on_event("startup")
def _startup():
    ensure_worker()
    # 服务重启后，之前处于 running 的任务标记为失败
    tasks = load_tasks()
    changed = False
    for t in tasks:
        if t.get("status") in ("running", "queued"):
            t["status"] = "failed"
            t["error"] = "服务重启导致任务中断，请重新运行"
            t["step"] = "中断"
            changed = True
    if changed:
        save_tasks(tasks)


@app.get("/api/health")
def health():
    cfg = load_config()
    s = llm_settings(cfg)
    status, reason = trading_status()
    return {
        "ok": True,
        "date8": date8(),
        "cn_date": cn_date_from_8(date8()),
        "trading_day": status,
        "trading_reason": reason,
        "default_article_url": default_url(date8()),
        "show_name": cfg.get("show_name", ""),
        "voice": cfg.get("voice", ""),
        "rate": cfg.get("rate", ""),
        "llm": {"model": s["model"], "base_url": s["base_url"], "has_key": bool(s["api_key"])},
        "bilibili": {
            "has_cookies": os.path.exists(os.path.join(CONFIG_DIR, "bilibili_cookies.json")),
            "enabled": bool(cfg.get("bilibili", {}).get("enabled")),
        },
        "render": cfg.get("render", {}),
        "article": cfg.get("article", {}),
    }


def default_url(date8_str):
    cfg = load_config()
    art = cfg.get("article", {})
    base = (art.get("base_url") or DEFAULT_ARTICLE_BASE_URL).rstrip("/") + "/"
    return base + (art.get("pattern") or DEFAULT_ARTICLE_PATTERN).format(date=date8_str)


@app.get("/api/trading-day")
def trading_day_api(date: str = "", force: bool = False):
    value = date8_from(date) if date else date8()
    status, reason = trading_status(value, force=force)
    return {"date8": value, "cn_date": cn_date_from_8(value), "status": status, "reason": reason}


@app.get("/api/tasks")
def tasks_api():
    tasks = sorted(load_tasks(), key=lambda t: t.get("created_at", ""), reverse=True)
    return [public_task(t) for t in tasks]


@app.get("/api/tasks/{task_id}")
def task_api(task_id: str):
    t = get_task(task_id)
    if not t:
        raise HTTPException(404, "任务不存在")
    return public_task(t)


@app.post("/api/tasks")
async def create_task(request: Request):
    body = await request.json()
    mode = body.get("article_mode", "auto")
    if mode not in ("auto", "url", "paste", "upload"):
        raise HTTPException(400, "未知的文章来源")

    value = date8_from(body.get("date") or "")
    task_id = "t" + time.strftime("%Y%m%d%H%M%S") + uuid.uuid4().hex[:4]
    article_path = None
    article_url = ""

    if mode == "paste":
        text = (body.get("article_text") or "").strip()
        if len(text) < 50:
            raise HTTPException(400, "粘贴的原文太短（至少 50 字）")
        article_path = os.path.join(ARTICLE_DIR, f"{task_id}.md")
        with open(article_path, "w", encoding="utf-8") as f:
            f.write(text + "\n")
    elif mode == "upload":
        article_path = body.get("article_path")
        if not article_path or not os.path.exists(article_path):
            raise HTTPException(400, "请先上传原文文件")
        if not _is_allowed_article_path(article_path):
            raise HTTPException(400, "原文路径不合法，请重新上传")
    elif mode == "url":
        article_url = (body.get("article_url") or "").strip()
        if not re.match(r"^https?://", article_url, re.I):
            raise HTTPException(400, "请填写合法的 http(s) 原文地址")

    title = (body.get("title") or "").strip()
    options = {
        "voice": body.get("voice") or load_config().get("voice", "zh-CN-YunxiNeural"),
        "rate": body.get("rate") or load_config().get("rate", "+6%"),
        "concurrency": int(body.get("concurrency") or 4),
        "upload": bool(body.get("upload")),
        "force": bool(body.get("force")),
        "skip_llm": bool(body.get("skip_llm")),
    }
    task = {
        "id": task_id,
        "title": title or f"A股盘面吐槽 {cn_date_from_8(value)}",
        "date8": value,
        "article_mode": mode,
        "article_url": article_url,
        "article_path": article_path,
        "options": options,
        "status": "queued",
        "step": "等待执行",
        "progress": {"current": 0, "total": 0},
        "created_at": _now(),
        "started_at": "",
        "finished_at": "",
        "error": "",
        "bvid": "",
        "bili_url": "",
        "video": "",
        "cover": "",
        "run_dir": "",
    }

    # 把音色/语速写回 config，供配音步骤使用
    cfg = load_config()
    cfg["voice"] = options["voice"]
    cfg["rate"] = options["rate"]
    save_config(cfg)

    with _lock:
        tasks = load_tasks()
        tasks.append(task)
        save_tasks(tasks)
    _task_queue.put(task_id)
    return public_task(task)


@app.get("/api/tasks/{task_id}/logs")
def task_logs(task_id: str, offset: int = 0):
    if not get_task(task_id):
        raise HTTPException(404, "任务不存在")
    path = os.path.join(LOG_DIR, f"{task_id}.log")
    if not os.path.exists(path):
        return {"content": "", "next": 0}
    with open(path, encoding="utf-8", errors="replace") as f:
        f.seek(max(0, offset))
        content = f.read()
        nxt = f.tell()
    return {"content": content, "next": nxt}


@app.post("/api/tasks/{task_id}/cancel")
def cancel_task(task_id: str):
    t = get_task(task_id)
    if not t:
        raise HTTPException(404, "任务不存在")
    proc = _procs.get(task_id)
    if proc and proc.poll() is None:
        try:
            if os.name == "nt":
                subprocess.run(["taskkill", "/F", "/T", "/PID", str(proc.pid)],
                               capture_output=True)
            else:
                proc.terminate()
        except Exception:
            pass
    append_log(task_id, "\n[web] 用户取消任务。\n")
    update_task(task_id, status="cancelled", finished_at=_now(), step="已取消")
    return public_task(get_task(task_id))


@app.delete("/api/tasks/{task_id}")
def delete_task(task_id: str):
    t = get_task(task_id)
    if not t:
        raise HTTPException(404, "任务不存在")
    if t.get("status") == "running":
        raise HTTPException(400, "任务运行中，请先取消")
    with _lock:
        tasks = [x for x in load_tasks() if x["id"] != task_id]
        save_tasks(tasks)
    return {"ok": True}


@app.post("/api/tasks/{task_id}/retry")
def retry_task(task_id: str):
    t = get_task(task_id)
    if not t:
        raise HTTPException(404, "任务不存在")
    status = t.get("status")
    if status not in ("failed", "cancelled", "skipped"):
        raise HTTPException(400, f"当前状态（{status}）不可重试，仅失败/取消/跳过的任务可重试")
    update_task(task_id, status="queued", step="排队中",
                progress={"current": 0, "total": 0}, error="",
                started_at=None, finished_at=None)
    append_log(task_id, "\n[web] 用户重试任务。\n")
    _task_queue.put(task_id)
    return public_task(get_task(task_id))


@app.post("/api/articles/upload")
async def upload_article(request: Request):
    """前端以 JSON + base64 上传原文（避免 multipart 依赖）。"""
    body = await request.json()
    filename = _safe_name(body.get("filename") or "article.txt")
    content_b64 = body.get("content") or ""
    try:
        data = base64.b64decode(content_b64)
    except Exception:
        raise HTTPException(400, "文件内容解析失败")
    ext = os.path.splitext(filename)[1].lower()
    if ext not in (".docx", ".md", ".markdown", ".txt", ".text"):
        raise HTTPException(400, "仅支持 docx / md / txt")
    task_id = "a" + time.strftime("%Y%m%d%H%M%S") + uuid.uuid4().hex[:4]
    raw_path = os.path.join(ARTICLE_DIR, f"{task_id}_{filename}")
    with open(raw_path, "wb") as f:
        f.write(data)

    from fetch_article import read_article_file
    try:
        text = read_article_file(raw_path)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, f"无法读取文件：{e}")
    md_path = os.path.join(ARTICLE_DIR, f"{task_id}.md")
    with open(md_path, "w", encoding="utf-8") as f:
        f.write(text + "\n")
    return {
        "path": md_path,
        "filename": filename,
        "chars": len(text),
        "preview": text[:1200],
    }


@app.post("/api/articles/preview")
async def preview_article_api(request: Request):
    body = await request.json()
    mode = body.get("article_mode", "auto")
    value = date8_from(body.get("date") or "")
    try:
        from fetch_article import fetch_article
        if mode == "auto":
            source = "auto"
        elif mode == "url":
            source = (body.get("article_url") or "").strip()
            if not source:
                raise HTTPException(400, "请填写原文地址")
        elif mode == "upload":
            path = body.get("article_path")
            if not path or not os.path.exists(path) or not _is_allowed_article_path(path):
                raise HTTPException(400, "请先上传原文文件")
            source = path
        else:
            text = (body.get("article_text") or "").strip()
            return {"origin": "粘贴文本", "chars": len(text), "preview": text[:1200]}
        path, origin = fetch_article(source, value, retries=1, interval=0)
        with open(path, encoding="utf-8") as f:
            text = f.read()
        return {"origin": origin, "chars": len(text), "preview": text[:1200]}
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, f"获取原文失败：{e}")


@app.post("/api/tasks/{task_id}/upload")
def manual_upload(task_id: str):
    t = get_task(task_id)
    if not t:
        raise HTTPException(404, "任务不存在")
    if t.get("status") != "success":
        raise HTTPException(400, "任务尚未成功完成")
    video = t.get("video") or os.path.join(OUT, "video_final.mp4")
    cover = t.get("cover") or os.path.join(OUT, "cover.png")
    desc = t.get("desc") or os.path.join(OUT, "B站简介.md")
    tags = t.get("tags") or os.path.join(OUT, "tags.txt")
    if not os.path.exists(video):
        raise HTTPException(400, "视频文件不存在")

    cfg = load_config()
    cookies = os.path.join(CONFIG_DIR, "bilibili_cookies.json")
    cmd = [
        sys.executable, os.path.join(SCRIPTS, "upload_bilibili.py"),
        "--video", video,
        "--cover", cover if os.path.exists(cover) else "",
        "--cookies", cookies,
        "--title", t.get("title") or "A股盘面吐槽",
        "--desc-file", desc,
        "--tags-file", tags,
        "--date", t["date8"],
        "--work-dir", os.path.join(RUNS_DIR, task_id, "bilibili_work"),
    ]
    if cfg.get("bilibili", {}).get("headless") is False:
        cmd.append("--show-browser")

    def _do_upload():
        append_log(task_id, f"\n[web] 开始上传B站：{' '.join(cmd)}\n")
        update_task(task_id, upload_status="uploading")
        try:
            proc = subprocess.Popen(cmd, cwd=ROOT, stdout=subprocess.PIPE,
                                    stderr=subprocess.STDOUT, text=True,
                                    encoding="utf-8", errors="replace", bufsize=1)
            for line in proc.stdout:
                append_log(task_id, line)
            rc = proc.wait()
            result_path = os.path.join(OUT, "bilibili_result.json")
            if os.path.exists(result_path):
                with open(result_path, encoding="utf-8") as f:
                    br = json.load(f)
                update_task(task_id, upload_status="done", bvid=br.get("bvid", ""),
                            bili_url=br.get("url", ""))
            elif rc != 0:
                update_task(task_id, upload_status="failed")
            else:
                update_task(task_id, upload_status="done")
        except Exception as e:  # noqa: BLE001
            append_log(task_id, f"\n[web] 上传失败：{e}\n")
            update_task(task_id, upload_status="failed")

    threading.Thread(target=_do_upload, daemon=True).start()
    return {"ok": True, "message": "已开始上传"}


@app.get("/api/tasks/{task_id}/video")
def task_video(task_id: str):
    t = get_task(task_id)
    if not t:
        raise HTTPException(404, "任务不存在")
    path = t.get("video") or os.path.join(OUT, "video_final.mp4")
    if not os.path.exists(path):
        raise HTTPException(404, "视频不存在")
    return FileResponse(path, media_type="video/mp4", filename=os.path.basename(path))


@app.get("/api/tasks/{task_id}/cover")
def task_cover(task_id: str):
    t = get_task(task_id)
    if not t:
        raise HTTPException(404, "任务不存在")
    path = t.get("cover") or os.path.join(OUT, "cover.png")
    if not os.path.exists(path):
        raise HTTPException(404, "封面不存在")
    return FileResponse(path, media_type="image/png")


@app.get("/api/settings")
def get_settings():
    cfg = load_config()
    s = llm_settings(cfg)
    key = s["api_key"]
    masked = (key[:6] + "..." + key[-4:]) if len(key) > 12 else ("已配置" if key else "")
    cookies_path = os.path.join(CONFIG_DIR, "bilibili_cookies.json")
    cookies = ""
    if os.path.exists(cookies_path):
        with open(cookies_path, encoding="utf-8", errors="replace") as f:
            cookies = f.read()
    return {
        "llm": {
            "base_url": s["base_url"],
            "model": s["model"],
            "temperature": s["temperature"],
            "key_masked": masked,
            "has_key": bool(key),
        },
        "bilibili": {
            "cookies": cookies,
            "headless": bool(cfg.get("bilibili", {}).get("headless", True)),
        },
        "render": cfg.get("render", {}),
        "article": cfg.get("article", {}),
        "github": {
            "owner": (cfg.get("github") or {}).get("owner", "Dragontxl"),
            "repo": (cfg.get("github") or {}).get("repo", "ashare-tucao-remotion"),
            "pat": (cfg.get("github") or {}).get("pat", ""),
            "has_pat": bool((cfg.get("github") or {}).get("pat")),
        },
        "r2": {
            "bucket": (cfg.get("r2") or {}).get("bucket", ""),
            "endpoint": (cfg.get("r2") or {}).get("endpoint", ""),
            "public_url": (cfg.get("r2") or {}).get("public_url", ""),
            "configured": bool((cfg.get("r2") or {}).get("bucket") and (cfg.get("r2") or {}).get("access_key_id")),
        },
    }


@app.post("/api/settings")
async def save_settings(request: Request):
    body = await request.json()
    cfg = load_config()
    llm = body.get("llm") or {}
    if llm.get("base_url"):
        cfg.setdefault("llm", {})["base_url"] = llm["base_url"].strip().rstrip("/")
    if llm.get("model"):
        cfg.setdefault("llm", {})["model"] = llm["model"].strip()
    if llm.get("temperature") is not None:
        cfg.setdefault("llm", {})["temperature"] = float(llm["temperature"])
    key = (llm.get("api_key") or "").strip()
    if key and "..." not in key:
        cfg.setdefault("llm", {})["api_key"] = key

    render = body.get("render") or {}
    if render.get("concurrency"):
        cfg.setdefault("render", {})["concurrency"] = max(1, min(8, int(render["concurrency"])))

    bili = body.get("bilibili") or {}
    if bili.get("headless") is not None:
        cfg.setdefault("bilibili", {})["headless"] = bool(bili["headless"])
    if bili.get("cookies") is not None:
        cookies = bili["cookies"].strip()
        path = os.path.join(CONFIG_DIR, "bilibili_cookies.json")
        if cookies:
            with open(path, "w", encoding="utf-8") as f:
                f.write(cookies + "\n")
        elif os.path.exists(path):
            os.remove(path)

    gh = body.get("github") or {}
    if gh.get("pat"):
        cfg.setdefault("github", {})["pat"] = gh["pat"].strip()
    if gh.get("owner"):
        cfg.setdefault("github", {})["owner"] = gh["owner"].strip()
    if gh.get("repo"):
        cfg.setdefault("github", {})["repo"] = gh["repo"].strip()

    r2 = body.get("r2") or {}
    for _k in ("bucket", "access_key_id", "secret_access_key", "endpoint", "public_url"):
        if r2.get(_k):
            cfg.setdefault("r2", {})[_k] = r2[_k].strip()

    save_config(cfg)
    return {"ok": True}


@app.post("/api/settings/test-llm")
def test_llm():
    from common import call_llm
    cfg = load_config()
    try:
        reply = call_llm(cfg, "你是一个测试助手。", "只回复两个字：正常", retries=1)
        return {"ok": True, "reply": (reply or "").strip()[:100]}
    except Exception as e:  # noqa: BLE001
        return JSONResponse(status_code=400, content={"ok": False, "error": str(e)})


# ── B站 扫码登录 ────────────────────────────────────────────────────────

@app.post("/api/bilibili/login")
def bilibili_login():
    """启动本机浏览器扫码登录，登录成功后自动写入 config/bilibili_cookies.json。"""
    global _bili_login_proc
    if _bili_login_proc and _bili_login_proc.poll() is None:
        raise HTTPException(409, "扫码登录已在进行中，请先完成或关闭弹出的浏览器窗口")

    script = os.path.join(SCRIPTS, "bili_login.py")
    if not os.path.exists(script):
        raise HTTPException(500, "缺少 scripts/bili_login.py")

    with open(BILI_LOGIN_STATUS, "w", encoding="utf-8") as f:
        json.dump({"state": "starting", "message": "正在启动浏览器"}, f, ensure_ascii=False)

    cmd = [sys.executable, script,
           "--cookies", BILI_COOKIES,
           "--status-file", BILI_LOGIN_STATUS,
           "--log-file", BILI_LOGIN_LOG]
    env = os.environ.copy()
    env["PYTHONIOENCODING"] = "utf-8"
    kwargs = {"cwd": ROOT, "env": env,
              "stdout": subprocess.DEVNULL, "stderr": subprocess.DEVNULL}
    if os.name == "nt":
        kwargs["creationflags"] = 0x08000000  # CREATE_NO_WINDOW
    _bili_login_proc = subprocess.Popen(cmd, **kwargs)
    return {"ok": True, "message": "浏览器已启动，请用 B站 App 扫码并在手机上确认"}


@app.get("/api/bilibili/login/status")
def bilibili_login_status():
    data = {
        "state": "idle",
        "message": "",
        "has_cookies": os.path.exists(BILI_COOKIES),
        "running": bool(_bili_login_proc and _bili_login_proc.poll() is None),
    }
    if os.path.exists(BILI_LOGIN_STATUS):
        try:
            with open(BILI_LOGIN_STATUS, encoding="utf-8") as f:
                data.update(json.load(f))
        except (OSError, ValueError):
            pass

    if data["running"]:
        data["state"] = "running"
    elif _bili_login_proc is not None and data.get("state") in (None, "idle", "starting"):
        data["state"] = "failed" if _bili_login_proc.returncode else "idle"
        data["message"] = data.get("message") or "登录进程已结束，但未确认结果"

    log_tail = ""
    if os.path.exists(BILI_LOGIN_LOG):
        try:
            with open(BILI_LOGIN_LOG, encoding="utf-8", errors="replace") as f:
                log_tail = "\n".join(f.read().strip().splitlines()[-12:])
        except OSError:
            pass
    data["log"] = log_tail
    return data


@app.post("/api/bilibili/check")
def bilibili_check():
    """校验现有 Cookie 是否仍然有效（不发起上传）。"""
    from bili_login import check_cookies
    ok, message, profile = check_cookies(BILI_COOKIES)
    return JSONResponse(status_code=200 if ok else 400,
                        content={"ok": ok, "message": message, "profile": profile})


# ── GitHub Actions 云端运行 ──────────────────────────────────────────────

def _github_config():
    """读取 GitHub 配置：PAT、仓库 owner、仓库名。
    
    优先环境变量，其次 config.json。
    """
    pat = os.environ.get("GH_PAT") or os.environ.get("GITHUB_PAT") or ""
    owner = os.environ.get("GITHUB_REPO_OWNER", "Dragontxl")
    repo = os.environ.get("GITHUB_REPO_NAME", "ashare-tucao-remotion")
    cfg = load_config()
    gh = cfg.get("github") or {}
    pat = gh.get("pat") or pat
    owner = gh.get("owner") or owner
    repo = gh.get("repo") or repo
    return {"pat": pat, "owner": owner, "repo": repo}


def _r2_config():
    """读取 R2 配置：桶名、Access Key、Secret、Endpoint、公开 URL。"""
    cfg = load_config()
    r2 = cfg.get("r2") or {}
    return {
        "bucket": r2.get("bucket") or os.environ.get("R2_BUCKET_NAME", ""),
        "access_key_id": r2.get("access_key_id") or os.environ.get("R2_ACCESS_KEY_ID", ""),
        "secret_access_key": r2.get("secret_access_key") or os.environ.get("R2_SECRET_ACCESS_KEY", ""),
        "endpoint": r2.get("endpoint") or os.environ.get("R2_ENDPOINT_URL", ""),
        "public_url": r2.get("public_url") or os.environ.get("R2_PUBLIC_URL", ""),
    }


@app.get("/api/github/status")
def github_status():
    """检查 GitHub Actions 云端运行是否已配置。"""
    gh = _github_config()
    r2 = _r2_config()
    return {
        "configured": bool(gh["pat"]),
        "owner": gh["owner"],
        "repo": gh["repo"],
        "has_pat": bool(gh["pat"]),
        "r2_configured": bool(r2["bucket"] and r2["access_key_id"]),
        "r2_bucket": r2["bucket"],
    }


@app.post("/api/github/dispatch")
async def github_dispatch(request: Request):
    """触发 GitHub Actions 云端运行。
    
    调用 repository_dispatch 端点：
      POST https://api.github.com/repos/{owner}/{repo}/dispatches
      event_type = ashare-tucao-generation
      client_payload = {date, article, video_title, concurrency, force, upload, skip_llm}
    """
    gh = _github_config()
    if not gh["pat"]:
        raise HTTPException(400, "未配置 GitHub PAT，请在设置中填写或设置环境变量 GH_PAT")

    body = await request.json()
    date_val = body.get("date") or ""
    article = body.get("article") or ""
    video_title = body.get("video_title") or ""
    concurrency = str(body.get("concurrency") or "4")
    force = body.get("force", False)
    upload = body.get("upload", False)
    skip_llm = body.get("skip_llm", False)

    # repository_dispatch 的 client_payload 最多 10 个顶层属性，这里刚好 7 个
    payload = {
        "event_type": "ashare-tucao-generation",
        "client_payload": {
            "date": date_val,
            "article": article,
            "video_title": video_title,
            "concurrency": concurrency,
            "force": str(force).lower() if isinstance(force, bool) else str(force),
            "upload": str(upload).lower() if isinstance(upload, bool) else str(upload),
            "skip_llm": str(skip_llm).lower() if isinstance(skip_llm, bool) else str(skip_llm),
        },
    }

    url = f"https://api.github.com/repos/{gh['owner']}/{gh['repo']}/dispatches"
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        method="POST",
        headers={
            "Authorization": f"Bearer {gh['pat']}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "Content-Type": "application/json",
            "User-Agent": "ashare-tucao-remotion",
        },
    )
    try:
        resp = urllib.request.urlopen(req, timeout=30)
        raw = resp.read()
        result = json.loads(raw) if raw else {}
        return {"ok": True, "message": "GitHub Actions 已触发", "dispatch_id": result.get("id"),
                "url": f"https://github.com/{gh['owner']}/{gh['repo']}/actions"}
    except urllib.error.HTTPError as e:
        err_body = e.read().decode("utf-8", errors="replace")[:500]
        raise HTTPException(502, f"GitHub API 调用失败：{e.code} {err_body}")
    except Exception as e:  # noqa: BLE001
        raise HTTPException(500, f"触发失败：{str(e)}")


@app.get("/api/github/run")
def github_run():
    """查询最近一次 GitHub Actions 运行状态（含步骤进度）。"""
    gh = _github_config()
    if not gh["pat"]:
        raise HTTPException(400, "未配置 GitHub PAT")

    headers = {
        "Authorization": f"Bearer {gh['pat']}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "ashare-tucao-remotion",
    }

    # 获取最近一次运行
    runs_url = f"https://api.github.com/repos/{gh['owner']}/{gh['repo']}/actions/runs?per_page=1"
    try:
        req = urllib.request.Request(runs_url, headers=headers)
        resp = urllib.request.urlopen(req, timeout=15)
        data = json.loads(resp.read())
        runs = data.get("workflow_runs", [])
        if not runs:
            return {"ok": True, "run": None, "message": "暂无运行记录"}

        run = runs[0]
        run_info = {
            "id": run["id"],
            "name": run.get("name", ""),
            "event": run.get("event", ""),
            "status": run.get("status", ""),
            "conclusion": run.get("conclusion"),
            "html_url": run.get("html_url", ""),
            "created_at": run.get("created_at", ""),
            "updated_at": run.get("updated_at", ""),
            "steps": [],
        }

        # 获取步骤详情
        jobs_url = f"https://api.github.com/repos/{gh['owner']}/{gh['repo']}/actions/runs/{run['id']}/jobs"
        try:
            req2 = urllib.request.Request(jobs_url, headers=headers)
            resp2 = urllib.request.urlopen(req2, timeout=15)
            jobs_data = json.loads(resp2.read())
            for job in jobs_data.get("jobs", []):
                for step in job.get("steps", []):
                    run_info["steps"].append({
                        "name": step.get("name", ""),
                        "status": step.get("status", ""),
                        "conclusion": step.get("conclusion"),
                    })
        except Exception:
            pass  # 步骤获取失败不影响整体返回

        return {"ok": True, "run": run_info}
    except urllib.error.HTTPError as e:
        raise HTTPException(502, f"GitHub API 失败：{e.code}")
    except Exception as e:  # noqa: BLE001
        raise HTTPException(500, f"查询失败：{str(e)}")


@app.post("/api/github/save-config")
async def github_save_config(request: Request):
    """保存 GitHub 与 R2 配置到 config.json。"""
    body = await request.json()
    cfg = load_config()
    gh = body.get("github") or {}
    r2 = body.get("r2") or {}
    if gh.get("pat"):
        cfg.setdefault("github", {})["pat"] = gh["pat"].strip()
    if gh.get("owner"):
        cfg.setdefault("github", {})["owner"] = gh["owner"].strip()
    if gh.get("repo"):
        cfg.setdefault("github", {})["repo"] = gh["repo"].strip()
    for k in ("bucket", "access_key_id", "secret_access_key", "endpoint", "public_url"):
        if r2.get(k):
            cfg.setdefault("r2", {})[k] = r2[k].strip()
    save_config(cfg)
    return {"ok": True}


# ── R2 存储桶代理 ────────────────────────────────────────────────────────

def _r2_client():
    """创建 R2 S3 客户端。未配置则返回 None。"""
    r2 = _r2_config()
    if not r2["bucket"] or not r2["access_key_id"]:
        return None, r2
    import boto3
    from botocore.config import Config
    client = boto3.client(
        "s3",
        endpoint_url=r2["endpoint"].rstrip("/"),
        aws_access_key_id=r2["access_key_id"],
        aws_secret_access_key=r2["secret_access_key"],
        config=Config(
            signature_version="s3v4",
            s3={"addressing_style": "path"},
            retries={"max_attempts": 3, "mode": "standard"},
            max_pool_connections=20,
        ),
    )
    return client, r2


@app.get("/api/r2/list")
def r2_list():
    """列出 R2 桶中的产物（按前缀过滤，返回最新运行记录）。"""
    client, r2 = _r2_client()
    if client is None:
        return {"ok": False, "error": "R2 未配置", "items": []}
    prefix = "ashare-tucao/"
    try:
        resp = client.list_objects_v2(Bucket=r2["bucket"], Prefix=prefix)
        items = []
        for obj in resp.get("Contents", []):
            items.append({
                "key": obj["Key"],
                "size": obj["Size"],
                "last_modified": obj["LastModified"].isoformat(),
            })
        items.sort(key=lambda x: x["last_modified"], reverse=True)
        # 按运行前缀分组
        runs = {}
        for it in items:
            prefix_part = it["key"][len("ashare-tucao/"):].split("/")[0]
            runs.setdefault(prefix_part, []).append(it)
        run_list = [{"prefix": k, "files": v, "count": len(v)} for k, v in sorted(runs.items(), reverse=True)]
        return {"ok": True, "runs": run_list, "public_url": r2["public_url"]}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": str(e), "items": []}


@app.get("/api/r2/file")
def r2_file(key: str, request: Request):
    """从 R2 下载文件（支持 Range 请求，用于视频播放）。"""
    client, r2 = _r2_client()
    if client is None:
        raise HTTPException(400, "R2 未配置")
    try:
        from fastapi.responses import Response as RawResponse
        headers = {}
        range_header = request.headers.get("Range")

        if range_header:
            # 解析 Range: bytes=start-end
            resp = client.get_object(
                Bucket=r2["bucket"], Key=key,
                Range=range_header.replace("bytes=", ""),
            )
            status_code = 206
            headers["Content-Range"] = resp.get("Content-Range", range_header)
        else:
            resp = client.get_object(Bucket=r2["bucket"], Key=key)
            status_code = 200

        body = resp["Body"].read()
        content_type = resp.get("ContentType", "application/octet-stream")
        headers["Content-Type"] = content_type
        headers["Accept-Ranges"] = "bytes"
        headers["Cache-Control"] = "public, max-age=3600"
        headers["X-File-Size"] = str(len(body))

        return RawResponse(content=body, status_code=status_code, headers=headers)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(404, f"文件不存在：{str(e)}")


# ── R2 文件管理（文件浏览器）──────────────────────────────────────────

@app.get("/api/r2/files")
def r2_files(prefix: str = "", cursor: str = ""):
    """列出 R2 文件（支持文件夹结构，用于文件浏览器）。"""
    client, r2 = _r2_client()
    if client is None:
        return {"ok": False, "error": "R2 未配置", "files": [], "folders": []}
    try:
        options = {"Bucket": r2["bucket"], "Prefix": prefix, "MaxKeys": 1000}
        if prefix:
            options["Delimiter"] = "/"
        if cursor:
            options["ContinuationToken"] = cursor

        objects = []
        folder_set = set()
        truncated = False
        next_cursor = cursor or None
        pages = 0
        max_pages = 20

        while True:
            resp = client.list_objects_v2(**options)
            for obj in resp.get("Contents", []):
                objects.append(obj)
            for fp in resp.get("CommonPrefixes", []):
                folder_set.add(fp["Prefix"])
            truncated = resp.get("IsTruncated", False)
            next_cursor = resp.get("NextContinuationToken")
            pages += 1
            if not truncated or not next_cursor or pages >= max_pages:
                break
            options["ContinuationToken"] = next_cursor

        folders = []
        for fp in folder_set:
            name = fp.replace("/", "")
            folders.append({"key": fp, "name": name, "type": "directory", "size": 0, "lastModified": None})

        files = []
        for obj in objects:
            name = obj["Key"].split("/")[-1]
            files.append({
                "key": obj["Key"],
                "name": name,
                "type": "file",
                "size": obj["Size"],
                "lastModified": obj["LastModified"].isoformat() if obj["LastModified"] else None,
                "contentType": obj.get("ContentType"),
            })

        return {
            "ok": True,
            "files": files,
            "folders": folders,
            "truncated": truncated and bool(next_cursor),
            "cursor": next_cursor if truncated and next_cursor else None,
            "prefix": prefix,
        }
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": str(e), "files": [], "folders": []}


@app.post("/api/r2/delete")
async def r2_delete(request: Request):
    """删除文件或文件夹（递归）。"""
    client, r2 = _r2_client()
    if client is None:
        raise HTTPException(400, "R2 未配置")
    body = await request.json()
    key = body.get("key", "")
    is_dir = body.get("is_directory", False)
    if not key:
        raise HTTPException(400, "缺少 key")
    try:
        if is_dir:
            total = 0
            options = {"Bucket": r2["bucket"], "Prefix": key, "MaxKeys": 1000}
            while True:
                resp = client.list_objects_v2(**options)
                keys = [o["Key"] for o in resp.get("Contents", [])]
                if keys:
                    client.delete_objects(
                        Bucket=r2["bucket"],
                        Delete={"Objects": [{"Key": k} for k in keys]},
                    )
                    total += len(keys)
                if resp.get("IsTruncated"):
                    options["ContinuationToken"] = resp["NextContinuationToken"]
                else:
                    break
            try:
                client.delete_object(Bucket=r2["bucket"], Key=key.rstrip("/"))
            except Exception:
                pass
            return {"ok": True, "deleted": total}
        client.delete_object(Bucket=r2["bucket"], Key=key)
        return {"ok": True}
    except Exception as e:  # noqa: BLE001
        raise HTTPException(500, f"删除失败：{str(e)}")


@app.post("/api/r2/batch-delete")
async def r2_batch_delete(request: Request):
    """批量删除文件或文件夹。"""
    client, r2 = _r2_client()
    if client is None:
        raise HTTPException(400, "R2 未配置")
    body = await request.json()
    keys: list = body.get("keys", [])
    if not keys:
        raise HTTPException(400, "缺少 keys")
    total = 0
    errors = []
    for key in keys:
        try:
            client.delete_object(Bucket=r2["bucket"], Key=key)
            total += 1
        except Exception:
            try:
                options = {"Bucket": r2["bucket"], "Prefix": key, "MaxKeys": 1000}
                while True:
                    resp = client.list_objects_v2(**options)
                    obj_keys = [o["Key"] for o in resp.get("Contents", [])]
                    if obj_keys:
                        client.delete_objects(
                            Bucket=r2["bucket"],
                            Delete={"Objects": [{"Key": k} for k in obj_keys]},
                        )
                        total += len(obj_keys)
                    if resp.get("IsTruncated"):
                        options["ContinuationToken"] = resp["NextContinuationToken"]
                    else:
                        break
                try:
                    client.delete_object(Bucket=r2["bucket"], Key=key.rstrip("/"))
                except Exception:
                    pass
            except Exception as e:
                errors.append(f"{key}: {str(e)}")
    return {"ok": True, "deleted": total, "errors": errors}


@app.post("/api/r2/create-folder")
async def r2_create_folder(request: Request):
    """在 R2 中创建文件夹（空对象标记）。"""
    client, r2 = _r2_client()
    if client is None:
        raise HTTPException(400, "R2 未配置")
    body = await request.json()
    key = body.get("key", "")
    if not key:
        raise HTTPException(400, "缺少 key")
    folder_key = key if key.endswith("/") else f"{key}/"
    try:
        client.put_object(Bucket=r2["bucket"], Key=folder_key, Body=b"")
        return {"ok": True, "key": folder_key}
    except Exception as e:  # noqa: BLE001
        raise HTTPException(500, f"创建文件夹失败：{str(e)}")


@app.post("/api/r2/upload")
async def r2_upload(request: Request):
    """上传文件到 R2（base64 编码）。"""
    client, r2 = _r2_client()
    if client is None:
        raise HTTPException(400, "R2 未配置")
    body = await request.json()
    filename = body.get("filename", "")
    content = body.get("content", "")
    content_type = body.get("contentType", "")
    prefix = body.get("prefix", "")
    if not filename or not content:
        raise HTTPException(400, "缺少 filename 或 content")
    try:
        import base64 as b64
        decoded = b64.b64decode(content)
        import re
        safe_name = re.sub(r'[^\w.\-]', '_', filename)
        key = f"{prefix.rstrip('/')}/{safe_name}" if prefix else safe_name
        client.put_object(
            Bucket=r2["bucket"],
            Key=key,
            Body=decoded,
            ContentType=content_type or "application/octet-stream",
        )
        return {"ok": True, "key": key, "size": len(decoded), "filename": filename}
    except Exception as e:  # noqa: BLE001
        raise HTTPException(500, f"上传失败：{str(e)}")


@app.get("/api/r2/stats")
def r2_stats(prefix: str = ""):
    """获取 R2 存储统计。"""
    client, r2 = _r2_client()
    if client is None:
        return {"ok": False, "error": "R2 未配置"}
    try:
        total_size = 0
        total_files = 0
        options = {"Bucket": r2["bucket"], "Prefix": prefix, "MaxKeys": 1000}
        while True:
            resp = client.list_objects_v2(**options)
            for obj in resp.get("Contents", []):
                total_size += obj["Size"]
                total_files += 1
            if resp.get("IsTruncated"):
                options["ContinuationToken"] = resp["NextContinuationToken"]
            else:
                break
        return {
            "ok": True,
            "totalSize": total_size,
            "totalFiles": total_files,
            "totalSizeMB": f"{total_size / 1024 / 1024:.2f}",
            "prefix": prefix,
        }
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": str(e)}


@app.get("/api/r2/download")
def r2_download(key: str):
    """下载文件（带 Content-Disposition）。"""
    client, r2 = _r2_client()
    if client is None:
        raise HTTPException(400, "R2 未配置")
    try:
        from fastapi.responses import StreamingResponse
        import io
        obj = client.get_object(Bucket=r2["bucket"], Key=key)
        body = obj["Body"].read()
        filename = key.split("/")[-1]
        content_type = obj.get("ContentType", "application/octet-stream")
        return StreamingResponse(
            io.BytesIO(body),
            media_type=content_type,
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )
    except Exception as e:  # noqa: BLE001
        raise HTTPException(404, f"文件不存在：{str(e)}")


@app.post("/api/bilibili/upload")
async def bilibili_upload(request: Request):
    """云端触发 B站上传（仅上传模式，从 R2 下载已有产物上传）。

    通过 GitHub repository_dispatch 触发 workflow 的 upload_only 模式。
    """
    body = await request.json()
    date = body.get("date", "")

    # 获取 GitHub 配置
    from common import load_config
    cfg = load_config()
    gh = cfg.get("github", {})
    owner = gh.get("owner", "")
    repo = gh.get("repo", "")
    pat = gh.get("pat", "")

    if not pat:
        return {"ok": False, "error": "未配置 GitHub PAT，请在设置中填写"}
    if not owner or not repo:
        return {"ok": False, "error": "未配置 GitHub 仓库"}

    payload = {
        "event_type": "ashare-tucao-generation",
        "client_payload": {
            "date": date,
            "upload": "true",
            "upload_only": "true",
        },
    }

    import urllib.request
    url = f"https://api.github.com/repos/{owner}/{repo}/dispatches"
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=data, method="POST")
    req.add_header("Authorization", f"Bearer {pat}")
    req.add_header("Accept", "application/vnd.github+json")
    req.add_header("X-GitHub-Api-Version", "2022-11-28")
    req.add_header("Content-Type", "application/json")
    req.add_header("User-Agent", "ashare-tucao-remotion-server")

    try:
        with urllib.request.urlopen(req) as resp:
            if resp.status == 204:
                return {"ok": True, "message": "B站上传任务已触发，请查看运行状态"}
            err_text = resp.read().decode("utf-8", errors="replace")
            return {"ok": False, "error": f"触发失败：{resp.status} {err_text[:300]}"}
    except urllib.error.HTTPError as e:
        err_text = e.read().decode("utf-8", errors="replace")
        return {"ok": False, "error": f"触发失败：{e.code} {err_text[:300]}"}
    except Exception as e:
        return {"ok": False, "error": f"触发失败：{str(e)}"}


# ── 静态资源 ────────────────────────────────────────────────────────────

app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/styles.css")
def styles_css():
    return FileResponse(os.path.join(STATIC_DIR, "styles.css"), media_type="text/css")


@app.get("/app.js")
def app_js():
    return FileResponse(os.path.join(STATIC_DIR, "app.js"), media_type="application/javascript")


@app.get("/")
def index():
    return FileResponse(os.path.join(STATIC_DIR, "index.html"))


@app.get("/favicon.ico")
def favicon():
    return PlainTextResponse("", status_code=204)


def main():
    import argparse
    ap = argparse.ArgumentParser(description="A股盘面吐槽大会 Web 控制台")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--open", action="store_true", help="启动后自动打开浏览器")
    args = ap.parse_args()

    if args.open:
        import webbrowser
        threading.Timer(1.5, lambda: webbrowser.open(f"http://{args.host}:{args.port}")).start()
    print(f"[web] 控制台地址：http://{args.host}:{args.port}")
    uvicorn.run(app, host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()
