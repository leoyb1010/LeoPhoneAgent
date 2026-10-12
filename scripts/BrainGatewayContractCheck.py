#!/usr/bin/env python3
"""LeoBot ↔ Leo资料库网关 契约巡检(只读,只用标准库)。

按 LeoBot iOS 真实会走的路径请求公网网关,逐个核对 LeoBot 解码要用的字段:
health / search / files / chunks / cards / card / audit,以及 Gemini 证据问答
(/v1/ask → /v1/answers/{id},可选,会真的调用一次模型)。

用法:
  BRAIN_TOKEN=... ./BrainGatewayContractCheck.py [--ask] [--base URL]
  ./BrainGatewayContractCheck.py --token-file ~/.config/leobot-brain-check/token
  ./BrainGatewayContractCheck.py --keychain leo-brain-gateway       # Leo 的 MacBook
巡检模式(mini 上 LaunchAgent 用):
  --monitor STATE_DIR   结果写进 STATE_DIR/last.json;状态由好变坏 / 由坏变好时发 ntfy。
                        --ask-every 小时数控制 Gemini 问答多久查一次(默认 12)。
退出码:0 全部通过,1 有失败。输出不含令牌。
"""
import argparse, json, os, subprocess, sys, time, urllib.error, urllib.parse, urllib.request
from datetime import datetime, timezone

UA = "LeoBrainContractCheck/1.0"   # Cloudflare 会拦没有正常 User-Agent 的请求
SAMPLE_QUERY = "方法"


class Fail(Exception):
    pass


class Gateway:
    def __init__(self, base, token):
        self.base, self.token = base.rstrip("/"), token

    def call(self, path, method="GET", body=None, auth=True, timeout=40):
        req = urllib.request.Request(self.base + path, method=method,
                                     data=json.dumps(body).encode() if body is not None else None)
        req.add_header("User-Agent", UA)
        req.add_header("Accept", "application/json")
        if body is not None:
            req.add_header("Content-Type", "application/json")
        if auth:
            req.add_header("Authorization", "Bearer " + self.token)
        t0 = time.monotonic()
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                status, raw = r.status, r.read()
        except urllib.error.HTTPError as e:
            status, raw = e.code, e.read()
        except Exception as e:
            raise Fail(f"{path} 连不上:{type(e).__name__}: {e}") from None
        ms = int((time.monotonic() - t0) * 1000)
        try:
            data = json.loads(raw) if raw else None
        except ValueError:
            data = None
        return status, data, ms


def need(obj, *keys, where=""):
    for k in keys:
        if not isinstance(obj, dict) or k not in obj:
            raise Fail(f"{where} 缺字段 {k}")


def run(gw, ask=False, ask_timeout=240):
    results = []

    def check(name, fn):
        t0 = time.monotonic()
        try:
            detail = fn() or ""
            results.append({"check": name, "ok": True, "detail": detail, "ms": int((time.monotonic() - t0) * 1000)})
        except Fail as e:
            results.append({"check": name, "ok": False, "detail": str(e), "ms": int((time.monotonic() - t0) * 1000)})
        except Exception as e:  # 契约外的意外也算失败,不让巡检本身崩掉
            results.append({"check": name, "ok": False, "detail": f"{type(e).__name__}: {e}", "ms": 0})

    ctx = {}

    def unauth():
        s, _, _ = gw.call("/v1/health", auth=False)
        if s != 401:
            raise Fail(f"不带令牌应为 401,实际 {s}")

    def health():
        s, d, ms = gw.call("/v1/health")
        if s != 200:
            raise Fail(f"HTTP {s}: {(d or {}).get('error')}")
        need(d, "ok", "archive", "semantic", where="health")
        need(d["archive"], "files", "cards", where="health.archive")
        need(d["semantic"], "ready", where="health.semantic")
        job = d["semantic"].get("job") or {}
        return (f"v{d.get('version')} files={d['archive']['files']} cards={d['archive']['cards']} "
                f"semantic={'ready' if d['semantic']['ready'] else 'off'} pending={d['semantic'].get('pending')}"
                + (f" embed={job.get('state')}" if job else "") + f" {ms}ms")

    def search():
        q = urllib.parse.quote(SAMPLE_QUERY)
        s, d, ms = gw.call(f"/v1/search?q={q}&scope=all&mode=hybrid&limit=5&offset=0&include_private=0")
        if s != 200:
            raise Fail(f"HTTP {s}: {(d or {}).get('error')}")
        need(d, "items", "total", "mode", "semantic_used", where="search")
        if not d["items"]:
            raise Fail("检索「方法」0 条结果")
        for it in d["items"]:
            need(it, "type", "id", "title", "privacy", where="search.item")
            if it["privacy"] not in ("general", "private"):
                raise Fail(f"出现不该出现的密级 {it['privacy']}")
            if it["privacy"] == "private":
                raise Fail("include_private=0 却返回了私密资料")
        ctx["file"] = next((i["id"] for i in d["items"] if i["type"] == "file"), None)
        ctx["card"] = next((i["id"] for i in d["items"] if i["type"] == "card"), None)
        if not ctx["file"]:
            s2, d2, _ = gw.call(f"/v1/search?q={q}&scope=files&mode=hybrid&limit=3&include_private=0")
            ctx["file"] = (d2 or {}).get("items", [{}])[0].get("id") if s2 == 200 and (d2 or {}).get("items") else None
        return f"total={d['total']} mode={d['mode']} semantic_used={d['semantic_used']} {ms}ms"

    def file_and_chunks():
        fid = ctx.get("file")
        if not fid:
            raise Fail("检索没有拿到文件 id,无法核对 files/chunks")
        p = urllib.parse.quote(str(fid), safe="")
        s, d, ms = gw.call(f"/v1/files/{p}")
        if s != 200:
            raise Fail(f"files HTTP {s}")
        need(d, "id", "title", "privacy", "chunk_total", where="files")
        s, d2, ms2 = gw.call(f"/v1/files/{p}/chunks?offset=0&limit=12")
        if s != 200:
            raise Fail(f"chunks HTTP {s}")
        need(d2, "chunks", "total", where="chunks")
        for ch in d2["chunks"]:
            need(ch, "text", where="chunks.item")
        return f"chunks={d2['total']} {ms}+{ms2}ms"

    def cards():
        s, d, ms = gw.call("/v1/cards?offset=0&limit=5")
        if s != 200:
            raise Fail(f"HTTP {s}")
        need(d, "items", "total", where="cards")
        cid = ctx.get("card") or (d["items"][0]["id"] if d["items"] else None)
        if cid:
            s, c, _ = gw.call(f"/v1/cards/{urllib.parse.quote(str(cid), safe='')}")
            if s != 200:
                raise Fail(f"card HTTP {s}")
            need(c, "id", "title", "body", "version", "sources", where="card")
        return f"total={d['total']} {ms}ms"

    def audit():
        s, d, ms = gw.call("/v1/audit?limit=3")
        if s != 200:
            raise Fail(f"HTTP {s}")
        need(d, "items", where="audit")
        return f"{ms}ms"

    def brain_status():
        s, d, ms = gw.call("/v1/brain/status")
        if s != 200:
            raise Fail(f"HTTP {s}")
        need(d, "configured", "model", "health", where="brain/status")
        if not d["configured"]:
            raise Fail("Gemini 未配置")
        state = (d.get("health") or {}).get("state")
        if state == "unavailable":
            raise Fail(f"Gemini 不可用:{d['health'].get('error')}")
        a = d.get("analysis") or {}
        return f"{d['model']} health={state} 提炼 完成{a.get('completed', 0)}/待{a.get('pending', 0)}/阻塞{a.get('blocked', 0)} {ms}ms"

    def gemini_ask():
        s, d, _ = gw.call("/v1/ask", "POST", {"question": "资料库里有哪些关于工作方法的资料？用三句话概括。",
                                              "mode": "answer", "include_private": False})
        if s != 202:
            raise Fail(f"ask HTTP {s}: {(d or {}).get('error')}")
        need(d, "id", where="ask")
        deadline = time.monotonic() + ask_timeout
        while True:
            s, a, _ = gw.call(f"/v1/answers/{d['id']}")
            if s != 200:
                raise Fail(f"answers HTTP {s}")
            need(a, "status", where="answers")
            if a["status"] != "running" or time.monotonic() > deadline:
                break
            time.sleep(5)
        if a["status"] != "completed":
            raise Fail(f"问答 {a['status']}:{a.get('error') or '超时'}")
        r = a.get("result") or {}
        need(r, "answer", "sources", where="answers.result")
        if r.get("model_used") and not r["sources"]:
            raise Fail("模型回答没有来源")
        for src in r["sources"]:
            need(src, "file_id", "locator", where="answers.source")
        return f"model={r.get('model')} sources={len(r['sources'])} answer={len(r['answer'])}字"

    check("未授权拦截", unauth)
    check("health", health)
    check("search", search)
    check("files+chunks", file_and_chunks)
    check("cards", cards)
    check("audit", audit)
    check("brain/status(Gemini)", brain_status)
    if ask:
        check("ask→answers(Gemini)", gemini_ask)
    return results


def keychain_token(service):
    return subprocess.run(["security", "find-generic-password", "-s", service, "-w"],
                          capture_output=True, text=True).stdout.strip()


def notify(title, body):
    url, token_file = os.environ.get("NTFY_URL"), os.environ.get("NTFY_TOKEN_FILE")
    if not url:
        return
    req = urllib.request.Request(url, data=body.encode(), method="POST")
    req.add_header("Title", title.encode("utf-8").decode("latin-1"))
    req.add_header("Tags", "brain,warning")
    if token_file and os.path.isfile(token_file):
        req.add_header("Authorization", "Bearer " + open(token_file).read().strip())
    try:  # 回环请求绝不走代理
        urllib.request.build_opener(urllib.request.ProxyHandler({})).open(req, timeout=8).read()
    except Exception as e:
        print(f"ntfy 发送失败:{e}", file=sys.stderr)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default=os.environ.get("BRAIN_BASE", "https://wenjian.leoyuan.top"))
    ap.add_argument("--token-file")
    ap.add_argument("--keychain")
    ap.add_argument("--ask", action="store_true", help="同时跑一次 Gemini 证据问答(会调用模型)")
    ap.add_argument("--monitor", metavar="STATE_DIR")
    ap.add_argument("--ask-every", type=float, default=12, help="巡检模式下 Gemini 问答的间隔小时数")
    a = ap.parse_args()

    token = os.environ.get("BRAIN_TOKEN", "")
    if a.token_file:
        token = open(os.path.expanduser(a.token_file)).read().strip()
    elif a.keychain:
        token = keychain_token(a.keychain)
    if not token:
        print("没有令牌:设 BRAIN_TOKEN,或用 --token-file / --keychain", file=sys.stderr)
        return 2

    state, prev = None, {}
    if a.monitor:
        state = os.path.expanduser(a.monitor)
        os.makedirs(state, mode=0o700, exist_ok=True)
        try:
            prev = json.load(open(os.path.join(state, "last.json")))
        except (OSError, ValueError):
            prev = {}
        a.ask = a.ask or time.time() - prev.get("last_ask_at", 0) >= a.ask_every * 3600

    results = run(Gateway(a.base, token), ask=a.ask)
    ok = all(r["ok"] for r in results)
    for r in results:
        print(f"{'PASS' if r['ok'] else 'FAIL'}  {r['check']:<22} {r['detail']}")
    print("全部通过" if ok else "有失败")

    if state:
        now = datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")
        asked = next((r for r in results if r["check"].startswith("ask")), None)
        record = {"at": now, "ok": ok, "results": results,
                  "last_ask_at": time.time() if asked and asked["ok"] else prev.get("last_ask_at", 0),
                  "fail_streak": 0 if ok else prev.get("fail_streak", 0) + 1}
        tmp = os.path.join(state, "last.json.tmp")
        with open(tmp, "w") as f:
            json.dump(record, f, ensure_ascii=False, indent=1)
        os.replace(tmp, os.path.join(state, "last.json"))
        with open(os.path.join(state, "history.log"), "a") as f:
            f.write(f"{now} {'OK' if ok else 'FAIL'} " + "; ".join(r["check"] for r in results if not r["ok"]) + "\n")
        was_ok = prev.get("ok", True)
        # 连续两次失败才报警,避开隧道 / 网络的瞬时抖动;恢复时报一次。
        if not ok and record["fail_streak"] == 2:
            notify("LeoBot 资料库连接异常", "\n".join(f"{r['check']}:{r['detail']}" for r in results if not r["ok"]))
        elif ok and not was_ok and prev.get("fail_streak", 0) >= 2:
            notify("LeoBot 资料库连接已恢复", "全部契约检查通过")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
