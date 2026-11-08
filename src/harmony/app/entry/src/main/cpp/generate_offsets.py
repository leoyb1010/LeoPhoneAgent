"""Generate gadget offsets with the actual target compiler and ABI."""
from pathlib import Path
import re
import subprocess
import sys

compiler, sysroot, source, sqlite, output = sys.argv[1:]
root = Path(source)
output_directory = Path(output)
command = [
    compiler,
    "--target=aarch64-linux-ohos",
    "--sysroot=" + sysroot,
    "-std=gnu11",
    "-D_GNU_SOURCE",
    "-DGUEST_ARM64=1",
    "-DENGINE_ASBESTOS=1",
    "-I" + source,
    "-I" + sqlite,
    "-I" + str(root / "vdso/arm64"),
    "-include",
    str(root / "tools/staticdefine.h"),
    "-S",
    str(root / "asbestos/offsets.c"),
    "-o",
    str(output_directory / "offsets.s"),
]
subprocess.run(command, check=True)
defines = []
for line in (output_directory / "offsets.s").read_text().splitlines():
    match = re.search(r'\.ascii\s+"->([^ ]+) [#$]?([^ ]+) ', line)
    if match and not match[1].startswith("#"):
        defines.append(f"#define {match[1]} {match[2]}")
if len(defines) < 60:
    raise SystemExit("Incomplete CPU offset generation")
(output_directory / "cpu-offsets.h").write_text("\n".join(defines) + "\n")
