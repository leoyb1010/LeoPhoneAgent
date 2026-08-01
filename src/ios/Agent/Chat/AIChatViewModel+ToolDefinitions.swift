import Foundation

// MARK: - Tool Definitions (Canonical)

extension AIChatViewModel {

    // MARK: - Tool Definitions (Canonical)

    func makeAgentTools() -> [AgentToolDefinition] {
        // [T-memory-toggle-gates-injection-and-tools-ios] memory_get and
        // memory_write are conditionally registered. When the per-session
        // toggle is off, drop both tool definitions so the LLM never sees
        // them. The system prompt also switches to a "memory disabled"
        // wording (see baseSystemPrompt below) so the model can correctly
        // tell the user to re-enable memory via /memory or Settings.
        let includeMemoryTools = memoryEnabled
        var tools: [AgentToolDefinition] = [
            AgentToolDefinition(
                name: "shell_execute",
                description: "Execute a command in an isolated Linux process (iSH/Alpine Linux). The command runs via /bin/sh -c with stdout and stderr captured separately via pipes. Each invocation spawns a fresh process — there is no shared terminal session. Default timeout is 15 minutes.",
                parameters: [
                    "tool_title": AgentToolParam(type: .string, description: "A concise 5-10 word summary of what this tool call does, shown to the user (e.g. 'Install Python data analysis packages', 'List files in home directory'). Use the same language as the user."),
                    "command": AgentToolParam(type: .string, description: "The shell command to execute. Supports multi-line commands directly — no special escaping needed. Keep under 1000 chars; for longer scripts, write to a file with file_write first, then run it. If a command GENERATES an image or chart for the user (matplotlib, ImageMagick, screenshots…), save it under /var/minis/workspace/ and then call read_image on it so the user actually SEES it in the chat — never just claim it was generated."),
                    "timeout": AgentToolParam(type: .integer, description: "Timeout in seconds (default: 900). Use a larger value for long-running commands like package installs."),
                    "delay": AgentToolParam(type: .integer, description: "Delay in seconds before execution begins. The tool blocks the agent flow during this wait WITHOUT occupying the iSH shell, so other concurrent tasks can use it. Use this instead of sleep commands to avoid resource contention."),
                ],
                required: ["tool_title", "command"],
                propertyOrdering: ["tool_title", "command", "timeout", "delay"]
            ),
            AgentToolDefinition(
                name: "file_read",
                description: "Read a file from the Linux filesystem. Faster than shell_execute for reading files — no shell overhead. Returns file content with metadata. Rejects binary files.",
                parameters: [
                    "tool_title": AgentToolParam(type: .string, description: "A concise 5-10 word summary of what this tool call does, shown to the user (e.g. 'Read Python script contents', 'Check system configuration file'). Use the same language as the user."),
                    "path": AgentToolParam(type: .string, description: "Absolute Linux path to read (e.g. /var/minis/workspace/data.csv)"),
                    "offset": AgentToolParam(type: .integer, description: "1-based line number to start reading from (default: 1). Ignored when direction is 'tail'."),
                    "lines": AgentToolParam(type: .integer, description: "Maximum number of lines to return (default: all lines up to max_length)"),
                    "max_length": AgentToolParam(type: .integer, description: "Maximum character length of returned content (default: 15000)"),
                    "direction": AgentToolParam(type: .string, description: "Read direction: 'head' (from start, default) or 'tail' (from end of file)"),
                ],
                required: ["tool_title", "path"],
                propertyOrdering: ["tool_title", "path", "offset", "lines", "direction", "max_length"]
            ),
            AgentToolDefinition(
                name: "file_write",
                description: "Write content to a file on the Linux filesystem. Faster than shell_execute for writing files. Creates the file if it doesn't exist. Use append mode to add to existing files. Image files (png/jpg/gif/webp) you write are shown to the user inline in the chat automatically and land in the artifact tray — prefer /var/minis/workspace/ for anything the user should keep.",
                parameters: [
                    "tool_title": AgentToolParam(type: .string, description: "A concise 5-10 word summary of what this tool call does, shown to the user (e.g. 'Create Python statistics script', 'Write configuration file'). Use the same language as the user."),
                    "path": AgentToolParam(type: .string, description: "Absolute Linux path to write (e.g. /root/test.txt)"),
                    "content": AgentToolParam(type: .string, description: "The text content to write to the file"),
                    "append": AgentToolParam(type: .boolean, description: "If true, append to existing file instead of overwriting (default: false)"),
                    "create_dirs": AgentToolParam(type: .boolean, description: "If true, create parent directories if they don't exist (default: false)"),
                ],
                required: ["tool_title", "path", "content"],
                propertyOrdering: ["tool_title", "path", "content", "append", "create_dirs"]
            ),
            AgentToolDefinition(
                name: "file_edit",
                description: "Make targeted edits to an existing file using exact string replacement. ALWAYS use file_read first to see the current file contents before editing. Prefer file_edit over file_write when modifying existing files — only the changed part needs to be specified. The old_string must match exactly one location in the file (including whitespace/indentation), unless replace_all is true.",
                parameters: [
                    "tool_title": AgentToolParam(type: .string, description: "A concise 5-10 word summary of what this tool call does, shown to the user (e.g. 'Fix typo in Python script', 'Update config value'). Use the same language as the user."),
                    "path": AgentToolParam(type: .string, description: "Absolute Linux path to the file to edit (e.g. /root/script.py)"),
                    "old_string": AgentToolParam(type: .string, description: "The exact text to find in the file. Must match precisely including whitespace and indentation. Must be unique in the file unless replace_all is true."),
                    "new_string": AgentToolParam(type: .string, description: "The replacement text. Use empty string to delete old_string."),
                    "replace_all": AgentToolParam(type: .boolean, description: "If true, replace ALL occurrences of old_string (default: false)"),
                ],
                required: ["tool_title", "path", "old_string", "new_string"],
                propertyOrdering: ["tool_title", "path", "old_string", "new_string", "replace_all"]
            ),
            AgentToolDefinition(
                name: "browser_use",
                description: "Control a web browser with up to 3 tabs. Do NOT use this tool for leophoneagent:// action URLs (open_terminal, views, settings) — those are app deep links, use Markdown links in chat instead. The browser supports both web URLs and leophoneagent:// resource URLs. Use leophoneagent:// URLs to preview session files (e.g. navigate to leophoneagent://workspace/index.html). Sub-resources (JS, CSS, images, fonts) referenced via leophoneagent:// absolute paths or relative paths within HTML pages resolve correctly. Use navigate to open URLs, screenshot to see the page (returns an image), click/type to interact with elements, get_text/get_readable to extract content, scroll to navigate long pages, scroll_and_collect to scroll through infinite-scroll/virtual-rendered pages (like Twitter/X timelines) and accumulate unique content items across scroll positions in a single call, find_elements to discover interactive elements, get_page_info for page metadata, get_backbone to get a structural overview of the page DOM as a simplified tree, get_accessibility_tree to get the page as the accessibility tree assistive technology sees (role + accessible name + state + a selector per node) — prefer this over screenshot when you need to understand or interact with a page rather than look at it: it is deterministic, far cheaper in tokens than an image, and every node reports a selector you can pass straight to click/type (use max_depth to cap node count, default 200), fetch to download files/resources using the page's session (returns metadata and a leophoneagent:// URL), new_tab to open an additional tab, close_tab to close a tab, and list_tabs to see all open tabs. Use set_viewport with viewport_width + viewport_height to override the viewport for the current session (e.g. before screenshotting a 1920×1080 HTML composition that would otherwise be cropped to the phone viewport); pass reset=true to drop the session override and fall back to the global browser setting. Use get_cookies to retrieve cookies for the current page URL / current site root domain only (including HttpOnly cookies). get_cookies supports optional 'keyword' (filter by cookie name) and 'fuzzy' (true=contains match, false=exact match, default true). It returns only a summary and an offload env file path — raw cookie values are NOT included in the tool response. To reuse cookies in shell commands: `. /var/minis/offloads/env_cookies_xxx.sh && command`. You may define alias variables when needed. Use set_cookies to write cookies into the current page's cookie store via the native cookie store (so even HttpOnly cookies, which JS cannot set, land). Pass a 'cookies' array of objects, each with name + value (required) and optional domain (defaults to the current page host), path (defaults to '/'), secure, http_only, and expires (Unix timestamp in seconds; omit for a session cookie). Use wait_for_dom_stable to wait until the page DOM stops changing (useful after navigation or interactions that trigger async data loading — polls every 0.5s, resolves when mutation rate gradient is stable for 3+ intervals, default timeout 10s). Use tab_id to target a specific tab (defaults to the most recently used tab).",
                parameters: [
                    "tool_title": AgentToolParam(type: .string, description: "A concise 5-10 word summary of what this tool call does, shown to the user (e.g. 'Open Wikipedia homepage', 'Take screenshot of current page'). Use the same language as the user."),
                    "action": AgentToolParam(type: .string, description: "The browser action to perform", enumValues: BrowserAction.allCases.map(\.rawValue)),
                    "url": AgentToolParam(type: .string, description: "URL to navigate to (for navigate action) or resource to download (for fetch action)"),
                    "selector": AgentToolParam(type: .string, description: "CSS selector for targeting elements (click, type, get_text, scroll, hover, find_elements). For scroll: specify a scrollable container to scroll (e.g. 'div.timeline'); if omitted, auto-detects the best scrollable element."),
                    "text": AgentToolParam(type: .string, description: "Text to type (for type action)"),
                    "coordinate_x": AgentToolParam(type: .integer, description: "X coordinate for click (alternative to selector)"),
                    "coordinate_y": AgentToolParam(type: .integer, description: "Y coordinate for click (alternative to selector)"),
                    "direction": AgentToolParam(type: .string, description: "Scroll direction", enumValues: ["up", "down"]),
                    "amount": AgentToolParam(type: .integer, description: "Scroll amount in pixels (default: 500)"),
                    "script": AgentToolParam(type: .string, description: "JavaScript code to execute (for execute_js action). The script runs inside an async function wrapper — `await` and top-level `return` are both supported (e.g. `var r = await fetch(url); return await r.json()`)."),
                    "user_agent": AgentToolParam(type: .string, description: "User agent profile to switch to", enumValues: ["desktop_safari", "mobile_safari"]),
                    "max_depth": AgentToolParam(type: .integer, description: "Maximum tree depth for get_backbone (default: 5)"),
                    "scroll_count": AgentToolParam(type: .integer, description: "Number of scroll steps for scroll_and_collect (default: 10, max: 20). Each step scrolls by 'amount' pixels and waits for new content."),
                    "item_selector": AgentToolParam(type: .string, description: "CSS selector for individual content items in scroll_and_collect (e.g. 'article', '[data-testid=\"tweet\"]'). If omitted, auto-detects repeated elements."),
                    "tab_id": AgentToolParam(type: .integer, description: "Target tab ID (optional, defaults to most recently used tab). Use list_tabs to see available tabs."),
                    "keywords": AgentToolParam(type: .string, description: "Filter cookies by name (for get_cookies). A space-separated string or array of strings. With fuzzy=true (default), ALL keywords must appear in the cookie name (case-insensitive). With fuzzy=false, cookie name must exactly equal any one of the provided keywords (case-insensitive). Omit to return all cookies for the current site."),
                    "fuzzy": AgentToolParam(type: .boolean, description: "Whether keyword matching is fuzzy (contains-all) or exact-any (for get_cookies, default: true)."),
                    "cookies": AgentToolParam(type: .string, description: "For set_cookies: a JSON array of cookie objects to write. Pass it as a JSON array (a JSON-encoded string of the array is also accepted). Each object: {\"name\": str (required), \"value\": str (required), \"domain\": str (optional, defaults to current page host), \"path\": str (optional, defaults to \"/\"), \"secure\": bool (optional), \"http_only\": bool (optional — sets an HttpOnly cookie that JS cannot read/set), \"expires\": int (optional, Unix timestamp in seconds; omit for a session cookie)}. Field-name variants from common cookie exports are accepted: httpOnly (=http_only), expirationDate (=expires), sameSite, and case/camel variants — so you can paste cookies verbatim from browser extensions (EditThisCookie / Cookie-Editor) or Playwright/Puppeteer storage."),
                    "timeout": AgentToolParam(type: .integer, description: "Timeout in seconds for wait_for_dom_stable (default: 10). The action polls every 0.5s and resolves when DOM mutation rate stabilizes."),
                    "viewport_width": AgentToolParam(type: .integer, description: "Viewport width in CSS pixels for set_viewport (e.g. 1920). Required together with viewport_height unless reset=true."),
                    "viewport_height": AgentToolParam(type: .integer, description: "Viewport height in CSS pixels for set_viewport (e.g. 1080). Required together with viewport_width unless reset=true."),
                    "reset": AgentToolParam(type: .boolean, description: "For set_viewport: when true, clear the session-level viewport override and fall back to the global browser setting."),
                    "full_page": AgentToolParam(type: .boolean, description: "For screenshot: capture the entire scrollable page by temporarily resizing the WebView to document.documentElement.scrollHeight. Default false captures viewport only. Capped at 32768px tall; when capped, result text includes 'Truncated: true' and the original height."),
                ],
                required: ["tool_title", "action"],
                propertyOrdering: ["tool_title", "action", "tab_id", "url", "selector", "text", "coordinate_x", "coordinate_y", "direction", "amount", "scroll_count", "item_selector", "script", "user_agent", "max_depth", "keywords", "fuzzy", "cookies", "timeout", "viewport_width", "viewport_height", "reset", "full_page"]
            ),
        ]

        if includeMemoryTools {
            tools.append(AgentToolDefinition(
                name: "memory_write",
                description: "Write a memory entry to today's daily log (YYYY-MM-DD.md). Memories persist across all sessions. Each entry is prepended with a timestamp. Save: user preferences, recurring patterns, key facts, project conventions, reusable knowledge. When the USER CORRECTS your behaviour ('不要…', 'I told you…', 'next time do X instead'), set kind='correction' — corrections never expire and are always injected with top priority. Avoid saving passwords, API keys, tokens, or secrets unless the user explicitly confirms after being warned. Keep entries concise and general-purpose. GLOBAL.md is read-only (user-maintained via Settings).",
                parameters: [
                    "tool_title": AgentToolParam(type: .string, description: "A concise 5-10 word summary of what this tool call does, shown to the user (e.g. 'Save user preference for Python', 'Note today's project context'). Use the same language as the user."),
                    "content": AgentToolParam(type: .string, description: "The memory content to write. Use concise Markdown with a short heading (## Topic) and context about what was done/learned. For kind='correction', one plain sentence stating the rule."),
                    "kind": AgentToolParam(type: .string, description: "Entry kind: 'note' (default, daily log) or 'correction' (permanent, highest-priority — use when the user corrects you).", enumValues: ["note", "correction"]),
                ],
                required: ["tool_title", "content"],
                propertyOrdering: ["tool_title", "content", "kind"]
            ))
            tools.append(AgentToolDefinition(
                name: "memory_get",
                description: "Retrieve memories from persistent storage. Supports keyword-based fuzzy search across memory files. Returns matching lines with surrounding context. Use this to recall previous knowledge, user preferences, or past notes.",
                parameters: [
                    "tool_title": AgentToolParam(type: .string, description: "A concise 5-10 word summary of what this tool call does, shown to the user (e.g. 'Recall user preferences', 'Search past notes'). Use the same language as the user."),
                    "scope": AgentToolParam(type: .string, description: "Memory scope to search: 'daily' for daily logs only, 'all' for daily logs + GLOBAL.md.", enumValues: ["daily", "all"]),
                    "keywords": AgentToolParam(type: .string, description: "Space-separated keywords for fuzzy matching (e.g. 'python preference' or 'API key setup'). All keywords must appear in a line or its surrounding context for a match. Leave empty to return full memory files."),
                ],
                required: ["tool_title"],
                propertyOrdering: ["tool_title", "scope", "keywords"]
            ))
        }

        // Only include read_image when the model supports image input
        if selectedModel.capabilities.supportedModalities.contains(.imageInput) {
            tools.append(AgentToolDefinition(
                name: "read_image",
                description: "Read an image file from the Linux filesystem and return it for visual analysis. Supports PNG, JPEG, GIF, WEBP, and other common image formats. Use this to inspect generated charts, downloaded images, screenshots, or any visual output. The image is returned directly for your analysis along with metadata (dimensions, file size).",
                parameters: [
                    "tool_title": AgentToolParam(type: .string, description: "A concise 5-10 word summary of what this tool call does, shown to the user (e.g. 'View generated bar chart', 'Inspect downloaded screenshot'). Use the same language as the user."),
                    "path": AgentToolParam(type: .string, description: "Linux path (e.g. /var/minis/attachments/chart.png) or leophoneagent:// URL (e.g. leophoneagent://attachments/chart.png)"),
                ],
                required: ["tool_title", "path"],
                propertyOrdering: ["tool_title", "path"]
            ))
        }

        // [T-remote-exec] Remote tools exist ONLY when a host is configured —
        // zero hosts means the tool list, prompt bytes and cache prefix are
        // exactly what they were before this feature.
        let remoteHosts = RemoteHostStore.configuredHosts()
        if !remoteHosts.isEmpty {
            let hostList = remoteHosts.map { "'\($0.name)'" }.joined(separator: ", ")
            tools.append(AgentToolDefinition(
                name: "remote_shell",
                description: "Run a shell command on a remote computer over SSH. Use for heavy work the on-device sandbox is too slow for: big repos, compiles, long scripts, tools only installed there. Configured hosts: \(hostList). Non-interactive; output capped at 20000 chars; PATH may be minimal (use absolute paths or 'zsh -lc'). The remote process is NOT killed on timeout.",
                parameters: [
                    "tool_title": AgentToolParam(type: .string, description: "A concise 5-10 word summary shown to the user. Use the same language as the user."),
                    "host": AgentToolParam(type: .string, description: "Name of the configured host to run on, e.g. \(hostList)."),
                    "command": AgentToolParam(type: .string, description: "The shell command to execute remotely."),
                    "timeout": AgentToolParam(type: .integer, description: "Seconds to wait before giving up (default 120, max 600)."),
                ],
                required: ["tool_title", "host", "command"],
                propertyOrdering: ["tool_title", "host", "command", "timeout"]
            ))
            tools.append(AgentToolDefinition(
                name: "remote_agent",
                description: "Delegate a whole task to Claude Code running on a remote computer (it must have the 'claude' CLI installed and authenticated). Runs 'claude -p' non-interactively in the given directory and returns its final answer. Use for repo-scale coding tasks; prefer remote_shell for single commands. Configured hosts: \(hostList).",
                parameters: [
                    "tool_title": AgentToolParam(type: .string, description: "A concise 5-10 word summary shown to the user. Use the same language as the user."),
                    "host": AgentToolParam(type: .string, description: "Name of the configured host, e.g. \(hostList)."),
                    "prompt": AgentToolParam(type: .string, description: "The task for the remote Claude Code, fully self-contained."),
                    "workdir": AgentToolParam(type: .string, description: "Absolute directory on the remote machine to run in (default: the user's home)."),
                    "timeout": AgentToolParam(type: .integer, description: "Seconds to wait (default 300, max 600)."),
                ],
                required: ["tool_title", "host", "prompt"],
                propertyOrdering: ["tool_title", "host", "prompt", "workdir", "timeout"]
            ))
        }

        // [T-image-gen] Thin wrapper over the EXISTING minis-model-use image
        // pipeline (Codex-subscription OAuth routing, Images API, endpoint
        // auto-probe all live there). Registered when any enabled
        // OpenAI-family instance exists — key or subscription.
        let hasImageProvider = ProviderConfigStore.shared.instances.contains {
            $0.isEnabled && ($0.providerType == .openAI || $0.providerType == .openRouter)
        }
        if hasImageProvider {
            tools.append(AgentToolDefinition(
                name: "generate_image",
                description: "Generate an image from a text prompt with gpt-image-2 (rides the user's OpenAI subscription or API key automatically). The image is saved to /var/minis/workspace/, appears INLINE in the chat automatically and lands in the artifact tray — do not additionally read_image it. Costs real money/quota: one call per user request, no unrequested retries. Requires the sandbox kernel (same as shell).",
                parameters: [
                    "tool_title": AgentToolParam(type: .string, description: "A concise 5-10 word summary shown to the user. Use the same language as the user."),
                    "prompt": AgentToolParam(type: .string, description: "The image description, in English for best results. Include style, composition, lighting."),
                    "size": AgentToolParam(type: .string, description: "Image size.", enumValues: ["1024x1024", "1536x1024", "1024x1536"]),
                ],
                required: ["tool_title", "prompt"],
                propertyOrdering: ["tool_title", "prompt", "size"]
            ))
        }

        // [T-orchestration] Orchestration tools exist ONLY when the user has
        // switched them on (Settings → Agent Runtime, default off).
        if WorkerPool.isEnabled {
            tools.append(AgentToolDefinition(
                name: "dispatch_subtask",
                description: "Spin up a parallel WORKER session to handle an independent subtask while you continue. The worker is a full ordinary session (visible in the sidebar) with its own context. Use ONLY for genuinely parallelisable work on complex tasks — never for simple requests. Max \(WorkerPool.maxConcurrent) running at once. The subtask prompt must be fully self-contained (workers cannot see this conversation).",
                parameters: [
                    "tool_title": AgentToolParam(type: .string, description: "A concise 5-10 word summary shown to the user. Use the same language as the user."),
                    "prompt": AgentToolParam(type: .string, description: "Fully self-contained instructions for the worker."),
                    "label": AgentToolParam(type: .string, description: "Short human-readable label, e.g. 'Research flight options'."),
                ],
                required: ["tool_title", "prompt", "label"],
                propertyOrdering: ["tool_title", "prompt", "label"]
            ))
            tools.append(AgentToolDefinition(
                name: "check_subtasks",
                description: "Status of every dispatched worker: RUNNING / DONE (with a result preview) / COLLECTED. Poll this between your own steps rather than busy-waiting.",
                parameters: [
                    "tool_title": AgentToolParam(type: .string, description: "A concise 5-10 word summary shown to the user. Use the same language as the user."),
                ],
                required: ["tool_title"],
                propertyOrdering: ["tool_title"]
            ))
            tools.append(AgentToolDefinition(
                name: "collect_subtask",
                description: "Fetch the full final answer of a DONE worker by its id (e.g. 'w1'). A worker's terminal state is final — collecting never re-runs it.",
                parameters: [
                    "tool_title": AgentToolParam(type: .string, description: "A concise 5-10 word summary shown to the user. Use the same language as the user."),
                    "worker_id": AgentToolParam(type: .string, description: "The worker id from dispatch_subtask / check_subtasks."),
                ],
                required: ["tool_title", "worker_id"],
                propertyOrdering: ["tool_title", "worker_id"]
            ))
        }

        return tools
    }

}
