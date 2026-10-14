#!/usr/bin/env python3
"""IOSAddSourceFile.py 的回归测试:登记行照抄兄弟的写法,文件名按 pbxproj 规则加引号。

运行:python3 scripts/IOSAddSourceFileTests.py
"""
import importlib.util
import os
import unittest

_SPEC = importlib.util.spec_from_file_location(
    "add_source_file", os.path.join(os.path.dirname(os.path.abspath(__file__)), "IOSAddSourceFile.py"))
mod = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(mod)

REF = "\t\t{id} /* {name} */ = {{isa = PBXFileReference; lastKnownFileType = sourcecode.swift; {rest} }};\n"


class CloneRefLineTests(unittest.TestCase):
    def clone(self, sibling, rest, new_name):
        line = REF.format(id="AA1", name=sibling, rest=rest)
        return mod.clone_ref_line(line, "AA1", "NEW", sibling, new_name)

    def test_group_relative_sibling(self):
        out = self.clone("Foo.swift", 'path = Foo.swift; sourceTree = "<group>";', "Bar.swift")
        self.assertEqual(out, REF.format(id="NEW", name="Bar.swift", rest='path = Bar.swift; sourceTree = "<group>";'))

    def test_source_root_sibling_keeps_its_directory(self):
        out = self.clone("Foo.swift", "name = Foo.swift; path = Agent/X/Foo.swift; sourceTree = SOURCE_ROOT;", "New.swift")
        self.assertIn("name = New.swift; path = Agent/X/New.swift; sourceTree = SOURCE_ROOT;", out)

    def test_plus_in_name_is_quoted(self):
        out = self.clone("Foo.swift", 'path = Foo.swift; sourceTree = "<group>";', "AIChatViewModel+Bar.swift")
        self.assertIn('path = "AIChatViewModel+Bar.swift";', out)
        self.assertIn("/* AIChatViewModel+Bar.swift */", out)

    def test_quoted_sibling(self):
        out = self.clone("A+B.swift", 'path = "A+B.swift"; sourceTree = "<group>";', "A+C.swift")
        self.assertIn('path = "A+C.swift";', out)
        self.assertNotIn("A+B", out)

    def test_quote_rules(self):
        self.assertEqual(mod.pbx_quote("Foo-bar_1.swift"), "Foo-bar_1.swift")
        self.assertEqual(mod.pbx_quote("a b.swift"), '"a b.swift"')
        self.assertEqual(mod.pbx_quote("中文.swift"), '"中文.swift"')


if __name__ == "__main__":
    unittest.main()
