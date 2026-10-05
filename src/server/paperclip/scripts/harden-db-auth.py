#!/usr/bin/env python3
"""Paperclip 数据库口令轮换与库级口令认证（在服务器上运行，服务用户）。

  python3 harden-db-auth.py --root <部署根> rotate   # 轮换口令并更新 env/config（trust 期间无影响）
  python3 harden-db-auth.py --root <部署根> enforce  # 仅为本项目库加 scram-sha-256 规则并 reload
  python3 harden-db-auth.py --root <部署根> verify   # 新口令可连、无口令被拒、其他库不受影响

只向数据库发送 SCRAM-SHA-256 校验值，明文口令不出现在 SQL、进程参数或输出中。
共享集群中其他数据库的认证规则保持不变。
"""
import argparse
import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import subprocess
import sys
import time
from pathlib import Path
from urllib.parse import urlparse, urlunparse

PSQL = "/opt/homebrew/bin/psql"
DB = "leophone_paperclip"
ROLE = "leophone_paperclip"
MARK = "# leophone_paperclip: scram-sha-256 only (audit hardening)"
RULES = [
    MARK,
    f"local   {DB}  all                     scram-sha-256",
    f"host    {DB}  all     127.0.0.1/32    scram-sha-256",
    f"host    {DB}  all     ::1/128         scram-sha-256",
]


def scram_verifier(password, iterations=4096):
    salt = secrets.token_bytes(16)
    salted = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, iterations)
    client_key = hmac.new(salted, b"Client Key", hashlib.sha256).digest()
    stored_key = hashlib.sha256(client_key).digest()
    server_key = hmac.new(salted, b"Server Key", hashlib.sha256).digest()
    b64 = lambda b: base64.b64encode(b).decode()
    return f"SCRAM-SHA-256${iterations}:{b64(salt)}${b64(stored_key)}:{b64(server_key)}"


def superuser_sql(sql):
    # 超级用户经 postgres 库连接（该库规则保持不变）。SQL 经 stdin 传入，不出现在进程参数中。
    return subprocess.run([PSQL, "-h", "127.0.0.1", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-Atq"],
                          input=sql, text=True, capture_output=True, check=True).stdout.strip()


def atomic_write(path, text):
    tmp = path.with_name(path.name + ".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(text)
    os.replace(tmp, path)
    path.chmod(0o600)


def replace_password(url, new):
    u = urlparse(url)
    if u.username != ROLE:
        raise SystemExit("unexpected database role in connection string")
    netloc = f"{u.username}:{new}@{u.hostname}" + (f":{u.port}" if u.port else "")
    return urlunparse(u._replace(netloc=netloc))


def evidence_dir(root):
    d = root / "backups/db-auth" / time.strftime("%Y%m%d-%H%M%S")
    d.mkdir(mode=0o700, parents=True)
    return d


def rotate(root):
    env_file = root / "env/server.env"
    cfg_file = root / "data/instances/default/config.json"
    ev = evidence_dir(root)
    for f in (env_file, cfg_file):
        atomic_write(ev / (f.name + ".before"), f.read_text())
    new = secrets.token_urlsafe(32)  # URL 安全字符，无需转义
    cfg = json.loads(cfg_file.read_text())
    cfg["database"]["connectionString"] = replace_password(cfg["database"]["connectionString"], new)
    env_text = env_file.read_text()
    pat = re.compile(r"^(export DATABASE_URL=)(['\"]?)(.+?)\2$", re.M)
    m = pat.search(env_text)
    if not m:
        raise SystemExit("DATABASE_URL not found in server.env")
    env_text = pat.sub(lambda mm: mm.group(1) + mm.group(2) + replace_password(mm.group(3), new) + mm.group(2), env_text, count=1)
    superuser_sql(f"ALTER ROLE {ROLE} PASSWORD '{scram_verifier(new)}';")
    atomic_write(cfg_file, json.dumps(cfg, indent=2) + "\n")
    atomic_write(env_file, env_text)
    print(f"rotated; before-copies in {ev.name}; restart the service to use the new password")


def hba_path():
    return Path(superuser_sql("SHOW hba_file;"))


def enforce(root):
    hba = hba_path()
    text = hba.read_text()
    if MARK in text:
        print("rules already present")
    else:
        ev = evidence_dir(root)
        atomic_write(ev / "pg_hba.conf.before", text)
        lines = text.splitlines()
        first_rule = next(i for i, l in enumerate(lines) if l.strip() and not l.lstrip().startswith("#"))
        lines[first_rule:first_rule] = RULES + [""]
        atomic_write(hba, "\n".join(lines) + "\n")
        print(f"pg_hba updated; backup in {ev.name}")
    errors = superuser_sql("SELECT count(*) FROM pg_hba_file_rules WHERE error IS NOT NULL;")
    if errors != "0":
        raise SystemExit("pg_hba has errors; not reloading")
    superuser_sql("SELECT pg_reload_conf();")
    print("reloaded")


def verify(root):
    cfg = json.loads((root / "data/instances/default/config.json").read_text())
    u = urlparse(cfg["database"]["connectionString"])
    env = dict(os.environ, PGPASSWORD=u.password or "")
    ok = subprocess.run([PSQL, "-h", "127.0.0.1", "-U", ROLE, "-d", DB, "-w", "-Atc", "select 1"],
                        env=env, capture_output=True, text=True)
    no_pw_env = {k: v for k, v in os.environ.items() if k != "PGPASSWORD"}
    denied = subprocess.run([PSQL, "-h", "127.0.0.1", "-U", ROLE, "-d", DB, "-w", "-Atc", "select 1"],
                            env=no_pw_env, capture_output=True, text=True)
    superuser_denied = subprocess.run([PSQL, "-h", "127.0.0.1", "-d", DB, "-w", "-Atc", "select 1"],
                                      env=no_pw_env, capture_output=True, text=True)
    other = superuser_sql("SELECT count(*) FROM pg_database WHERE datname='postgres';")
    result = {
        "newPasswordConnects": ok.returncode == 0 and ok.stdout.strip() == "1",
        "roleWithoutPasswordDenied": denied.returncode != 0,
        "superuserWithoutPasswordDenied": superuser_denied.returncode != 0,
        "otherDatabasesStillReachable": other == "1",
    }
    print(json.dumps(result, indent=2))
    if not all(result.values()):
        sys.exit(1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", required=True, type=Path)
    ap.add_argument("action", choices=["rotate", "enforce", "verify"])
    a = ap.parse_args()
    {"rotate": rotate, "enforce": enforce, "verify": verify}[a.action](a.root.resolve())


if __name__ == "__main__":
    main()
