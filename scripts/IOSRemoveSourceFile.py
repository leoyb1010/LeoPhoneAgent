#!/usr/bin/env python3
"""从 project.pbxproj 里摘掉某个 Swift 文件的全部登记(IOSAddSourceFile.py 的反操作)。

用法: python3 scripts/IOSRemoveSourceFile.py Foo.swift [Bar.swift ...]
只删除形如 `<ID> /* Foo.swift */` 与 `<ID> /* Foo.swift in Sources */` 的行,不动别的。
"""
import fcntl, os, re, sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
PBX = os.path.join(ROOT, "src/ios/LeoPhoneAgent.xcodeproj/project.pbxproj")

with open(PBX + ".lock", "w") as lock:
    fcntl.flock(lock, fcntl.LOCK_EX)
    lines = open(PBX, encoding="utf-8").read().split("\n")
    for name in sys.argv[1:]:
        pat = re.compile(r"^\s*\w+ /\* %s( in Sources)? \*/" % re.escape(name))
        before = len(lines)
        lines = [l for l in lines if not pat.match(l)]
        print(f"{name}: 移除 {before - len(lines)} 行")
    open(PBX, "w", encoding="utf-8").write("\n".join(lines))
