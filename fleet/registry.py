#!/usr/bin/env python3
"""Fleet registry, run on the hub only.

Keeps who is in the fleet and how to reach each machine's Paseo daemon, and
records every task sent through it as one Markdown file. Dispatch itself is
Paseo: the hub creates an agent on the target daemon with that machine's
default agent and writes the result back into the task file.

Standard library only. Data lives in $FLEET_HOME (default ~/fleet).
"""

import html
import json
import os
import re
import shlex
import socket
import subprocess
import sys
import threading
import time
import uuid
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

HOME = Path(os.environ.get("FLEET_HOME", Path.home() / "fleet")).expanduser()
PORT = int(os.environ.get("FLEET_PORT", "6780"))
PASEO = os.environ.get("FLEET_PASEO", "paseo")
OFFLINE_AFTER = 6 * 60
EDGE_EVERY = 60
POLL_EVERY = 20
TASK_LIMIT = 6 * 60 * 60
DONE = {"done", "failed"}

lock = threading.RLock()
running = set()


def now():
    return datetime.now().astimezone()


def stamp(moment=None):
    return (moment or now()).strftime("%Y-%m-%d %H:%M:%S")


def log(message):
    print(f"{stamp()} {message}", flush=True)


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


SELF_SERVER = None


def reachable(ip, port):
    try:
        with socket.create_connection((ip, port), timeout=1.5):
            return True
    except OSError:
        return False


def direct_endpoint(info):
    """A daemon listening beyond localhost is dialled directly when the hub can reach it."""
    listen = info.get("listen") or ""
    if listen.startswith("127.") or listen.startswith("localhost") or ":" not in listen:
        return None
    port = int(listen.rsplit(":", 1)[1])
    for ip in info.get("ips") or []:
        if ":" in ip:
            continue
        if reachable(ip, port):
            return f"{ip}:{port}"
    return None


def merge_report(node, info):
    keep = ("node_id", "name", "role", "joined_at", "ssh")
    for key, value in info.items():
        if key not in keep:
            node[key] = value
    node["last_seen"] = time.time()
    if SELF_SERVER and node.get("server_id") == SELF_SERVER:
        node["endpoint"], node["via"] = None, "local"
    else:
        direct = direct_endpoint(node)
        if direct:
            node["endpoint"], node["via"] = direct, "direct"
        else:
            node["endpoint"], node["via"] = node.get("pairing_url"), "relay"
    return node


def public_node(node):
    view = {k: v for k, v in node.items() if k != "pairing_url"}
    seen = node.get("last_seen") or 0
    view["online"] = time.time() - seen < OFFLINE_AFTER
    view["last_seen_at"] = stamp(datetime.fromtimestamp(seen).astimezone()) if seen else None
    if node.get("via") == "relay":
        view["endpoint"] = "relay"
    return view


def roster():
    with lock:
        return [public_node(n) for n in sorted(load_nodes().values(), key=lambda n: n["name"])]


# ---- tasks ---------------------------------------------------------------

FIELDS = ["id", "title", "from", "to", "agent", "status", "created", "started", "finished", "cwd", "paseo_agent"]


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
    sections = re.split(r"^## ", body, flags=re.M)
    parts = {}
    for section in sections[1:]:
        name, _, content = section.partition("\n")
        parts[name.strip()] = content.strip()
    meta["prompt"] = parts.get("任务", "")
    meta["result"] = parts.get("结果", "")
    meta["path"] = str(path)
    return meta


def write_task(path, meta):
    lines = ["---"]
    for key in FIELDS:
        value = str(meta.get(key) or "").replace("\n", " ")
        lines.append(f"{key}: {value}")
    lines += ["---", "## 任务", "", meta.get("prompt", "").strip(), "", "## 结果", "", (meta.get("result") or "（还没完成）").strip(), ""]
    tmp = path.with_suffix(".tmp")
    tmp.write_text("\n".join(lines))
    tmp.replace(path)


def update_task(path, **changes):
    with lock:
        meta = read_task(path)
        meta.update(changes)
        write_task(path, meta)
        return meta


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
    day = now().strftime("%Y-%m-%d")
    folder = tasks_dir() / day
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / f"{task_id:04d}-{target}-{slug(title)}.md"
    meta = {
        "id": task_id, "title": title, "from": data.get("from") or "unknown", "to": target,
        "agent": format_agent(agent), "status": "queued", "created": stamp(), "prompt": prompt,
        "cwd": data.get("cwd") or node.get("cwd") or "",
    }
    with lock:
        write_task(path, meta)
    log(f"task #{task_id} {meta['from']} -> {target}: {title}")
    start_worker(path)
    return read_task(path)


def parse_agent(text):
    parts = text.split("/", 1)
    agent = {"provider": parts[0]}
    if len(parts) > 1:
        agent["model"] = parts[1]
    return agent


def format_agent(agent):
    text = agent.get("provider", "")
    if agent.get("model"):
        text += "/" + agent["model"]
    if agent.get("mode"):
        text += f" ({agent['mode']})"
    return text


def list_tasks(query):
    items = []
    limit = int(query.get("limit", ["50"])[0])
    for path in task_files():
        meta = read_task(path)
        if any(query.get(key) and meta.get(key) != query[key][0] for key in ("to", "from", "status")):
            continue
        meta.pop("prompt", None)
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


def last_reply(agent_id, endpoint):
    logs = paseo(["logs", agent_id, "--json"], endpoint)
    for item in reversed(logs.get("items", [])):
        if item.get("type") == "assistant_message" and item.get("text", "").strip():
            return item["text"].strip()
    return None


def start_worker(path):
    key = str(path)
    with lock:
        if key in running:
            return
        running.add(key)
    threading.Thread(target=work, args=(path,), daemon=True).start()


def work(path):
    try:
        meta = read_task(path)
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
        if not agent_id:
            agent = parse_agent(meta["agent"].split(" (")[0]) if meta.get("agent") else {}
            mode = re.search(r"\((.+)\)$", meta.get("agent", ""))
            prompt = (
                f"[机群任务 #{meta['id']}] 来自 {meta['from']}。\n\n{meta['prompt']}\n\n---\n"
                "干完后，最后一条消息写清楚结果：做了什么、产物在哪（路径或链接）、还有什么没做完。这段会原样记进任务记录。"
            )
            args = ["run", "--no-wait", "--json", "--title", f"#{meta['id']} {meta['title']}"[:60],
                    "--cwd", meta.get("cwd") or node.get("cwd") or "/tmp", "--label", f"fleet_task={meta['id']}"]
            if agent.get("provider"):
                args += ["--provider", agent["provider"]]
            if agent.get("model"):
                args += ["--model", agent["model"]]
            if mode:
                args += ["--mode", mode.group(1)]
            created = paseo(args + [prompt], endpoint, timeout=180)
            agent_id = created["agentId"]
            update_task(path, status="running", started=stamp(), paseo_agent=agent_id)
            log(f"task #{meta['id']} running on {meta['to']} as {agent_id}")
        begun = time.time()
        deadline = begun + TASK_LIMIT
        while time.time() < deadline:
            time.sleep(POLL_EVERY)
            try:
                state = paseo(["inspect", agent_id, "--json"], endpoint)
            except Exception as error:
                log(f"task #{meta['id']} inspect failed: {error}")
                continue
            status = (state.get("Status") or "").lower()
            if status in ("idle", "error", "closed"):
                result = last_reply(agent_id, endpoint)
                # Idle before saying anything usually means it has not started yet.
                if status == "idle" and result is None and time.time() - begun < 120:
                    continue
                final = "done" if status == "idle" else "failed"
                update_task(path, status=final, finished=stamp(), result=result or "（Agent 没有留下文字结果，去 Paseo 里看过程）")
                log(f"task #{meta['id']} {final}")
                return
            pending = "blocked" if state.get("PendingPermissions") else "running"
            if read_task(path).get("status") != pending:
                update_task(path, status=pending)
        update_task(path, status="failed", finished=stamp(), result="超过 6 小时没有结束，中心不再等待；Agent 可能还在跑，去 Paseo 里看")
    except Exception as error:
        update_task(path, status="failed", finished=stamp(), result=f"派活失败：{error}")
        log(f"task {path.name} failed: {error}")
    finally:
        with lock:
            running.discard(str(path))


def resume():
    for path in task_files():
        meta = read_task(path)
        if meta.get("status") not in DONE:
            start_worker(path)


# ---- edges: reachable from the hub, cannot reach it ------------------------

def ssh(node, command, data=None, timeout=60):
    return subprocess.run(shlex.split(node["ssh"]) + [command], input=data, capture_output=True, timeout=timeout,
                          text=isinstance(data, str) or data is None)


FLEET_BIN = 'python3 "$HOME/.local/lib/fleet/fleet"'


def sync_edge(node):
    report = ssh(node, f"{FLEET_BIN} report --stdout")
    if report.returncode != 0:
        log(f"edge {node['name']} unreachable: {report.stderr.strip()[:200]}")
        return
    with lock:
        nodes = load_nodes()
        merge_report(nodes[node["name"]], json.loads(report.stdout))
        save_nodes(nodes)
    ssh(node, 'mkdir -p "$HOME/fleet" && cat > "$HOME/fleet/roster.json"', json.dumps(roster(), ensure_ascii=False))
    drained = ssh(node, f"{FLEET_BIN} outbox --drain")
    if drained.returncode == 0 and drained.stdout.strip():
        for item in json.loads(drained.stdout):
            item["from"] = item.get("from") or node["name"]
            try:
                create_task(item)
            except ValueError as error:
                log(f"edge {node['name']} task rejected: {error}")
    mine = [p for p in task_files() if read_task(p).get("from", "").split("/")[0] == node["name"]]
    if mine:
        names = [str(p.relative_to(tasks_dir())) for p in mine[:200]]
        archive = subprocess.run(["tar", "-C", str(tasks_dir()), "-cf", "-"] + names, capture_output=True).stdout
        ssh(node, 'mkdir -p "$HOME/fleet/tasks" && tar -C "$HOME/fleet/tasks" -xf -', archive)


def edge_loop():
    while True:
        with lock:
            edges = [n for n in load_nodes().values() if n.get("role") == "edge" and n.get("ssh")]
        for node in edges:
            try:
                sync_edge(node)
            except Exception as error:
                log(f"edge {node['name']} sync failed: {error}")
        time.sleep(EDGE_EVERY)


# ---- http ----------------------------------------------------------------

STATUS_LABELS = {"queued": "排队", "running": "进行中", "blocked": "等审批", "done": "完成", "failed": "失败"}

PAGE = """<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<meta http-equiv=refresh content=30><title>机群</title><style>
body{font:14px/1.5 -apple-system,"PingFang SC",sans-serif;margin:24px auto;max-width:1180px;padding:0 16px;color:#171717}
h2{font-size:15px;margin:28px 0 8px}table{border-collapse:collapse;width:100%}
th,td{text-align:left;padding:7px 10px;border-bottom:1px solid #eee;vertical-align:top}th{color:#666;font-weight:500}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px}.on{background:#16a34a}.off{background:#c9c9c9}
.muted{color:#8f8f8f}.chip{padding:1px 8px;border-radius:999px;background:#f2f2f2;font-size:12px}
.done{background:#edf3ec;color:#2b6e46}.failed{background:#fdebec;color:#a8302b}.running,.blocked{background:#e7f3f8;color:#2b6a8f}
a{color:#2383e2;text-decoration:none}pre{white-space:pre-wrap;background:#fafafa;padding:12px;border-radius:8px}
nav a{margin-right:12px}</style>"""


def render_index(query):
    rows = []
    for n in roster():
        agent = n.get("agent") or {}
        rows.append(
            f"<tr><td><span class='dot {'on' if n['online'] else 'off'}'></span>{html.escape(n['name'])}</td>"
            f"<td>{html.escape(n.get('role', 'node'))}</td><td>{html.escape(format_agent(agent))}</td>"
            f"<td>{html.escape(n.get('via') or '')}</td><td class=muted>{html.escape(', '.join(n.get('ips') or []))}</td>"
            f"<td class=muted>{html.escape(n.get('last_seen_at') or '从未')}</td><td>{n.get('running', '')}</td></tr>")
    tasks = []
    for t in list_tasks(query):
        status = t.get("status", "")
        tasks.append(
            f"<tr><td><a href='/tasks/{t['id']}'>#{t['id']}</a></td><td class=muted>{html.escape(t.get('created', ''))}</td>"
            f"<td>{html.escape(t.get('from', ''))} → <a href='/?to={html.escape(t.get('to', ''))}'>{html.escape(t.get('to', ''))}</a></td>"
            f"<td>{html.escape(t.get('title', ''))}</td><td><a class='chip {status}' href='/?status={status}'>{STATUS_LABELS.get(status, status)}</a></td></tr>")
    filters = " · ".join(f"{k}={v[0]}" for k, v in query.items() if k in ("to", "from", "status"))
    return (PAGE + "<h2>机器</h2><table><tr><th>名字</th><th>角色</th><th>默认 Agent</th><th>连法</th><th>IP</th><th>最近心跳</th><th>在跑</th></tr>"
            + "".join(rows) + "</table>"
            + f"<h2>派活 {('· 筛选 ' + html.escape(filters) + ' <a href=/>清除</a>') if filters else ''}</h2>"
            + "<table><tr><th>编号</th><th>时间</th><th>谁 → 谁</th><th>任务</th><th>状态</th></tr>" + "".join(tasks) + "</table>")


def render_task(task_id):
    path = find_task(task_id)
    if not path:
        return None
    return PAGE + f"<nav><a href='/'>← 机群</a><span class=muted>{html.escape(str(path))}</span></nav><pre>{html.escape(path.read_text())}</pre>"


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def send(self, code, body, kind="application/json"):
        data = body if isinstance(body, bytes) else (json.dumps(body, ensure_ascii=False) if kind == "application/json" else body).encode()
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
        if url.path == "/api/nodes":
            return self.send(200, roster())
        if url.path == "/api/tasks":
            return self.send(200, list_tasks(query))
        match = re.fullmatch(r"/api/tasks/(\d+)", url.path)
        if match:
            path = find_task(match.group(1))
            return self.send(200, read_task(path)) if path else self.send(404, {"error": "没有这个任务"})
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
                with lock:
                    nodes = load_nodes()
                    gone = [k for k, n in nodes.items() if n.get("node_id") == data.get("node_id")]
                    for key in gone:
                        del nodes[key]
                    save_nodes(nodes)
                log(f"left: {gone}")
                return self.send(200, {"removed": gone})
            if path == "/api/edges":
                return self.edge(data)
            if path == "/api/tasks":
                return self.send(201, create_task(data))
            self.send(404, {"error": "not found"})
        except ValueError as error:
            self.send(400, {"error": str(error)})
        except Exception as error:
            self.send(500, {"error": str(error)})

    def join(self, data):
        name = (data.get("name") or "").strip()
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,31}", name):
            raise ValueError("名字只能用字母、数字、点、横线、下划线，最长 32 个字符")
        with lock:
            nodes = load_nodes()
            known = nodes.get(name)
            if known and known.get("node_id") != data.get("node_id"):
                raise ValueError(f"{name} 已经被另一台机器占用，换个名字")
            node = known or {"name": name, "node_id": data.get("node_id") or uuid.uuid4().hex, "role": "node", "joined_at": stamp()}
            nodes[name] = merge_report(node, data.get("info") or {})
            save_nodes(nodes)
        log(f"joined: {name}")
        self.send(200, public_node(nodes[name]) | {"node_id": node["node_id"]})

    def heartbeat(self, data):
        with lock:
            nodes = load_nodes()
            node = next((n for n in nodes.values() if n.get("node_id") == data.get("node_id")), None)
            if not node:
                return self.send(404, {"error": "中心不认识这台机器，重新 fleet join"})
            merge_report(node, data.get("info") or {})
            save_nodes(nodes)
        self.send(200, {"ok": True})

    def edge(self, data):
        name, target = (data.get("name") or "").strip(), (data.get("ssh") or "").strip()
        if not name or not target:
            raise ValueError("name 和 ssh 都要填")
        with lock:
            nodes = load_nodes()
            node = nodes.get(name) or {"name": name, "node_id": uuid.uuid4().hex, "joined_at": stamp()}
            node.update(role="edge", ssh=target)
            nodes[name] = node
            save_nodes(nodes)
        threading.Thread(target=sync_edge, args=(node,), daemon=True).start()
        log(f"edge added: {name} via {target}")
        self.send(200, public_node(node))


class DualStackServer(ThreadingHTTPServer):
    """Listen on IPv4 and IPv6: some machines reach the hub only over one of them."""
    address_family = socket.AF_INET6

    def server_bind(self):
        self.socket.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
        super().server_bind()


def main():
    global SELF_SERVER
    (HOME / "tasks").mkdir(parents=True, exist_ok=True)
    SELF_SERVER = own_server_id()
    resume()
    threading.Thread(target=edge_loop, daemon=True).start()
    log(f"fleet registry on :{PORT}, data in {HOME}, self {SELF_SERVER}")
    DualStackServer(("::", PORT), Handler).serve_forever()


if __name__ == "__main__":
    sys.exit(main())
