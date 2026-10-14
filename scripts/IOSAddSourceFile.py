#!/usr/bin/env python3
"""把新建的 Swift 文件登记进 src/ios/LeoPhoneAgent.xcodeproj/project.pbxproj。

主 App target 的源码目录不是 Xcode 的「同步文件夹」(只有 Terminal / MinisTests / MinisUITests 是),
新文件不登记就不会被编译。这里按文本方式照抄「同目录兄弟文件」的登记:
  - 加一条 PBXFileReference,并放进兄弟所在的 PBXGroup
  - 兄弟出现在哪些 target 的 Sources 里,新文件就加进哪些 target(App 和逻辑测试 target 都会跟上)
  - 只改动这几处,不重排整个工程文件,diff 保持很小

用法:
  python3 scripts/IOSAddSourceFile.py src/ios/Agent/Markdown/CodeSyntax/Foo.swift --like MinisMarkdownParser.swift
  (--like 必须是同一个目录里、已经在工程里的文件)

幂等:文件已登记就什么都不做。多个任务并行调用时用文件锁串行,每次都重新读取工程文件。
"""
import argparse
import fcntl
import hashlib
import os
import re
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
PBX = os.path.join(ROOT, "src/ios/LeoPhoneAgent.xcodeproj/project.pbxproj")
LOCK = PBX + ".lock"


def make_id(existing, seed):
    n = 0
    while True:
        h = hashlib.sha1(f"{seed}:{n}".encode()).hexdigest()[:10].upper()
        cand = "LF" + h
        if cand not in existing:
            return cand
        n += 1


# pbxproj 里不加引号也合法的字符;其余(+、空格、中文…)都要加引号。
_PLAIN = re.compile(r"^[A-Za-z0-9_$/:.\-]+$")


def pbx_quote(value):
    if _PLAIN.match(value):
        return value
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def _unquote(value):
    if len(value) >= 2 and value[0] == value[-1] == '"':
        return value[1:-1].replace('\\"', '"').replace("\\\\", "\\")
    return value


def clone_ref_line(sib_line, sib_id, new_id, sibling, new_name):
    """把兄弟的 PBXFileReference 行改成新文件的:id、注释、name、path 的最后一段换成新文件名。"""
    line = sib_line.replace(f"{sib_id} /* {sibling} */", f"{new_id} /* {new_name} */", 1)

    def swap(match):
        key, raw = match.group(1), match.group(2)
        value = _unquote(raw)
        head, _, tail = value.rpartition("/")
        if tail != sibling:
            return match.group(0)
        return f"{key} = {pbx_quote((head + '/' if head else '') + new_name)};"

    line = re.sub(r'\b(path|name) = ("(?:[^"\\]|\\.)*"|[^;]+);', swap, line)
    if new_name not in line.split("*/", 1)[1]:
        sys.exit(f"兄弟文件的登记格式无法识别: {sib_line.strip()}")
    return line


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("path", help="新文件路径(仓库内相对路径或绝对路径)")
    ap.add_argument("--like", required=True, help="同目录里已登记的兄弟文件名,例如 Foo.swift")
    args = ap.parse_args()

    new_abs = os.path.abspath(args.path if os.path.isabs(args.path) else os.path.join(ROOT, args.path))
    if not os.path.isfile(new_abs):
        sys.exit(f"文件不存在: {new_abs}")
    new_name = os.path.basename(new_abs)
    sibling = args.like
    if not os.path.isfile(os.path.join(os.path.dirname(new_abs), sibling)):
        sys.exit(f"--like 文件必须和新文件在同一个目录: {sibling}")

    with open(LOCK, "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        text = open(PBX, encoding="utf-8").read()

        if re.search(r"/\* %s \*/ = \{isa = PBXFileReference" % re.escape(new_name), text):
            print(f"已登记,跳过: {new_name}")
            return

        sib_ref = re.search(
            r"^(\t\t(\w+) /\* %s \*/ = \{isa = PBXFileReference[^\n]*\n)" % re.escape(sibling), text, re.M
        )
        if not sib_ref:
            sys.exit(f"工程里找不到兄弟文件的 PBXFileReference: {sibling}")
        sib_ref_id = sib_ref.group(2)

        all_ids = set(re.findall(r"\b([0-9A-Za-z]{9,24})\b(?= /\*)", text))
        new_ref_id = make_id(all_ids, new_name + ":ref")
        all_ids.add(new_ref_id)

        # 1) PBXFileReference:照抄兄弟那一行,只换 id 和文件名 —— 兄弟用 SOURCE_ROOT 全路径、
        #    或带 name = 登记时,新文件也得照同样的方式写,不能一律写成 <group> 相对的裸文件名。
        ref_line = clone_ref_line(sib_ref.group(1), sib_ref_id, new_ref_id, sibling, new_name)
        text = text.replace(sib_ref.group(1), sib_ref.group(1) + ref_line, 1)

        # 2) 所在的 PBXGroup children:插在兄弟后面
        child_pat = re.compile(r"^(\t+)%s /\* %s \*/,\n" % (re.escape(sib_ref_id), re.escape(sibling)), re.M)
        child_matches = list(child_pat.finditer(text))
        if not child_matches:
            sys.exit(f"没有在任何 PBXGroup 里找到兄弟文件: {sibling}")
        for m in reversed(child_matches):
            ins = f"{m.group(1)}{new_ref_id} /* {new_name} */,\n"
            text = text[: m.end()] + ins + text[m.end():]

        # 3) PBXBuildFile + Sources 阶段:兄弟在哪些 target 的 Sources 里,新文件就加到哪些
        build_pat = re.compile(
            r"^(\t\t(\w+) /\* %s in Sources \*/ = \{isa = PBXBuildFile; fileRef = %s /\* %s \*/;[^\n]*\}\;\n)"
            % (re.escape(sibling), sib_ref_id, re.escape(sibling)),
            re.M,
        )
        build_matches = list(build_pat.finditer(text))
        if not build_matches:
            sys.exit(f"兄弟文件没有 Sources 登记(可能只是资源): {sibling}")
        for m in reversed(build_matches):
            sib_bf = m.group(2)
            new_bf = make_id(all_ids, new_name + ":bf:" + sib_bf)
            all_ids.add(new_bf)
            bf_line = f"\t\t{new_bf} /* {new_name} in Sources */ = {{isa = PBXBuildFile; fileRef = {new_ref_id} /* {new_name} */; }};\n"
            text = text[: m.end()] + bf_line + text[m.end():]
            src_pat = re.compile(r"^(\t+)%s /\* %s in Sources \*/,\n" % (re.escape(sib_bf), re.escape(sibling)), re.M)
            for sm in reversed(list(src_pat.finditer(text))):
                ins = f"{sm.group(1)}{new_bf} /* {new_name} in Sources */,\n"
                text = text[: sm.end()] + ins + text[sm.end():]

        tmp = PBX + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(text)
        os.replace(tmp, PBX)
        print(f"已登记: {new_name}(参照 {sibling},{len(build_matches)} 个 target)")


if __name__ == "__main__":
    main()
