package com.leoyuan.leophoneagent.sandbox

import java.net.URI

enum class CliToolId { CLAUDE, CODEX, GROK, CURSOR }

data class CliToolSpec(
    val id: CliToolId,
    val displayName: String,
    val installerUrl: String,
    val binaryPath: String,
    val versionArgument: String,
    val terminalCommand: String,
    val loginCommand: String,
    val authStatusCommand: String,
    val authHosts: Set<String>,
    val postInstallCommand: String = "",
) {
    val sourceHost: String = URI(installerUrl).host.orEmpty()

    init {
        require(URI(installerUrl).scheme == "https")
        require(sourceHost in CliToolCatalog.OFFICIAL_HOSTS)
        require(binaryPath.startsWith("/root/") && !binaryPath.contains(".."))
        require(authHosts.isNotEmpty() && authHosts.all { it == it.lowercase() && '.' in it })
    }

    fun statusCommand(): String = """
        if [ ! -x '$binaryPath' ]; then exit 127; fi
        output="${'$'}('$binaryPath' $versionArgument 2>&1)" || exit ${'$'}?
        printf '%s\n' "${'$'}output" | head -n 1
    """.trimIndent()

    fun launchCommand(
        model: String?,
        workdir: String? = null,
        extraArguments: List<String> = emptyList(),
    ): String {
        val clean = model?.trim()?.takeIf { it.isNotEmpty() }
        require(clean == null || (clean.length <= 200 && clean.none { it.isISOControl() }))
        require(extraArguments.all { it.length <= 500 && it.none(Char::isISOControl) })
        val suffix = buildList {
            if (clean != null) addAll(listOf("--model", clean))
            addAll(extraArguments)
        }.joinToString(" ") { shellQuote(it) }
        val base = if (suffix.isEmpty()) terminalCommand else "$terminalCommand $suffix"
        val cwd = workdir?.trim()?.takeIf { it.isNotEmpty() } ?: return base
        // [T-cli-workdir] Launch inside a mounted project folder. Only guest
        // paths the sandbox already owns are accepted; anything else (host
        // paths, traversal) is rejected before it can reach the shell line.
        require(cwd.length <= 500 && cwd.none { it.isISOControl() })
        require(!cwd.contains(".."))
        require(cwd == "/root" || cwd.startsWith("/root/") || cwd.startsWith("/var/minis/"))
        return "cd ${shellQuote(cwd)} && $base"
    }

    /**
     * [T-cli-uninstall] Remove the launcher binary only. Login state and user
     * data under HOME survive deliberately, so a re-install restores the tool
     * without a fresh OAuth round trip.
     */
    fun uninstallCommand(): String = """
        rm -f '$binaryPath'
        hash -r 2>/dev/null || true
        test ! -e '$binaryPath'
    """.trimIndent()

    /**
     * All values are catalog constants. No user text is ever interpolated into this shell program.
     * The downloaded installer is capped, HTTPS-only, and confined to the app-private PRoot rootfs.
     */
    fun installCommand(): String = """
        set -eu
        export HOME=/root
        export TMPDIR=/tmp
        export PATH="/root/.local/bin:/root/.grok/bin:${'$'}PATH"
        apk add --no-cache bash curl ca-certificates coreutils git ripgrep tar gzip >/dev/null
        hash -r 2>/dev/null || true
        tmp="${'$'}(mktemp /tmp/leo-cli-installer.XXXXXX)"
        trap 'rm -f "${'$'}tmp"' EXIT
        curl --proto '=https' --proto-redir '=https' --tlsv1.2 \
          --connect-timeout 20 --max-time 300 --max-filesize 2097152 \
          -fsSL '$installerUrl' -o "${'$'}tmp"
        test "${'$'}(wc -c < "${'$'}tmp")" -ge 100
        bash "${'$'}tmp"
        $postInstallCommand
        test -x '$binaryPath'
        output="${'$'}('$binaryPath' $versionArgument 2>&1)" || exit ${'$'}?
        printf '%s\n' "${'$'}output" | head -n 1
    """.trimIndent()
}

internal fun shellQuote(value: String): String = "'${value.replace("'", "'\\''")}'"

object CliToolCatalog {
    internal val OFFICIAL_HOSTS = setOf("claude.ai", "chatgpt.com", "x.ai", "cursor.com")

    val tools = listOf(
        CliToolSpec(
            id = CliToolId.CLAUDE,
            displayName = "Claude Code",
            installerUrl = "https://claude.ai/install.sh",
            binaryPath = "/root/.local/bin/claude",
            versionArgument = "--version",
            terminalCommand = "export PATH=\"/root/.local/bin:/root/.grok/bin:${'$'}PATH\"; claude",
            loginCommand = "export PATH=\"/root/.local/bin:/root/.grok/bin:${'$'}PATH\"; claude auth login",
            authStatusCommand = "timeout 12 claude auth status --text 2>&1",
            authHosts = setOf("claude.ai", "console.anthropic.com", "auth.anthropic.com"),
        ),
        CliToolSpec(
            id = CliToolId.CODEX,
            displayName = "Codex CLI",
            installerUrl = "https://chatgpt.com/codex/install.sh",
            binaryPath = "/root/.local/bin/codex",
            versionArgument = "--version",
            terminalCommand = "export PATH=\"/root/.local/bin:/root/.grok/bin:${'$'}PATH\"; codex",
            loginCommand = "export PATH=\"/root/.local/bin:/root/.grok/bin:${'$'}PATH\"; codex login",
            authStatusCommand = "timeout 12 codex login status 2>&1",
            authHosts = setOf("auth.openai.com", "chatgpt.com"),
        ),
        CliToolSpec(
            id = CliToolId.GROK,
            displayName = "Grok Build",
            installerUrl = "https://x.ai/cli/install.sh",
            binaryPath = "/root/.grok/bin/grok",
            versionArgument = "version",
            terminalCommand = "export PATH=\"/root/.local/bin:/root/.grok/bin:${'$'}PATH\"; grok",
            loginCommand = "export PATH=\"/root/.local/bin:/root/.grok/bin:${'$'}PATH\"; grok login --device-auth",
            authStatusCommand = "test -s /root/.grok/auth.json && printf '%s\\n' 'signed-in'",
            authHosts = setOf("accounts.x.ai", "auth.x.ai", "x.ai"),
        ),
        CliToolSpec(
            id = CliToolId.CURSOR,
            displayName = "Cursor CLI",
            installerUrl = "https://cursor.com/install",
            binaryPath = "/root/.local/bin/agent",
            versionArgument = "--version",
            terminalCommand = "export PATH=\"/root/.local/bin:/root/.grok/bin:${'$'}PATH\"; agent",
            loginCommand = "export PATH=\"/root/.local/bin:/root/.grok/bin:${'$'}PATH\"; unset NO_OPEN_BROWSER; agent login",
            authStatusCommand = "timeout 12 agent status 2>&1",
            authHosts = setOf("cursor.com"),
            postInstallCommand = cursorAlpineCompatibility(),
        ),
    )

    fun get(id: CliToolId): CliToolSpec = tools.first { it.id == id }

    /**
     * [T-cli-status-single-pass] Probe all four CLIs in ONE shell invocation.
     * The previous per-tool loop paid a proot round trip per CLI (4 spawns,
     * serial); this emits one machine-parseable line per tool instead:
     *
     *     ___LEO_CLI___ <id> <exit-code> <first version line>
     *
     * Real exit codes are preserved per tool — a broken binary reports its own
     * code, never a piped-away fake zero (same discipline as statusCommand).
     */
    const val STATUS_MARKER = "___LEO_CLI___"
    const val AUTH_MARKER = "___LEO_CLI_AUTH___"

    fun combinedStatusCommand(): String = buildString {
        appendLine("export PATH=\"/root/.local/bin:/root/.grok/bin:${'$'}PATH\"")
        tools.forEach { tool ->
            appendLine("if [ -x '${tool.binaryPath}' ]; then")
            appendLine("  out=\"${'$'}('${tool.binaryPath}' ${tool.versionArgument} 2>&1)\"; rc=${'$'}?")
            appendLine("  printf '%s %s %s %s\\n' '$STATUS_MARKER' '${tool.id.name}' \"${'$'}rc\" \"${'$'}(printf '%s' \"${'$'}out\" | head -n 1)\"")
            appendLine("else")
            appendLine("  printf '%s %s 127 \\n' '$STATUS_MARKER' '${tool.id.name}'")
            appendLine("fi")
        }
        // Account probes may touch the network. Run them concurrently so a
        // dead provider costs one 12-second ceiling, not four in series.
        tools.forEach { tool ->
            appendLine("(")
            appendLine("  if [ -x '${tool.binaryPath}' ]; then")
            appendLine("    auth_out=\"${'$'}(${tool.authStatusCommand})\"; auth_rc=${'$'}?")
            appendLine("    printf '%s %s %s %s\\n' '$AUTH_MARKER' '${tool.id.name}' \"${'$'}auth_rc\" \"${'$'}(printf '%s' \"${'$'}auth_out\" | head -n 1)\"")
            appendLine("  else")
            appendLine("    printf '%s %s 127 \\n' '$AUTH_MARKER' '${tool.id.name}'")
            appendLine("  fi")
            appendLine(") &")
        }
        appendLine("wait")
        appendLine(":")
    }.trimEnd()

    /** Cursor ships a glibc Node + GNU-only Merkle addon; adapt both to Alpine ARM64. */
    private fun cursorAlpineCompatibility(): String = """
        apk add --no-cache gcompat libstdc++ nodejs >/dev/null
        apk del .leo-cursor-build >/dev/null 2>&1 || true
        (
          set -eu
          trap 'apk del .leo-cursor-build >/dev/null 2>&1 || true' EXIT
          apk add --no-cache --virtual .leo-cursor-build npm python3 make g++ linux-headers >/dev/null
          cursor_dir="${'$'}(dirname "${'$'}(readlink -f /root/.local/bin/agent)")"
          if [ ! -L "${'$'}cursor_dir/node" ]; then
            rm -f "${'$'}cursor_dir/node.glibc"
            mv "${'$'}cursor_dir/node" "${'$'}cursor_dir/node.glibc"
            ln -s /usr/bin/node "${'$'}cursor_dir/node"
          fi

          addon=/tmp/node-addon-api-8.9.2.tgz
          curl --proto '=https' --proto-redir '=https' --tlsv1.2 \
            --connect-timeout 20 --max-time 180 --max-filesize 2097152 \
            -fsSL 'https://registry.npmjs.org/node-addon-api/-/node-addon-api-8.9.2.tgz' -o "${'$'}addon"
          echo '5628cb5db8b750008debd2342555c9b17e2d8c00a336840382fda04c5eacc76c16122f2d912836797f29e60488162f33dbe0cbde81e663a3b229c7b7f120e896  /tmp/node-addon-api-8.9.2.tgz' | sha512sum -c -
          rm -rf "${'$'}cursor_dir/node_modules/node-addon-api"
          mkdir -p "${'$'}cursor_dir/node_modules/node-addon-api"
          tar -xzf "${'$'}addon" --strip-components=1 -C "${'$'}cursor_dir/node_modules/node-addon-api"
          (cd "${'$'}cursor_dir" && npm rebuild --build-from-source)

          mkdir -p /root/.local/lib
          printf '%s\n' \
            '#define _GNU_SOURCE' '#include <fcntl.h>' '#include <stdarg.h>' \
            '#include <sys/syscall.h>' '#include <unistd.h>' \
            'int fcntl64(int fd, int cmd, ...) { long arg = 0; switch (cmd) { case F_GETFD: case F_GETFL: case F_GETOWN: case F_GETSIG: case F_GETLEASE: break; default: { va_list ap; va_start(ap, cmd); arg = va_arg(ap, long); va_end(ap); } } return (int)syscall(SYS_fcntl, fd, cmd, arg); }' \
            'const char *gnu_get_libc_version(void) { return "2.35"; }' \
            > /tmp/leo-cursor-glibc-shim.c
          gcc -shared -fPIC -O2 /tmp/leo-cursor-glibc-shim.c -o /root/.local/lib/libleo-cursor-glibc.so

          python3 -c 'import base64,sys; path=sys.argv[1]; p=open(path,"rb").read(); old=base64.b64decode("dT1zKCk/bihPYmplY3QoZnVuY3Rpb24oKXt2YXIgZT1uZXcgRXJyb3IoIkNhbm5vdCBmaW5kIG1vZHVsZSAnLi9tZXJrbGUtdHJlZS1uYXBpLmxpbnV4LWFybTY0LW11c2wubm9kZSciKTt0aHJvdyBlLmNvZGU9Ik1PRFVMRV9OT1RfRk9VTkQiLGV9KCkpKTpuKCIuLi9tZXJrbGUtdHJlZS9tZXJrbGUtdHJlZS1uYXBpLmxpbnV4LWFybTY0LWdudS5ub2RlIik="); new=base64.b64decode("dT1uKCIuLi9tZXJrbGUtdHJlZS9tZXJrbGUtdHJlZS1uYXBpLmxpbnV4LWFybTY0LWdudS5ub2RlIik="); assert p.count(old)+p.count(new)==1,(p.count(old),p.count(new)); open(path,"wb").write(p.replace(old,new))' "${'$'}cursor_dir/index.js"
          grep -Fq 'libleo-cursor-glibc.so' "${'$'}cursor_dir/cursor-agent" || \
            sed -i '3i export LD_PRELOAD=/root/.local/lib/libleo-cursor-glibc.so' "${'$'}cursor_dir/cursor-agent"
          rm -rf /root/.cache/cursor-compile-cache
        )
    """.trimIndent()
}

/** Detects only official HTTPS authorization URLs during catalog login flows. */
object CliAuthLinkDetector {
    private val URL = Regex("""https://[^\s\u0007\u001B]+""")

    fun firstAllowed(text: String, allowedHosts: Set<String>): String? =
        URL.findAll(text).map { it.value.trimEnd('.', ',', ')', ']', '"', '\'') }.firstOrNull { candidate ->
            runCatching {
                val uri = URI(candidate)
                uri.scheme == "https" && uri.host?.lowercase() in allowedHosts &&
                    uri.userInfo == null && uri.fragment == null
            }.getOrDefault(false)
        }
}
