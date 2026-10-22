#!/usr/bin/env python3
"""第二大脑「每日一页」(mini 上 launchd 每天早上跑一次,只用标准库)。

从资料库网关随机挑一张近 90 天没推过的知识卡,再按它的标题找 2 条相关资料,推一条 ntfy 到手机。
  LEO_BRAIN_KEY_FILE  只读即可的网关 key(默认 ~/.config/leo-brain/leobot-mac.key)
  LEO_BRAIN_URL       默认 http://127.0.0.1:8878(本机,不走隧道)
  LEO_BRAIN_PUBLIC    给手机点的链接前缀,默认 https://wenjian.leoyuan.top
  NTFY_URL / NTFY_TOKEN_FILE  推送通道(与机群巡检同一条)
  --state DIR  记最近推过的卡;--dry-run 只打印不推送
"""
import argparse, json, os, random, sys, time, urllib.parse, urllib.request

OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))
BASE = os.environ.get("LEO_BRAIN_URL", "http://127.0.0.1:8878").rstrip("/")
PUBLIC = os.environ.get("LEO_BRAIN_PUBLIC", "https://wenjian.leoyuan.top").rstrip("/")
REPEAT_DAYS = 90


def key():
    path = os.path.expanduser(os.environ.get("LEO_BRAIN_KEY_FILE", "~/.config/leo-brain/leobot-mac.key"))
    return open(path).read().strip()


def get(path, params=None):
    url = BASE + path + ("?" + urllib.parse.urlencode(params) if params else "")
    req = urllib.request.Request(url, headers={"Authorization": "Bearer " + key(), "User-Agent": "LeoBrainDaily/1.0"})
    return json.loads(OPENER.open(req, timeout=40).read())


DOC_EXT = {"pdf", "docx", "doc", "pptx", "ppt", "xlsx", "xls", "md", "txt", "pages", "key", "numbers"}
BOILERPLATE = ("来源归属", "以下为模型提炼草稿", "非Leo本人经历", "未知项不认作本人经历")


def worth_showing(card):
    """自己写的卡最值得回看;自动提炼的只要文档类(截图、网页、压缩包的提炼读起来没意义)。"""
    if card.get("category") != "资料提炼":
        return True
    ext = card["title"].rsplit(".", 1)[-1].lower() if "." in card["title"] else ""
    return ext in DOC_EXT


def pick_card(shown):
    total = get("/v1/cards", {"limit": 1})["total"]
    pool = []
    # 卡不多(千级),一次翻完;近 REPEAT_DAYS 天推过的跳过,自己写的卡加权
    for offset in range(0, total, 50):
        pool += [c for c in get("/v1/cards", {"offset": offset, "limit": 50})["items"]
                 if c["id"] not in shown and worth_showing(c)]
    if not pool:
        return None
    weights = [10 if c.get("category") != "资料提炼" else 1 for c in pool]
    return random.choices(pool, weights=weights, k=1)[0]


def clean_summary(text):
    lines = [l.strip(" #") for l in (text or "").splitlines()]
    kept = [l for l in lines if l and not any(b in l for b in BOILERPLATE) and not l.startswith("材料分析")]
    return " ".join(kept)[:240]


def related(card):
    source = card["title"].split("·", 1)[-1].strip()
    items = get("/v1/search", {"q": source[:40], "limit": 8, "view": "compact"}).get("items", [])
    # 去掉这张卡自己和它提炼自的那份原件
    return [i for i in items if not str(i.get("ref", "")).endswith(card["id"])
            and i.get("title", "").strip() != source][:2]


def notify(title, body, click):
    url, token_file = os.environ.get("NTFY_URL"), os.environ.get("NTFY_TOKEN_FILE")
    if not url:
        print("NTFY_URL 未设置,不推送", file=sys.stderr)
        return
    req = urllib.request.Request(url, data=body.encode(), method="POST")
    req.add_header("Title", title.encode("utf-8").decode("latin-1"))
    req.add_header("Tags", "brain")
    req.add_header("Click", click)
    if token_file and os.path.isfile(token_file):
        req.add_header("Authorization", "Bearer " + open(token_file).read().strip())
    OPENER.open(req, timeout=10).read()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--state", default=os.path.expanduser("~/Library/Application Support/LeoBot-fleet/brain-daily"))
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    os.makedirs(a.state, mode=0o700, exist_ok=True)
    state_file = os.path.join(a.state, "shown.json")
    try:
        shown = json.load(open(state_file))
    except (OSError, ValueError):
        shown = {}
    cutoff = time.time() - REPEAT_DAYS * 86400
    shown = {k: v for k, v in shown.items() if v >= cutoff}

    card = pick_card(shown)
    if card is None:
        print("没有可推的知识卡")
        return 0
    link = f"{PUBLIC}/#card/{card['id']}"
    lines = [clean_summary(card.get("summary")), "", f"打开:{link}"]
    rel = related(card)
    if rel:
        lines += ["", "相关资料:"] + [f"· {r.get('title', '')[:60]}" for r in rel]
    title = "大脑每日一页 · " + card["title"][:40]
    body = "\n".join(lines).strip()
    print(title + "\n" + body)
    if not a.dry_run:
        notify(title, body, link)
        shown[card["id"]] = time.time()
        json.dump(shown, open(state_file, "w"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
