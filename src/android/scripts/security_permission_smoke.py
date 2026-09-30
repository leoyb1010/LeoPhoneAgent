#!/usr/bin/env python3
"""Compile the actual permission gate method in a tiny Android-free test fixture.
Native service availability deliberately has no authority in this fixture.
Pass the Kotlin compiler path; no source copies or dependencies are downloaded.
"""
import pathlib
import subprocess
import sys
import tempfile

root = pathlib.Path(__file__).resolve().parents[1]
source = (root / "app/src/main/java/com/leoyuan/leophoneagent/offload/OffloadPermissionManager.kt").read_text()
start = source.index("    suspend fun checkPermission(")
end = source.index("\n    /**", start)
method = source[start:end]
fixture = '''
enum class PermissionLevel { BYPASS, ASK_ONCE, NOT_ALLOWED }
class Fixture(var level: PermissionLevel, var answer: Boolean) {
    var prompts = 0
    val sessionDenials = mutableMapOf<String, MutableSet<String>>()
    val sessionGrants = mutableMapOf<String, MutableSet<String>>()
    fun getLevel(toolName: String) = level
    suspend fun promptForPermission(toolName: String, toolTitle: String, sessionId: String,
      description: String?, singleUseOnly: Boolean): Boolean { prompts++; return answer }
''' + method + '''
}
suspend fun main() {
    var checks = 0
    for (level in PermissionLevel.entries) for (denied in listOf(false,true))
      for (granted in listOf(false,true)) for (answer in listOf(false,true)) {
        val gate = Fixture(level, answer)
        if (denied) gate.sessionDenials["session"] = mutableSetOf("a11y_cli")
        if (granted) gate.sessionGrants["session"] = mutableSetOf("a11y_cli")
        val expected = when(level) {
            PermissionLevel.BYPASS -> true
            PermissionLevel.NOT_ALLOWED -> false
            PermissionLevel.ASK_ONCE -> if (denied) false else if (granted) true else answer
        }
        check(gate.checkPermission("a11y_cli", "accessibility", "session") == expected)
        val asks = level == PermissionLevel.ASK_ONCE && !denied && !granted
        check(gate.prompts == if (asks) 1 else 0)
        checks++
      }
    println("ANDROID_PERMISSION_GATE_OK $checks cases")
}
'''
with tempfile.TemporaryDirectory(prefix="leophone-permission-") as tmp:
    kotlin = pathlib.Path(tmp) / "PermissionGateSmoke.kt"
    artifact = pathlib.Path(tmp) / "test.jar"
    kotlin.write_text(fixture)
    subprocess.run([sys.argv[1], str(kotlin), "-include-runtime", "-d", str(artifact)], check=True)
    subprocess.run(["java", "-jar", str(artifact)], check=True)
