#!/usr/bin/env python3
"""Fleet registry, run on the hub only.

Keeps who is in the fleet and how to reach each machine's Paseo daemon, and
records every task sent through it as one Markdown file. Dispatch itself is
Paseo: the hub creates an agent on the target daemon with that machine's
default agent, writes the result back into the task file, and can carry on
the same conversation (reply) or stop it.

It also serves the knowledge base: a folder of Markdown files (kb/) every
agent in the fleet reads and edits through the hub.

Standard library only. Data lives in $FLEET_HOME (default ~/fleet).
"""

import html
import json
import os
import re
import socket
import subprocess
import sys
import threading
import time
import uuid
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

HOME = Path(os.environ.get("FLEET_HOME", Path.home() / "fleet")).expanduser()
PORT = int(os.environ.get("FLEET_PORT", "6780"))
PASEO = os.environ.get("FLEET_PASEO", "paseo")
OFFLINE_AFTER = 6 * 60
POLL_EVERY = 20
TASK_LIMIT = 6 * 60 * 60
SILENT_GRACE = 5 * 60
DONE = {"done", "failed", "stopped"}
NO_RESULT = "（还没完成）"

lock = threading.RLock()
running = set()
SELF_SERVER = None


def now():
    return datetime.now().astimezone()


def stamp(moment=None):
    return (moment or now()).strftime("%Y-%m-%d %H:%M:%S")


def log(message):
    print(f"{stamp()} {message}", flush=True)


# ---- knowledge base --------------------------------------------------------

def kb_dir():
    return HOME / "kb"


def kb_path(name):
    """A Markdown file under kb/; anything else is rejected."""
    name = unquote(name).strip("/") or "README.md"
    path = (kb_dir() / name).resolve()
    if path.suffix != ".md" or kb_dir().resolve() not in path.parents:
        raise ValueError("只能读写 kb 目录里的 .md 文件")
    return path


def kb_list():
    root = kb_dir()
    return [{"path": str(f.relative_to(root)), "size": f.stat().st_size, "modified": stamp(datetime.fromtimestamp(f.stat().st_mtime).astimezone())}
            for f in sorted(root.rglob("*.md"))]


def kb_write(name, text):
    path = kb_path(name)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".md.tmp")
    tmp.write_text(text)
    tmp.replace(path)
    return {"path": str(path.relative_to(kb_dir().resolve())), "size": len(text.encode())}


# ---- nodes ---------------------------------------------------------------

def nodes_path():
    return HOME / "nodes.json"


def load_nodes():
    try:
        return json.loads(nodes_path().read_text())
    except FileNotFoundError:
        return {}


def save_nodes(nodes):
    tmp = nodes_path().with_suffix(".tmp")
    tmp.write_text(json.dumps(nodes, ensure_ascii=False, indent=2))
    tmp.replace(nodes_path())


def own_server_id():
    try:
        out = subprocess.run([PASEO, "status", "--json"], capture_output=True, text=True, timeout=30).stdout
        return json.loads(out).get("serverId")
    except Exception:
        return None


def direct_endpoint(info):
    """A daemon listening beyond localhost is dialled directly when the hub can reach it."""
    listen = info.get("listen") or ""
    if listen.startswith("127.") or listen.startswith("localhost") or ":" not in listen:
        return None
    port = int(listen.rsplit(":", 1)[1])
    for ip in info.get("ips") or []:
        if ":" in ip:
            continue
        try:
            with socket.create_connection((ip, port), timeout=1.5):
                return f"{ip}:{port}"
        except OSError:
            continue
    return None


def merge_report(node, info, direct):
    for key, value in info.items():
        if key not in ("node_id", "name", "joined_at"):
            node[key] = value
    node["last_seen"] = time.time()
    if SELF_SERVER and node.get("server_id") == SELF_SERVER:
        node["endpoint"], node["via"] = None, "local"
    elif direct:
        node["endpoint"], node["via"] = direct, "direct"
    else:
        node["endpoint"], node["via"] = node.get("pairing_url"), "relay"
    return node


def public_node(node):
    view = {k: v for k, v in node.items() if k not in ("pairing_url", "role", "ssh")}
    seen = node.get("last_seen") or 0
    view["online"] = time.time() - seen < OFFLINE_AFTER
    view["last_seen_at"] = stamp(datetime.fromtimestamp(seen).astimezone()) if seen else None
    if node.get("via") == "relay":
        view["endpoint"] = "relay"
    return view


def roster():
    with lock:
        return [public_node(n) for n in sorted(load_nodes().values(), key=lambda n: n["name"])]


# ---- task files ------------------------------------------------------------
#
# ---
# id / title / from / to / agent / status / created / started / finished / rounds / cwd / paseo_agent
# ---
# ## 任务        what was asked first
# ## 往来        follow-ups and earlier results, oldest first (only after a reply)
# ## 结果        the latest result

FIELDS = ["id", "title", "from", "to", "agent", "status", "created", "started", "finished", "rounds", "cwd", "paseo_agent"]


def tasks_dir():
    return HOME / "tasks"


def next_id():
    counter = HOME / "counter"
    with lock:
        value = int(counter.read_text()) + 1 if counter.exists() else 1
        counter.write_text(str(value))
        return value


def slug(text):
    text = re.sub(r"[\s/\\:*?\"<>|#]+", "-", text.strip())[:40].strip("-")
    return text or "task"


def task_files():
    return sorted(tasks_dir().glob("*/*.md"), reverse=True)


def find_task(task_id):
    prefix = f"{int(task_id):04d}-"
    for path in task_files():
        if path.name.startswith(prefix):
            return path
    return None


def read_task(path):
    text = path.read_text()
    meta, body = {}, text
    if text.startswith("---\n"):
        head, _, body = text[4:].partition("\n---\n")
        for line in head.splitlines():
            key, _, value = line.partition(":")
            meta[key.strip()] = value.strip()
    # Only our headings split the body; the agent's own "## " lines stay where they are.
    before, _, result = body.partition("\n## 结果\n")
    task, _, history = before.partition("\n## 往来\n")
    meta["prompt"] = task.split("## 任务\n", 1)[-1].strip()
    meta["history"] = history.strip()
    meta["result"] = result.strip()
    meta["path"] = str(path)
    return meta


def write_task(path, meta):
    lines = ["---"] + [f"{key}: {str(meta.get(key) or '').replace(chr(10), ' ')}" for key in FIELDS] + ["---"]
    lines += ["## 任务", "", meta.get("prompt", "").strip(), ""]
    if meta.get("history"):
        lines += ["## 往来", "", meta["history"].strip(), ""]
    lines += ["## 结果", "", (meta.get("result") or NO_RESULT).strip(), ""]
    tmp = path.with_suffix(".tmp")
    tmp.write_text("\n".join(lines))
    tmp.replace(path)


def update_task(path, **changes):
    with lock:
        meta = read_task(path)
        meta.update(changes)
        write_task(path, meta)
        return meta


def parse_agent(text):
    provider, _, model = text.partition("/")
    return {"provider": provider, **({"model": model} if model else {})}


def format_agent(agent):
    text = agent.get("provider", "") + (f"/{agent['model']}" if agent.get("model") else "")
    return text + (f" ({agent['mode']})" if agent.get("mode") else "")


def create_task(data):
    target = (data.get("to") or "").strip()
    prompt = (data.get("prompt") or "").strip()
    if not target or not prompt:
        raise ValueError("to 和 prompt 都要填")
    with lock:
        node = load_nodes().get(target)
    if not node:
        raise ValueError(f"没有叫 {target} 的机器，先看 fleet nodes")
    agent = data.get("agent") or node.get("agent") or {}
    if isinstance(agent, str):
        agent = parse_agent(agent)
    task_id = next_id()
    title = (data.get("title") or prompt.splitlines()[0])[:60]
    folder = tasks_dir() / now().strftime("%Y-%m-%d")
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / f"{task_id:04d}-{target}-{slug(title)}.md"
    meta = {
        "id": task_id, "title": title, "from": data.get("from") or "unknown", "to": target,
        "agent": format_agent(agent), "status": "queued", "created": stamp(), "rounds": 1,
        "cwd": data.get("cwd") or node.get("cwd") or "", "prompt": prompt,
    }
    with lock:
        write_task(path, meta)
    log(f"task #{task_id} {meta['from']} -> {target}: {title}")
    start_worker(path)
    return read_task(path)


def reply_task(task_id, data):
    path = find_task(task_id)
    prompt = (data.get("prompt") or "").strip()
    if not path or not prompt:
        raise ValueError("没有这个任务，或者追问内容是空的")
    with lock:
        meta = read_task(path)
        if not meta.get("paseo_agent"):
            raise ValueError("这个任务还没派出去，不能追问")
        if meta.get("status") not in DONE:
            raise ValueError("它还在干，等干完再追问，或者先 fleet stop")
        rounds = int(meta.get("rounds") or 1)
        earlier = meta.get("history", "")
        if meta.get("result") and meta["result"] != NO_RESULT:
            earlier += f"\n\n### 第 {rounds} 轮结果\n\n{meta['result']}"
        earlier += f"\n\n### 追问 · {stamp()} · {data.get('from') or 'unknown'}\n\n{prompt}"
        update_task(path, history=earlier.strip(), result="", status="running", finished="", rounds=rounds + 1)
    log(f"task #{task_id} reply from {data.get('from')}")
    start_worker(path, reply=prompt)
    return read_task(path)


def stop_task(task_id):
    path = find_task(task_id)
    if not path:
        raise ValueError("没有这个任务")
    meta = read_task(path)
    if meta.get("status") in DONE:
        return meta
    node = load_nodes().get(meta["to"]) or {}
    if meta.get("paseo_agent"):
        paseo(["stop", meta["paseo_agent"]], node.get("endpoint"))
    log(f"task #{task_id} stopped")
    stopped = update_task(path, status="stopped", finished=stamp(), result=(meta.get("result") if meta.get("result") != NO_RESULT else "") or "被叫停")
    if meta.get("paseo_agent"):
        threading.Thread(target=tidy, args=(stopped, node), daemon=True).start()
    return stopped


def list_tasks(query):
    items = []
    limit = int(query.get("limit", ["50"])[0])
    for path in task_files():
        meta = read_task(path)
        if any(query.get(key) and meta.get(key) != query[key][0] for key in ("to", "from", "status")):
            continue
        for key in ("prompt", "history"):
            meta.pop(key, None)
        meta["result"] = meta.get("result", "")[:200]
        items.append(meta)
        if len(items) >= limit:
            break
    return items


# ---- dispatch ------------------------------------------------------------

def paseo(args, endpoint, timeout=120):
    command = [PASEO] + args + (["--host", endpoint] if endpoint else [])
    result = subprocess.run(command, capture_output=True, text=True, timeout=timeout)
    if result.returncode != 0:
        raise RuntimeError((result.stderr or result.stdout).strip()[:500] or f"paseo {args[0]} failed")
    return json.loads(result.stdout) if result.stdout.strip().startswith(("{", "[")) else result.stdout


def replies(agent_id, endpoint):
    logs = paseo(["logs", agent_id, "--json"], endpoint)
    return [i["text"].strip() for i in logs.get("items", []) if i.get("type") == "assistant_message" and i.get("text", "").strip()]


def tidy(meta, node):
    """A finished task leaves nothing open in the target's Paseo: archive its agent
    (the whole workspace when the task was alone in it) and drop the shared
    ~/fleet/work project once nothing there is live. Replies still reach an
    archived agent; it comes back on its own."""
    endpoint, agent_id = node.get("endpoint"), meta.get("paseo_agent")
    try:
        agents = paseo(["ls", "--json"], endpoint)
        mine = next((a for a in agents if a["id"] == agent_id), None)
        workspace = mine and mine.get("workspaceId")
        if workspace and not any(a["workspaceId"] == workspace and a["id"] != agent_id for a in agents):
            paseo(["workspace", "archive", workspace], endpoint)
        else:
            paseo(["archive", agent_id], endpoint)
        work_dir = node.get("cwd")
        busy = any(read_task(p).get("status") not in DONE and read_task(p).get("to") == meta["to"] and read_task(p).get("id") != meta["id"]
                   for p in task_files()[:200])
        if work_dir and not busy and not any(w.get("cwd") == work_dir for w in paseo(["workspace", "ls", "--json"], endpoint)):
            for project in paseo(["project", "ls", "--json"], endpoint):
                if project.get("path") == work_dir:
                    paseo(["project", "delete", project["projectId"]], endpoint)
    except Exception as error:
        log(f"task #{meta.get('id')} tidy failed: {error}")


def start_worker(path, reply=None):
    key = str(path)
    # A reply can land just after the last round was marked done, while its
    # worker is still on the way out; give that worker a moment to leave.
    for _ in range(50 if reply else 1):
        with lock:
            if key not in running:
                running.add(key)
                break
        time.sleep(0.2)
    else:
        if reply:
            update_task(path, status="failed", finished=stamp(), result="追问没发出去：上一轮还没收尾，稍后再试")
        return
    threading.Thread(target=work, args=(path, reply), daemon=True).start()


def work(path, reply=None):
    meta = read_task(path)
    try:
        with lock:
            node = load_nodes().get(meta["to"])
        if not node:
            update_task(path, status="failed", finished=stamp(), result="目标机器已不在机群里")
            return
        endpoint = node.get("endpoint")
        if node.get("via") == "relay" and not endpoint:
            update_task(path, status="failed", finished=stamp(), result="还不知道怎么连这台机器（没有上报过配对链接）")
            return
        agent_id = meta.get("paseo_agent")
        baseline = None  # assistant messages before this round; unknown when resuming after a restart
        if not agent_id:
            agent = parse_agent(meta["agent"].split(" (")[0]) if meta.get("agent") else {}
            mode = re.search(r"\((.+)\)$", meta.get("agent", ""))
            prompt = (
                f"[机群任务 #{meta['id']}] 来自 {meta['from']}。\n\n{meta['prompt']}\n\n---\n"
                "干完后，最后一条消息写清楚结果：做了什么、产物在哪（路径或链接）、还有什么没做完。这段会原样记进任务记录。"
            )
            args = ["run", "--no-wait", "--json", "--title", f"#{meta['id']} {meta['title']}"[:60],
                    "--cwd", meta.get("cwd") or node.get("cwd") or "/tmp", "--label", f"fleet_task={meta['id']}"]
            args += ["--provider", agent["provider"]] if agent.get("provider") else []
            args += ["--model", agent["model"]] if agent.get("model") else []
            args += ["--mode", mode.group(1)] if mode else []
            agent_id = paseo(args + [prompt], endpoint, timeout=180)["agentId"]
            baseline = 0
            update_task(path, status="running", started=stamp(), paseo_agent=agent_id)
            log(f"task #{meta['id']} running on {meta['to']} as {agent_id}")
        elif reply:
            baseline = len(replies(agent_id, endpoint))
            # Replies only go to an idle agent, so the default delivery interrupts nothing.
            paseo(["send", agent_id, "--no-wait", "--prompt",
                   f"[机群任务 #{meta['id']} 追问]\n\n{reply}\n\n---\n干完后最后一条消息照样写清楚结果。"], endpoint, timeout=180)
        begun = time.time()
        while time.time() - begun < TASK_LIMIT:
            time.sleep(POLL_EVERY)
            if read_task(path).get("status") == "stopped":
                return
            try:
                state = paseo(["inspect", agent_id, "--json"], endpoint)
            except Exception as error:
                log(f"task #{meta['id']} inspect failed: {error}")
                continue
            status = (state.get("Status") or "").lower()
            if status in ("idle", "error", "closed"):
                said = replies(agent_id, endpoint)
                fresh = len(said) > baseline if baseline is not None else bool(said)
                # Idle with nothing new usually means this round has not started yet.
                if status == "idle" and not fresh and time.time() - begun < SILENT_GRACE:
                    continue
                final = "done" if status == "idle" else "failed"
                result = said[-1] if fresh else "（这一轮没有留下文字结果，去 Paseo 里看过程）"
                update_task(path, status=final, finished=stamp(), result=result)
                log(f"task #{meta['id']} {final}")
                tidy(meta | {"paseo_agent": agent_id}, node)
                return
            current = "blocked" if state.get("PendingPermissions") else "running"
            if read_task(path).get("status") != current:
                update_task(path, status=current)
        update_task(path, status="failed", finished=stamp(), result="超过 6 小时没有结束，中心不再等待；Agent 可能还在跑，去 Paseo 里看")
    except Exception as error:
        update_task(path, status="failed", finished=stamp(), result=f"派活失败：{error}")
        log(f"task #{meta.get('id')} failed: {error}")
    finally:
        with lock:
            running.discard(str(path))


def resume():
    for path in task_files():
        if read_task(path).get("status") not in DONE:
            start_worker(path)


# ---- http ----------------------------------------------------------------

STATUS_LABELS = {"queued": "排队", "running": "进行中", "blocked": "等审批", "done": "完成", "failed": "失败", "stopped": "已叫停"}

PAGE = """<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<meta http-equiv=refresh content=30><title>机群</title><style>
body{font:14px/1.5 -apple-system,"PingFang SC",sans-serif;margin:24px auto;max-width:1180px;padding:0 16px;color:#171717}
h2{font-size:15px;margin:28px 0 8px}table{border-collapse:collapse;width:100%}
th,td{text-align:left;padding:7px 10px;border-bottom:1px solid #eee;vertical-align:top}th{color:#666;font-weight:500}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px}.on{background:#16a34a}.off{background:#c9c9c9}
.muted{color:#8f8f8f}.chip{padding:1px 8px;border-radius:999px;background:#f2f2f2;font-size:12px}
.done{background:#edf3ec;color:#2b6e46}.failed{background:#fdebec;color:#a8302b}.running,.blocked{background:#e7f3f8;color:#2b6a8f}
a{color:#2383e2;text-decoration:none}pre{white-space:pre-wrap;background:#fafafa;padding:12px;border-radius:8px}
nav a{margin-right:12px}</style><nav><a href='/'>机群</a><a href='/kb'>知识中心</a></nav>"""


def render_index(query):
    rows = []
    for n in roster():
        labels = " ".join(f"{k}={v}" for k, v in (n.get("labels") or {}).items())
        rows.append(
            f"<tr><td><span class='dot {'on' if n['online'] else 'off'}'></span>{html.escape(n['name'])}</td>"
            f"<td>{html.escape(format_agent(n.get('agent') or {}))}</td><td>{html.escape(n.get('via') or '')}</td>"
            f"<td class=muted>{html.escape(', '.join(n.get('ips') or []))}</td><td class=muted>{html.escape(labels)}</td>"
            f"<td class=muted>{html.escape(n.get('last_seen_at') or '从未')}</td><td>{n.get('running', '')}</td></tr>")
    tasks = []
    for t in list_tasks(query):
        status = t.get("status", "")
        tasks.append(
            f"<tr><td><a href='/tasks/{t['id']}'>#{t['id']}</a></td><td class=muted>{html.escape(t.get('created', ''))}</td>"
            f"<td>{html.escape(t.get('from', ''))} → <a href='/?to={html.escape(t.get('to', ''))}'>{html.escape(t.get('to', ''))}</a></td>"
            f"<td>{html.escape(t.get('title', ''))}</td><td><a class='chip {status}' href='/?status={status}'>{STATUS_LABELS.get(status, status)}</a></td></tr>")
    filters = " · ".join(f"{k}={v[0]}" for k, v in query.items() if k in ("to", "from", "status"))
    return (PAGE + "<h2>机器</h2><table><tr><th>名字</th><th>默认 Agent</th><th>连法</th><th>IP</th><th>标签</th><th>最近心跳</th><th>在跑</th></tr>"
            + "".join(rows) + "</table>"
            + f"<h2>派活 {('· 筛选 ' + html.escape(filters) + ' <a href=/>清除</a>') if filters else ''}</h2>"
            + "<table><tr><th>编号</th><th>时间</th><th>谁 → 谁</th><th>任务</th><th>状态</th></tr>" + "".join(tasks) + "</table>")


def render_task(task_id):
    path = find_task(task_id)
    if not path:
        return None
    return PAGE + f"<p class=muted>{html.escape(str(path))}</p><pre>{html.escape(path.read_text())}</pre>"


def render_kb(name):
    path = kb_path(name)
    if not path.exists():
        return None
    files = "".join(f"<li><a href='/kb/{html.escape(f['path'])}'>{html.escape(f['path'])}</a> <span class=muted>{f['modified']}</span></li>" for f in kb_list())
    return PAGE + f"<h2>{html.escape(str(path.relative_to(kb_dir().resolve())))}</h2><pre>{html.escape(path.read_text())}</pre><h2>全部文件</h2><ul>{files}</ul>"


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def send(self, code, body, kind="application/json"):
        data = (json.dumps(body, ensure_ascii=False) if kind == "application/json" else body).encode()
        self.send_response(code)
        self.send_header("Content-Type", f"{kind}; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def body(self):
        length = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(length) or b"{}")

    def do_GET(self):
        url = urlparse(self.path)
        query = parse_qs(url.query)
        if url.path == "/":
            return self.send(200, render_index(query), "text/html")
        match = re.fullmatch(r"/tasks/(\d+)", url.path)
        if match:
            page = render_task(match.group(1))
            return self.send(200, page, "text/html") if page else self.send(404, "没有这个任务", "text/plain")
        if url.path == "/kb" or url.path.startswith("/kb/"):
            try:
                page = render_kb(url.path[3:])
            except ValueError as error:
                return self.send(400, str(error), "text/plain")
            return self.send(200, page, "text/html") if page else self.send(404, "没有这个文件", "text/plain")
        if url.path == "/api/kb":
            return self.send(200, kb_list())
        if url.path.startswith("/api/kb/"):
            try:
                path = kb_path(url.path[len("/api/kb/"):])
            except ValueError as error:
                return self.send(400, {"error": str(error)})
            return self.send(200, path.read_text(), "text/markdown") if path.exists() else self.send(404, {"error": "没有这个文件"})
        if url.path == "/api/nodes":
            return self.send(200, roster())
        if url.path == "/api/tasks":
            return self.send(200, list_tasks(query))
        match = re.fullmatch(r"/api/tasks/(\d+)", url.path)
        if match:
            path = find_task(match.group(1))
            return self.send(200, read_task(path) | {"text": path.read_text()}) if path else self.send(404, {"error": "没有这个任务"})
        self.send(404, {"error": "not found"})

    def do_POST(self):
        try:
            data = self.body()
            path = urlparse(self.path).path
            if path == "/api/join":
                return self.join(data)
            if path == "/api/heartbeat":
                return self.heartbeat(data)
            if path == "/api/leave":
                return self.leave(data)
            if path == "/api/tasks":
                return self.send(201, create_task(data))
            match = re.fullmatch(r"/api/tasks/(\d+)/(reply|stop)", path)
            if match:
                task_id, action = match.groups()
                return self.send(200, reply_task(task_id, data) if action == "reply" else stop_task(task_id))
            self.send(404, {"error": "not found"})
        except ValueError as error:
            self.send(400, {"error": str(error)})
        except Exception as error:
            self.send(500, {"error": str(error)})

    def do_PUT(self):
        try:
            path = urlparse(self.path).path
            if not path.startswith("/api/kb/"):
                return self.send(404, {"error": "not found"})
            text = self.rfile.read(int(self.headers.get("Content-Length") or 0)).decode()
            with lock:
                written = kb_write(path[len("/api/kb/"):], text)
            log(f"kb written: {written['path']}")
            self.send(200, written)
        except ValueError as error:
            self.send(400, {"error": str(error)})
        except Exception as error:
            self.send(500, {"error": str(error)})

    def join(self, data):
        name = (data.get("name") or "").strip()
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,31}", name):
            raise ValueError("名字只能用字母、数字、点、横线、下划线，最长 32 个字符")
        info = data.get("info") or {}
        direct = direct_endpoint(info)  # dial outside the lock: it can take seconds
        with lock:
            nodes = load_nodes()
            known = nodes.get(name)
            if known and known.get("node_id") != data.get("node_id"):
                raise ValueError(f"{name} 已经被另一台机器占用，换个名字")
            node = known or {"name": name, "node_id": data.get("node_id") or uuid.uuid4().hex, "joined_at": stamp()}
            nodes[name] = merge_report(node, info, direct)
            save_nodes(nodes)
        log(f"joined: {name}")
        self.send(200, public_node(node) | {"node_id": node["node_id"]})

    def heartbeat(self, data):
        info = data.get("info") or {}
        direct = direct_endpoint(info)
        with lock:
            nodes = load_nodes()
            node = next((n for n in nodes.values() if n.get("node_id") == data.get("node_id")), None)
            if not node:
                return self.send(404, {"error": "中心不认识这台机器，重新 fleet join"})
            merge_report(node, info, direct)
            save_nodes(nodes)
        self.send(200, {"ok": True})

    def leave(self, data):
        with lock:
            nodes = load_nodes()
            gone = [k for k, n in nodes.items() if n.get("node_id") == data.get("node_id")]
            for key in gone:
                del nodes[key]
            save_nodes(nodes)
        log(f"left: {gone}")
        self.send(200, {"removed": gone})


class DualStackServer(ThreadingHTTPServer):
    """Listen on IPv4 and IPv6: some machines reach the hub only over one of them."""
    address_family = socket.AF_INET6

    def server_bind(self):
        self.socket.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
        super().server_bind()


def main():
    global SELF_SERVER
    (HOME / "tasks").mkdir(parents=True, exist_ok=True)
    kb_dir().mkdir(parents=True, exist_ok=True)
    SELF_SERVER = own_server_id()
    resume()
    log(f"fleet registry on :{PORT}, data in {HOME}, self {SELF_SERVER}")
    DualStackServer(("::", PORT), Handler).serve_forever()


if __name__ == "__main__":
    sys.exit(main())
