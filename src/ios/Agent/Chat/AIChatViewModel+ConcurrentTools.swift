//
//  AIChatViewModel+ConcurrentTools.swift
//  MinisApp
//
//  Concurrent tool execution: dispatches up to `maxConcurrentTools` tool
//  calls in parallel via TaskGroup, waits for all to complete, then
//  returns results ordered to match the original tool_use sequence
//  (Anthropic API requires tool_result order to mirror tool_use order
//  within the same user message).
//
//  Created for T-concurrent-tools 2026-05-25.
//

import Foundation
import UIKit

private let ctLogger = AppLogger(category: "AIChatVM")

extension AIChatViewModel {

    /// Hard cap on simultaneous in-flight tool executions per agent turn.
    /// 10 is the requested ceiling; iSH itself can fan out further but
    /// concurrent shell forks on the emulator past this start to compete
    /// for emulator scheduling.
    static let maxConcurrentTools = 10

    /// Set-typed view of currently-running shell PIDs.
    ///
    /// Backed by the singular `runningCommandPid: Int32` slot on
    /// AIChatViewModel so `AIChatViewModel+ISHCommand`'s pidCallback
    /// (which assigns `runningCommandPid = pid`) keeps working
    /// unchanged. The stop button enumerates this Set to kill every
    /// in-flight shell across a concurrent batch. When per-task PID
    /// tracking lands this can be promoted to true Set storage with
    /// per-task insert/remove.
    ///
    /// [T-ios-concurrent-toolcall-dup-id]
    var runningCommandPids: Set<Int32> {
        get { runningCommandPid > 0 ? [runningCommandPid] : [] }
        set { runningCommandPid = newValue.first ?? 0 }
    }

    /// Tiny actor wrapping the per-turn image budget so concurrent tool
    /// tasks can race-free claim a slot for their image bytes.
    /// `reserveSlot()` returns true iff a slot was claimed; the caller
    /// then attaches `imageData` to its toolResult. False → caller must
    /// substitute a text placeholder.
    actor BatchImageBudget {
        private var remaining: Int
        private(set) var strippedCount: Int = 0

        init(initial: Int) { self.remaining = max(0, initial) }

        /// Claim one image slot. Returns true if granted.
        func reserveSlot() -> Bool {
            if remaining > 0 {
                remaining -= 1
                return true
            }
            strippedCount += 1
            return false
        }

        var strippedSoFar: Int { strippedCount }
    }

    /// Outcome of executing a single tool call. Collected by each child
    /// task and merged in original index order by the outer dispatcher.
    struct ToolExecOutcome {
        let toolId: String
        let toolName: String
        let resultPart: AgentContentPart            // .toolResult(...)
        let snapshotEntry: (toolName: String, snapshot: ToolSnapshot)?
        let snapshotItem: ToolSnapshotItem?
        let cancelled: Bool
    }

    /// Execute a single tool use, returning a self-contained outcome.
    /// All mutations to `messages[msgIdx].blocks[blockIdx]` happen inside
    /// (the VM is @MainActor so this is safe even when invoked from
    /// concurrent child tasks). The outcome carries the toolResult part,
    /// snapshot, and cancellation flag so the dispatcher can collect them
    /// in original tool_use order after every child task completes.
    func executeSingleToolUse(
        tu: StreamResult.ToolEntry,
        msgIdx: Int,
        tools: [AgentToolDefinition],
        batchBudget: BatchImageBudget
    ) async -> ToolExecOutcome {
        let blockIdx = tu.blockIdx

        // Graceful cancel pre-check: any task that begins after the user
        // tapped Stop short-circuits with a synthetic cancellation result
        // so history stays paired.
        if Task.isCancelled || self.userDidCancel {
            let cancelContent = "<system-reminder>The user cancelled this operation. The returned result may be incomplete.</system-reminder>"
            if msgIdx < messages.count, blockIdx < messages[msgIdx].blocks.count {
                messages[msgIdx].blocks[blockIdx].toolStatus = .cancelled
                messages[msgIdx].blocks[blockIdx].content = cancelContent
            }
            let cancelSnap = ToolSnapshot(type: .text, text: cancelContent, mediaRef: nil, duration: nil)
            let item = ToolSnapshotItem(
                id: tu.id, toolName: tu.name, snapshot: cancelSnap,
                mediaResolver: await ChatStore.shared.mediaFileURLResolver()
            )
            return ToolExecOutcome(
                toolId: tu.id, toolName: tu.name,
                resultPart: .toolResult(id: tu.id, name: tu.name, content: cancelContent, isError: true),
                snapshotEntry: (toolName: tu.name, snapshot: cancelSnap),
                snapshotItem: item,
                cancelled: true
            )
        }

        var toolOutput: String = ""
        var toolSuccess: Bool = false
        var toolImageData: Data?
        var toolImageMimeType: String?
        var toolImageLinuxPath: String?
        var toolPageURL: String?
        var cancelledHere = false

        // Loop-detector pre-check: short-circuit when the model is stuck
        // in a runaway pattern (unknown tool spam, no-progress polling, etc).
        let loopPreCheck = toolLoopDetector.check(toolName: tu.name, params: tu.args)
        if loopPreCheck.level == .critical, let blockedMsg = loopPreCheck.message {
            toolOutput = blockedMsg
            toolSuccess = false
            if msgIdx < messages.count, blockIdx < messages[msgIdx].blocks.count {
                messages[msgIdx].blocks[blockIdx].content = blockedMsg
                messages[msgIdx].blocks[blockIdx].toolStatus = .failed(message: "loop blocked")
            }
            toolLoopDetector.record(
                toolName: tu.name, params: tu.args,
                result: nil, errorMessage: blockedMsg, toolCallId: tu.id
            )
            let blockedSnap = ToolSnapshot(type: .text, text: blockedMsg, mediaRef: nil, duration: nil)
            let item = ToolSnapshotItem(
                id: tu.id, toolName: tu.name, snapshot: blockedSnap,
                mediaResolver: await ChatStore.shared.mediaFileURLResolver()
            )
            return ToolExecOutcome(
                toolId: tu.id, toolName: tu.name,
                resultPart: .toolResult(id: tu.id, name: tu.name, content: blockedMsg, isError: true),
                snapshotEntry: (toolName: tu.name, snapshot: blockedSnap),
                snapshotItem: item,
                cancelled: false
            )
        }

        // JSON Repair (T-tool-json-repair b2c4f8a6).
        var toolArgs: [String: Any] = tu.args
        let needsRepair: Bool = {
            guard let toolDef = tools.first(where: { $0.name == tu.name }) else { return false }
            if tu.args.isEmpty && !toolDef.required.isEmpty { return true }
            for field in toolDef.required {
                guard let raw = tu.args[field] else { return true }
                if raw is NSNull { return true }
                if let s = raw as? String,
                   s.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return true }
                if !(raw is String) && !(raw is [Any]) && !(raw is [String: Any]) { return true }
            }
            return false
        }()
        if needsRepair {
            let rawJoined = tu.inputChunkRing.joined()
            let repairOutcome = Self.repairToolArgs(
                name: tu.name, args: tu.args, rawTail: rawJoined, tools: tools
            )
            if !repairOutcome.repairs.isEmpty {
                AppLogger(category: "ToolPreflight").warning(
                    "[ToolRepair] REPAIRED tool=\(tu.name) id=\(tu.id) strategies=[\(repairOutcome.repairs.joined(separator: ", "))] beforeKeys=[\(tu.args.keys.sorted().joined(separator: ","))] afterKeys=[\(repairOutcome.args.keys.sorted().joined(separator: ","))] rawBytes=\(rawJoined.utf8.count)"
                )
                toolArgs = repairOutcome.args
            }
        }

        // Preflight: reject empty / missing-required-field tool calls.
        if let preflightError = Self.preflightValidateToolCall(name: tu.name, args: toolArgs, tools: tools) {
            let chunkRing = tu.inputChunkRing
            AppLogger(category: "ToolPreflight").warning(
                "[ToolPreflight] BLOCKED tool=\(tu.name) id=\(tu.id) reason=\"\(preflightError)\" argsKeys=[\(tu.args.keys.sorted().joined(separator: ","))] chunkCount=\(chunkRing.count) lastChunkBytes=\(chunkRing.last?.utf8.count ?? 0)"
            )
            let uiMessage = String(localized: "Blocked invalid tool call")
            let modelMessage = "Error: Tool call rejected before execution. \(preflightError) The arguments your client sent were empty or missing required fields — re-issue the call with all required parameters filled in. Do not retry with the same empty arguments."
            if msgIdx < messages.count, blockIdx < messages[msgIdx].blocks.count {
                messages[msgIdx].blocks[blockIdx].content = uiMessage
                messages[msgIdx].blocks[blockIdx].toolStatus = .failed(message: uiMessage)
            }
            toolLoopDetector.record(
                toolName: tu.name, params: tu.args,
                result: nil, errorMessage: modelMessage, toolCallId: tu.id
            )
            let blockedSnap = ToolSnapshot(type: .text, text: modelMessage, mediaRef: nil, duration: nil)
            let item = ToolSnapshotItem(
                id: tu.id, toolName: tu.name, snapshot: blockedSnap,
                mediaResolver: await ChatStore.shared.mediaFileURLResolver()
            )
            return ToolExecOutcome(
                toolId: tu.id, toolName: tu.name,
                resultPart: .toolResult(id: tu.id, name: tu.name, content: modelMessage, isError: true),
                snapshotEntry: (toolName: tu.name, snapshot: blockedSnap),
                snapshotItem: item,
                cancelled: false
            )
        }

        let argsJson: String = {
            if let data = try? JSONSerialization.data(withJSONObject: toolArgs),
               let str = String(data: data, encoding: .utf8) {
                return str
            }
            return "{}"
        }()

        do {
        switch tu.name {
        case "shell_execute":
            let (command, timeout, delay) = parseToolInput(from: argsJson)

            if command.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                ctLogger.warning("[ToolArgsProbe] shell_execute called with empty command argsBytes=\(argsJson.utf8.count)")
                toolOutput = "Error: Missing required 'command' parameter. Please call shell_execute again with a non-empty `command` field."
                toolSuccess = false
                if msgIdx < messages.count, blockIdx < messages[msgIdx].blocks.count {
                    messages[msgIdx].blocks[blockIdx].content = toolOutput
                }
                break
            }

            // Offload permission check.
            ctLogger.info("[OffloadPerm] shell commandLength=\(command.count)")
            if let offloadCmd = OffloadPermissionManager.extractOffloadCommand(from: command) {
                ctLogger.info("[OffloadPerm] matched offload: \(offloadCmd), level: \(OffloadPermissionManager.shared.permissionLevel(for: offloadCmd).rawValue)")
                let permResult = await OffloadPermissionManager.shared.checkPermission(
                    for: offloadCmd, sessionId: self.sessionId, fullCommand: command
                )
                if case .denied(let msg) = permResult {
                    ctLogger.info("[OffloadPerm] DENIED: \(offloadCmd)")
                    toolOutput = msg
                    toolSuccess = false
                    if msgIdx < messages.count, blockIdx < messages[msgIdx].blocks.count {
                        messages[msgIdx].blocks[blockIdx].content = msg
                    }
                    break
                }
                ctLogger.info("[OffloadPerm] ALLOWED: \(offloadCmd)")
            } else {
                ctLogger.info("[OffloadPerm] no offload match for first token")
            }

            // Delay execution.
            if delay > 0 {
                toolDelayWaitCount += 1
                defer { toolDelayWaitCount -= 1 }
                // [T-delay-stop-latency] The stop button during the countdown
                // sets `commandCancelledByUser` (stopCurrentCommand guards on
                // `toolDelayWaitActive`), but the old loop only re-checked that
                // flag once per whole second and then slept a FULL second — a
                // tap landing just after a check waited up to ~1s before the
                // next check, which read as "stop does nothing" during the
                // delay phase (the user report). Poll on a short tick instead so
                // both the button flag AND Task cancellation are honored within
                // ~100ms, while the visible countdown still refreshes once per
                // whole second.
                let totalSeconds = Int(delay)
                let tickNanos: UInt64 = 100_000_000 // 100ms
                let ticksPerSecond = 10
                var lastShownRemaining = -1
                for tick in 0..<(totalSeconds * ticksPerSecond) {
                    if commandCancelledByUser || Task.isCancelled {
                        throw CancellationError()
                    }
                    let remaining = totalSeconds - (tick / ticksPerSecond)
                    if remaining != lastShownRemaining,
                       msgIdx < self.messages.count, blockIdx < self.messages[msgIdx].blocks.count {
                        lastShownRemaining = remaining
                        let mm = remaining / 60
                        let ss = remaining % 60
                        let countdown = mm > 0 ? String(format: "%d:%02d", mm, ss) : "\(ss)s"
                        self.messages[msgIdx].blocks[blockIdx].content = "⏳ Waiting \(countdown) before executing..."
                        self.scrollToBottomSignal.send()
                    }
                    try await Task.sleep(nanoseconds: tickNanos)
                }
                // Final cancellation check after the last tick so a tap in the
                // final 100ms window still aborts before we launch the process.
                if commandCancelledByUser || Task.isCancelled {
                    throw CancellationError()
                }
            }

            let preSnapshot = snapshotMinisFiles()
            let result: CommandResult
            do {
                var lineBuffer: [String] = []
                var lastFlush = Date.distantPast
                let kMaxStreamingDisplayChars = 30_000
                let flushLines: () -> Void = { [weak self] in
                    guard let self, !lineBuffer.isEmpty else { return }
                    let joined = lineBuffer.joined(separator: "\n")
                    lineBuffer.removeAll()
                    lastFlush = Date()
                    if msgIdx < self.messages.count && blockIdx < self.messages[msgIdx].blocks.count {
                        let current = self.messages[msgIdx].blocks[blockIdx].content
                        var newContent: String
                        if current.hasSuffix("Executing...") {
                            newContent = joined
                        } else {
                            newContent = current + "\n" + joined
                        }
                        if newContent.count > kMaxStreamingDisplayChars {
                            newContent = "…[output truncated]…\n" + String(newContent.suffix(kMaxStreamingDisplayChars))
                        }
                        self.messages[msgIdx].blocks[blockIdx].content = newContent
                        self.scrollToBottomSignal.send()
                    }
                }
                result = try await executeCommand(command, timeout: timeout) { [weak self] line in
                    guard let self else { return }
                    let (cleanedLine, capturedURLs) = MinisURLMarker.extract(from: line)
                    if !capturedURLs.isEmpty {
                        Task { @MainActor in
                            for raw in capturedURLs {
                                if let u = URL(string: raw),
                                   MinisOpenURLBroker.isSupportedScheme(u.scheme) {
                                    MinisOpenURLBroker.shared.offer(u)
                                }
                            }
                        }
                    }
                    if cleanedLine.isEmpty && !line.isEmpty { return }
                    lineBuffer.append(cleanedLine)
                    if Date().timeIntervalSince(lastFlush) >= 0.2 {
                        flushLines()
                    }
                }
                flushLines()
            } catch {
                result = CommandResult(output: "Error: \(error.localizedDescription)", exitCode: -1)
            }
            if msgIdx < messages.count, blockIdx < messages[msgIdx].blocks.count {
                let existingContent = messages[msgIdx].blocks[blockIdx].content
                let hasStreamedContent = !existingContent.isEmpty
                    && !existingContent.hasSuffix("Executing...")
                if !hasStreamedContent {
                    let (cleaned, capturedURLs) = MinisURLMarker.extract(from: result.output)
                    for raw in capturedURLs {
                        if let u = URL(string: raw),
                           MinisOpenURLBroker.isSupportedScheme(u.scheme) {
                            MinisOpenURLBroker.shared.offer(u)
                        }
                    }
                    let resultTrimmed = cleaned.trimmingCharacters(in: .whitespacesAndNewlines)
                    if !resultTrimmed.isEmpty {
                        messages[msgIdx].blocks[blockIdx].content = resultTrimmed
                    }
                }
            }
            if commandCancelledByUser {
                // NOTE: don't reset commandCancelledByUser here under
                // concurrent execution — sibling shell tasks still need
                // the signal to abort their own delay loops. The outer
                // dispatcher resets it once per batch.
                toolOutput = "<system-reminder>The user cancelled this operation. The returned result may be incomplete.</system-reminder>\n" + result.output
                cancelledHere = true
            } else {
                toolOutput = result.output
            }
            toolSuccess = result.exitCode == 0

            // Scan for new/modified files under /var/minis/
            let postSnapshot = snapshotMinisFiles()
            let newOrModified = postSnapshot.filter { key, date in
                preSnapshot[key] == nil || preSnapshot[key]! < date
            }
            if !newOrModified.isEmpty {
                for (path, _) in newOrModified {
                    var isDir: ObjCBool = false
                    if let hostURL = resolveHostPath(path) {
                        FileManager.default.fileExists(atPath: hostURL.path, isDirectory: &isDir)
                    }
                    ensureParentDirsInMetaDB(for: path)
                    ensureFakefsMetadata(for: path, isDirectory: isDir.boolValue)
                }
                toolOutput += "\n\n[minis] New/modified files:"
                for path in newOrModified.keys.sorted() {
                    if let url = linuxPathToMinisURL(path) {
                        toolOutput += "\n  \(url)"
                    }
                }

                let sourceMessageId = msgIdx < messages.count ? messages[msgIdx].id.uuidString : nil
                var capturedCount = 0
                for path in newOrModified.keys.sorted() {
                    if await captureWorkspaceArtifact(path: path, sourceMessageId: sourceMessageId) != nil {
                        capturedCount += 1
                    }
                }
                if capturedCount > 0 {
                    toolOutput += "\n  Captured \(capturedCount) artifact\(capturedCount == 1 ? "" : "s") in this chat."
                }
                // [T-generated-image-visibility] A written image shows up IN
                // the conversation bubble immediately — same imageFilePath
                // mechanism the browser screenshots use. No read_image round
                // trip, no "saved somewhere, trust me".
                if let imagePath = newOrModified.keys.sorted().first(where: {
                    Self.inlineImageExtensions.contains(($0 as NSString).pathExtension.lowercased())
                }), let hostURL = await resolvePathForDirectRead(imagePath),
                   msgIdx < messages.count, blockIdx < messages[msgIdx].blocks.count {
                    messages[msgIdx].blocks[blockIdx].imageFilePath = hostURL.path
                }
            }

            let (redactedOut, redactHits) = EnvVarRedactor.redactIfEnabled(toolOutput)
            if redactHits > 0 {
                ctLogger.info("[EnvVarRedact] shell_execute: masked \(redactHits) env-var value(s) in tool result")
            }
            toolOutput = redactedOut

        case "file_read":
            let fileResult: FileToolResult
            do {
                fileResult = try await executeFileRead(from: argsJson)
            } catch {
                fileResult = FileToolResult(output: "Error: \(error.localizedDescription)", success: false)
            }
            if msgIdx < messages.count, blockIdx < messages[msgIdx].blocks.count {
                messages[msgIdx].blocks[blockIdx].content = fileResult.output
            }
            toolOutput = fileResult.output
            toolSuccess = fileResult.success
            if fileResult.success,
               let data = argsJson.data(using: .utf8),
               let dict = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let readPath = dict["path"] as? String,
               let skillId = SkillStore.shared.skillIdFromPath(readPath) {
                await MainActor.run { SkillStore.shared.recordSkillUse(skillId) }
            }

        case "file_write":
            let fileResult: FileToolResult
            do {
                fileResult = try await executeFileWrite(from: argsJson)
            } catch {
                fileResult = FileToolResult(output: "Error: \(error.localizedDescription)", success: false)
            }
            if msgIdx < messages.count, blockIdx < messages[msgIdx].blocks.count {
                messages[msgIdx].blocks[blockIdx].content = fileResult.output
            }
            toolOutput = fileResult.output
            toolSuccess = fileResult.success
            if fileResult.success,
               let data = argsJson.data(using: .utf8),
               let dict = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let writtenPath = dict["path"] as? String,
               writtenPath.contains("/skills/") && writtenPath.hasSuffix("SKILL.md") {
                await MainActor.run { SkillStore.shared.reload() }
            }

                    // [T-inline-image-render] Same visibility rules as the shell
            // branch: written images are captured + shown inline.
            if toolSuccess {
                let argsFW = (try? JSONSerialization.jsonObject(with: Data(argsJson.utf8)) as? [String: Any]) ?? [:]
                if let writtenPath = argsFW["path"] as? String,
                   Self.inlineImageExtensions.contains((writtenPath as NSString).pathExtension.lowercased()) {
                    let sourceMessageId = msgIdx < messages.count ? messages[msgIdx].id.uuidString : nil
                    _ = await captureWorkspaceArtifact(path: writtenPath, sourceMessageId: sourceMessageId)
                    if let hostURL = await resolvePathForDirectRead(writtenPath),
                       msgIdx < messages.count, blockIdx < messages[msgIdx].blocks.count {
                        messages[msgIdx].blocks[blockIdx].imageFilePath = hostURL.path
                    }
                }
            }

        case "file_edit":
            let fileResult: FileToolResult
            do {
                fileResult = try await executeFileEdit(from: argsJson)
            } catch {
                fileResult = FileToolResult(output: "Error: \(error.localizedDescription)", success: false)
            }
            if msgIdx < messages.count, blockIdx < messages[msgIdx].blocks.count {
                messages[msgIdx].blocks[blockIdx].content = fileResult.output
            }
            toolOutput = fileResult.output
            toolSuccess = fileResult.success
            if fileResult.success,
               let data = argsJson.data(using: .utf8),
               let dict = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let editedPath = dict["path"] as? String,
               editedPath.contains("/skills/") && editedPath.hasSuffix("SKILL.md") {
                await MainActor.run { SkillStore.shared.reload() }
            }

        case "browser_use":
            var browserResult: BrowserActionResult
            if let input = BrowserActionInput.parse(from: argsJson) {
                // [T-cred-approval] 读/写 Cookie 的按次审批闸不在这里——已
                // 下沉到 BrowserTabPool.execute(所有路径的单一收口,含
                // shell 的 minis-browser-use),避免这里再审一次造成双弹窗。
                do {
                    browserResult = try await browserTabPool.execute(action: input)
                } catch {
                    browserResult = .error(error.localizedDescription)
                }
            } else {
                browserResult = .error("Invalid browser_use input. Required: 'action' parameter.")
            }

            if browserTakeoverActive {
                if let freshResult = await waitForMidActionTakeover() {
                    let originalText = browserResult.text
                    let takeoverNote = "\n[Browser takeover] User manually operated the browser. Screenshot updated."
                    browserResult = BrowserActionResult(
                        text: originalText + takeoverNote,
                        success: browserResult.success,
                        base64Image: freshResult.base64Image,
                        imageFilePath: freshResult.imageFilePath,
                        pageURL: freshResult.pageURL ?? browserResult.pageURL
                    )
                }
            }
            if msgIdx < messages.count, blockIdx < messages[msgIdx].blocks.count {
                messages[msgIdx].blocks[blockIdx].content = browserResult.text
                messages[msgIdx].blocks[blockIdx].imageFilePath = browserResult.imageFilePath
                if let pageURL = browserResult.pageURL {
                    messages[msgIdx].blocks[blockIdx].browserURL = pageURL
                }
            }
            toolOutput = browserResult.text
            toolSuccess = browserResult.success
            toolPageURL = browserResult.pageURL
            if let b64 = browserResult.base64Image, let data = Data(base64Encoded: b64) {
                toolImageData = Self.resizedImageData(data, maxLongEdge: 2000) ?? data
                toolImageMimeType = "image/jpeg"

                let timestamp = Int(Date().timeIntervalSince1970)
                let screenshotFilename = "screenshot_\(timestamp).jpg"
                let sid = sessionId ?? "unknown"
                let persistDir = Self.minisBrowserPersistentDir(for: sid)
                let fm = FileManager.default
                try? fm.createDirectory(at: persistDir, withIntermediateDirectories: true)
                let persistPath = persistDir.appendingPathComponent(screenshotFilename)
                try? data.write(to: persistPath)

                let linuxPath = "\(Self.minisBrowserLinuxDir)/\(screenshotFilename)"
                toolImageLinuxPath = linuxPath

                if let minisURL = linuxPathToMinisURL(linuxPath) {
                    toolOutput += "\nminis_url: \(minisURL)"
                }
            }

            if let fetchData = browserResult.fetchedFileData,
               let fetchName = browserResult.fetchedFileName {
                let sid = sessionId ?? "unknown"
                let persistDir = Self.minisBrowserPersistentDir(for: sid)
                try? FileManager.default.createDirectory(at: persistDir, withIntermediateDirectories: true)
                let persistPath = persistDir.appendingPathComponent(fetchName)
                try? fetchData.write(to: persistPath)

                let linuxPath = "\(Self.minisBrowserLinuxDir)/\(fetchName)"
                if let minisURL = linuxPathToMinisURL(linuxPath) {
                    toolOutput += "\nminis_url: \(minisURL)"
                }
            }

            // [T-browser-download-ux] Surface native WKDownload activity in the
            // tool result so the agent KNOWS a page interaction triggered a
            // download and doesn't re-download the same file via shell
            // curl/wget. WebKit's decideDestination callback can land a beat
            // after the action resolves (navigation-turned-download resumes
            // the continuation first), so if a download is in flight but not
            // yet registered, wait briefly for the filename to be known.
            if let sid = sessionId {
                var downloadReport = BrowserDownloadCenter.shared.agentReport(for: sid)
                if downloadReport == nil,
                   browserTabPool.activeManager?.hasInflightDownloads == true {
                    try? await Task.sleep(nanoseconds: 500_000_000)
                    downloadReport = BrowserDownloadCenter.shared.agentReport(for: sid)
                        ?? "[browser_downloads] This action triggered a native browser file "
                         + "download that is still starting (filename not yet resolved). It will "
                         + "be saved into /var/minis/workspace/ — do NOT re-download it with "
                         + "curl/wget; check the workspace or the next browser_use result instead."
                }
                if let downloadReport {
                    toolOutput += "\n\n" + downloadReport
                }
            }

        case "read_image":
            let pathArg = toolArgs["path"] as? String ?? ""
            let resolvedURL = await resolveMinisPath(pathArg)
            ctLogger.info("[read_image] pathArg=\(pathArg) resolvedURL=\(resolvedURL?.path ?? "nil") exists=\(resolvedURL.map { FileManager.default.fileExists(atPath: $0.path) } ?? false)")
            if let resolvedURL {
                let dataOK = (try? Data(contentsOf: resolvedURL)) != nil
                let uiOK = (try? Data(contentsOf: resolvedURL)).flatMap { UIImage(data: $0) } != nil
                ctLogger.info("[read_image] dataReadable=\(dataOK) uiImageDecodable=\(uiOK) fileSize=\((try? FileManager.default.attributesOfItem(atPath: resolvedURL.path)[.size]) ?? "?")")
            }

            if let fileURL = resolvedURL,
               let fileData = try? Data(contentsOf: fileURL),
               let uiImage = UIImage(data: fileData) {
                let originalSize = fileData.count
                let originalW = uiImage.cgImage.map { $0.width } ?? Int(uiImage.size.width)
                let originalH = uiImage.cgImage.map { $0.height } ?? Int(uiImage.size.height)

                let inferenceData: Data
                let resizedW: Int
                let resizedH: Int
                if let resized = Self.resizedImageData(fileData, maxLongEdge: 2000),
                   let resizedImage = UIImage(data: resized) {
                    inferenceData = resized
                    resizedW = resizedImage.cgImage.map { $0.width } ?? Int(resizedImage.size.width)
                    resizedH = resizedImage.cgImage.map { $0.height } ?? Int(resizedImage.size.height)
                } else {
                    inferenceData = uiImage.jpegData(compressionQuality: 0.85) ?? fileData
                    resizedW = originalW
                    resizedH = originalH
                }

                toolImageData = inferenceData
                toolImageMimeType = "image/jpeg"
                if pathArg.hasPrefix("/var/minis/") {
                    toolImageLinuxPath = pathArg
                } else if pathArg.hasPrefix("leophoneagent://") {
                    let tail = String(pathArg.dropFirst("leophoneagent://".count))
                    if !tail.isEmpty {
                        toolImageLinuxPath = "/var/minis/\(tail)"
                    }
                }

                var meta = "Image loaded successfully."
                meta += "\nPath: \(pathArg)"
                meta += "\nOriginal: \(originalW)x\(originalH), \(formatBytes(originalSize))"
                if resizedW != originalW || resizedH != originalH {
                    meta += "\nResized for analysis: \(resizedW)x\(resizedH)"
                }
                meta += "\nMIME: image/jpeg"
                toolOutput = meta
                toolSuccess = true

                if msgIdx < messages.count, blockIdx < messages[msgIdx].blocks.count {
                    messages[msgIdx].blocks[blockIdx].imageFilePath = fileURL.path
                    messages[msgIdx].blocks[blockIdx].content = meta
                }
            } else {
                ctLogger.error("[read_image] FAILED pathArg=\(pathArg) resolvedURL=\(resolvedURL?.path ?? "nil")")
                toolOutput = "Error: Could not read image at '\(pathArg)'. Verify the path exists and is a valid image file."
                toolSuccess = false
            }

        case "memory_write":
            let memResult = executeMemoryWrite(from: argsJson)
            if msgIdx < messages.count, blockIdx < messages[msgIdx].blocks.count {
                messages[msgIdx].blocks[blockIdx].content = memResult.output
            }
            toolOutput = memResult.output
            toolSuccess = memResult.success

        case "recall":
            let argsRecall = (try? JSONSerialization.jsonObject(with: Data(argsJson.utf8)) as? [String: Any]) ?? [:]
            let recallQuery = (argsRecall["query"] as? String) ?? ""
            if recallQuery.isEmpty {
                toolOutput = "Error: missing query."
                toolSuccess = false
            } else {
                let (hits, semantic) = await MemoryRecallIndex.shared.query(recallQuery)
                if hits.isEmpty {
                    toolOutput = "No matching memories found."
                    toolSuccess = true
                } else {
                    var lines = [semantic ? "Semantic matches:" : "Keyword matches (embedding assets unavailable on this device):"]
                    for hit in hits {
                        lines.append("[" + hit.source + "] " + hit.text)
                    }
                    toolOutput = lines.joined(separator: "\n\n")
                    toolSuccess = true
                }
            }
            if msgIdx < messages.count, blockIdx < messages[msgIdx].blocks.count {
                messages[msgIdx].blocks[blockIdx].content = toolOutput
            }

        case "memory_get":
            let memResult = executeMemoryGet(from: argsJson)
            if msgIdx < messages.count, blockIdx < messages[msgIdx].blocks.count {
                messages[msgIdx].blocks[blockIdx].content = memResult.output
            }
            toolOutput = memResult.output
            toolSuccess = memResult.success

        // [T-remote-exec] SSH remote execution (tools only registered when a
        // host is configured — see ToolDefinitions).
        case "remote_shell", "remote_agent":
            let args = (try? JSONSerialization.jsonObject(with: Data(argsJson.utf8)) as? [String: Any]) ?? [:]
            let hostName = (args["host"] as? String) ?? ""
            let hosts = RemoteHostStore.configuredHosts()
            // Exact name match; the single-host convenience only applies when
            // the model passed NO name — a wrong name must fail loudly, not
            // silently hit whatever machine happens to be configured.
            if let host = hosts.first(where: { $0.name == hostName })
                ?? (hostName.isEmpty && hosts.count == 1 ? hosts.first : nil) {
                let command: String
                let timeout: TimeInterval
                if tu.name == "remote_shell" {
                    command = (args["command"] as? String) ?? ""
                    timeout = TimeInterval((args["timeout"] as? Int) ?? 120)
                } else {
                    let prompt = (args["prompt"] as? String) ?? ""
                    let workdir = (args["workdir"] as? String) ?? ""
                    timeout = TimeInterval((args["timeout"] as? Int) ?? 300)
                    // Login shell so PATH picks up homebrew/npm installs of
                    // `claude`. No cd for the default: quoting '~' would
                    // suppress tilde expansion and fail every run — the login
                    // shell already starts in $HOME.
                    let inner: String
                    if workdir.isEmpty || workdir == "~" {
                        inner = "claude -p \(RemoteShellQuoting.singleQuoted(prompt)) --output-format text 2>&1"
                    } else {
                        inner = "cd \(RemoteShellQuoting.singleQuoted(workdir)) && claude -p \(RemoteShellQuoting.singleQuoted(prompt)) --output-format text 2>&1"
                    }
                    command = "zsh -lc " + RemoteShellQuoting.singleQuoted(inner)
                }
                if command.isEmpty || (tu.name == "remote_agent" && (args["prompt"] as? String)?.isEmpty != false) {
                    toolOutput = "Error: missing required parameter."
                    toolSuccess = false
                } else if tu.name == "remote_shell",
                          Self.isDangerousRemoteCommand(command),
                          (args["confirmed"] as? Bool) != true {
                    // [T-remote-approval] Destructive work on a REAL computer
                    // needs an explicit user yes, relayed via confirmed=true.
                    let hit = Self.dangerousRemotePattern(command) ?? ""
                    toolOutput = "BLOCKED: command matches destructive pattern [" + hit + "]. Ask the user to approve it explicitly, then retry with confirmed=true."
                    toolSuccess = false
                } else {
                    let result = await RemoteSSHExecutor.shared.runSmart(
                        target: host, allHosts: hosts, command: command, timeout: timeout)
                    toolOutput = result.output
                    toolSuccess = result.succeeded
                }
            } else {
                let names = hosts.map(\.name).joined(separator: ", ")
                toolOutput = "Error: no configured host named '\(hostName)'. Configured hosts: \(names.isEmpty ? "(none)" : names)."
                toolSuccess = false
            }
            if msgIdx < messages.count, blockIdx < messages[msgIdx].blocks.count {
                messages[msgIdx].blocks[blockIdx].content = toolOutput
            }

        case "generate_image":
            let args = (try? JSONSerialization.jsonObject(with: Data(argsJson.utf8)) as? [String: Any]) ?? [:]
            let prompt = (args["prompt"] as? String) ?? ""
            if prompt.isEmpty {
                toolOutput = "Error: missing prompt."
                toolSuccess = false
            } else if let sid = sessionId {
                // [T-image-gen] Ride the existing minis-model-use pipeline —
                // it owns Codex-subscription routing, the Images API and
                // endpoint probing. We add: fixed workspace output, artifact
                // capture and inline display.
                let fileName = "gen-\(Int(Date().timeIntervalSince1970)).png"
                let linuxPath = "/var/minis/workspace/\(fileName)"
                let quotedPrompt = "'" + prompt.replacingOccurrences(of: "'", with: "'\\''") + "'"
                do {
                    let cli = "minis-model-use run --model gpt-image-2 --prompt \(quotedPrompt) --output \(linuxPath)"
                    let result = try await ISHExecutionCoordinator.shared.execute(
                        sessionId: sid, command: cli, timeout: 300,
                        lineCallback: { _ in }, pidCallback: { _ in })
                    if let hostURL = await resolvePathForDirectRead(linuxPath),
                       FileManager.default.fileExists(atPath: hostURL.path) {
                        let sourceMessageId = msgIdx < messages.count ? messages[msgIdx].id.uuidString : nil
                        _ = await captureWorkspaceArtifact(path: linuxPath, sourceMessageId: sourceMessageId)
                        if msgIdx < messages.count, blockIdx < messages[msgIdx].blocks.count {
                            messages[msgIdx].blocks[blockIdx].imageFilePath = hostURL.path
                        }
                        toolOutput = "Image generated → \(linuxPath) (shown inline; also in the artifact tray)."
                        toolSuccess = true
                    } else {
                        toolOutput = "Image generation did not produce a file. CLI said: \(String(result.output.suffix(400)))"
                        toolSuccess = false
                    }
                } catch {
                    toolOutput = "Image generation failed: \(error.localizedDescription)"
                    toolSuccess = false
                }
            } else {
                toolOutput = "Error: no session for image generation."
                toolSuccess = false
            }
            if msgIdx < messages.count, blockIdx < messages[msgIdx].blocks.count {
                messages[msgIdx].blocks[blockIdx].content = toolOutput
            }

        // [T-orchestration] Lead/Worker control surface (registered only when
        // the user enabled orchestration).
        case "dispatch_subtask", "check_subtasks", "collect_subtask":
            let args = (try? JSONSerialization.jsonObject(with: Data(argsJson.utf8)) as? [String: Any]) ?? [:]
            switch tu.name {
            case "dispatch_subtask":
                let result = await WorkerPool.shared.dispatch(
                    prompt: (args["prompt"] as? String) ?? "",
                    label: (args["label"] as? String) ?? "",
                    host: args["host"] as? String)
                toolOutput = result.output
                toolSuccess = result.success
            case "check_subtasks":
                toolOutput = await WorkerPool.shared.status()
                toolSuccess = true
            default:
                let result = await WorkerPool.shared.collect(workerId: (args["worker_id"] as? String) ?? "")
                toolOutput = result.output
                toolSuccess = result.success
            }
            if msgIdx < messages.count, blockIdx < messages[msgIdx].blocks.count {
                messages[msgIdx].blocks[blockIdx].content = toolOutput
            }

        default:
            toolOutput = "Error: Unknown tool '\(tu.name)'"
            toolSuccess = false
        }

        if toolSuccess,
           tu.name == "file_write" || tu.name == "file_edit",
           let outputPath = toolArgs["path"] as? String {
            let sourceMessageId = msgIdx < messages.count ? messages[msgIdx].id.uuidString : nil
            if let snapshot = await captureWorkspaceArtifact(path: outputPath, sourceMessageId: sourceMessageId),
               let version = snapshot.currentVersion {
                toolOutput += "\nArtifact captured: \(snapshot.artifact.title) (version \(version.versionNumber))."
                if msgIdx < messages.count, blockIdx < messages[msgIdx].blocks.count {
                    messages[msgIdx].blocks[blockIdx].content = toolOutput
                }
            }
        }
        } catch is CancellationError {
            let cancelContent = "<system-reminder>The user cancelled this operation. The returned result may be incomplete.</system-reminder>"
            let existing = (msgIdx < messages.count && blockIdx < messages[msgIdx].blocks.count)
                ? messages[msgIdx].blocks[blockIdx].content : ""
            toolOutput = existing.isEmpty ? cancelContent : existing + "\n" + cancelContent
            toolSuccess = false
            cancelledHere = true
            if msgIdx < messages.count, blockIdx < messages[msgIdx].blocks.count {
                messages[msgIdx].blocks[blockIdx].toolStatus = .cancelled
            }
        } catch {
            ctLogger.error("Tool execution threw non-cancellation error: \(error)")
            toolOutput = "Error: \(error.localizedDescription)"
            toolSuccess = false
        }

        // Tail cancel-detection covers user Stop, parent/system cancellation,
        // and a per-tool stop button. Always synthesize a paired tool_result so
        // the next provider request cannot fail with an orphaned tool_use.
        if !cancelledHere && (Task.isCancelled || self.userDidCancel || commandCancelledByUser) {
            cancelledHere = true
            toolOutput += "\n<system-reminder>The user cancelled this operation. The returned result may be incomplete.</system-reminder>"
            if msgIdx < messages.count, blockIdx < messages[msgIdx].blocks.count {
                messages[msgIdx].blocks[blockIdx].content = toolOutput
                messages[msgIdx].blocks[blockIdx].toolStatus = .cancelled
            }
        }

        let toolDuration: TimeInterval? = {
            if msgIdx < messages.count, blockIdx < messages[msgIdx].blocks.count,
               let start = messages[msgIdx].blocks[blockIdx].toolStartTime {
                return Date().timeIntervalSince(start)
            }
            return nil
        }()

        // Create snapshot from tool output.
        let snapshot: ToolSnapshot
        switch tu.name {
        case "browser_use":
            if let imagePath = (msgIdx < messages.count && blockIdx < messages[msgIdx].blocks.count)
                ? messages[msgIdx].blocks[blockIdx].imageFilePath : nil,
               let imageData = try? Data(contentsOf: URL(fileURLWithPath: imagePath)),
               let sid = sessionId {
                let ref = await ChatStore.shared.saveMedia(
                    data: imageData, mimeType: "image/jpeg", sessionId: sid,
                    originalFileName: "browser_snapshot.jpg", subdir: "browser",
                    linuxPath: toolImageLinuxPath
                )
                snapshot = ToolSnapshot(type: .image, text: nil, mediaRef: ref, duration: toolDuration)
            } else {
                let lines = toolOutput.components(separatedBy: "\n")
                let lastLines = lines.suffix(20).joined(separator: "\n")
                snapshot = ToolSnapshot(type: .text, text: lastLines, mediaRef: nil, duration: toolDuration)
            }
        case "read_image":
            if let imagePath = (msgIdx < messages.count && blockIdx < messages[msgIdx].blocks.count)
                ? messages[msgIdx].blocks[blockIdx].imageFilePath : nil,
               let imageData = try? Data(contentsOf: URL(fileURLWithPath: imagePath)),
               let sid = sessionId {
                let fileURL = URL(fileURLWithPath: imagePath)
                let mime = Self.detectImageMime(imageData)
                let ref = await ChatStore.shared.saveMedia(
                    data: imageData, mimeType: mime, sessionId: sid,
                    originalFileName: fileURL.lastPathComponent, subdir: "images",
                    linuxPath: toolImageLinuxPath
                )
                snapshot = ToolSnapshot(type: .image, text: nil, mediaRef: ref, duration: toolDuration)
            } else {
                snapshot = ToolSnapshot(type: .text, text: toolOutput, mediaRef: nil, duration: toolDuration)
            }
        case "generate_image":
            // [T-delivery-persist] Same persistence browser shots get: without
            // a media snapshot the inline image vanished on session reload.
            if let imagePath = (msgIdx < messages.count && blockIdx < messages[msgIdx].blocks.count)
                ? messages[msgIdx].blocks[blockIdx].imageFilePath : nil,
               let imageData = try? Data(contentsOf: URL(fileURLWithPath: imagePath)),
               let sid = sessionId {
                let ref = await ChatStore.shared.saveMedia(
                    data: imageData, mimeType: "image/png", sessionId: sid,
                    originalFileName: URL(fileURLWithPath: imagePath).lastPathComponent,
                    subdir: "generated", linuxPath: nil
                )
                snapshot = ToolSnapshot(type: .image, text: nil, mediaRef: ref, duration: toolDuration)
            } else {
                snapshot = ToolSnapshot(type: .text, text: toolOutput, mediaRef: nil, duration: toolDuration)
            }
        case "file_write", "file_edit":
            // [T-delivery-persist] A written IMAGE snapshots as media (reload
            // keeps it inline); text files keep the preview snapshot.
            if let imagePath = (msgIdx < messages.count && blockIdx < messages[msgIdx].blocks.count)
                ? messages[msgIdx].blocks[blockIdx].imageFilePath : nil,
               let imageData = try? Data(contentsOf: URL(fileURLWithPath: imagePath)),
               let sid = sessionId {
                let ref = await ChatStore.shared.saveMedia(
                    data: imageData, mimeType: Self.detectImageMime(imageData), sessionId: sid,
                    originalFileName: URL(fileURLWithPath: imagePath).lastPathComponent,
                    subdir: "generated", linuxPath: nil
                )
                snapshot = ToolSnapshot(type: .image, text: nil, mediaRef: ref, duration: toolDuration)
            } else if let path = toolArgs["path"] as? String,
               let hostURL = await resolvePathForDirectRead(path),
               let fileContent = try? String(contentsOf: hostURL, encoding: .utf8) {
                let lines = fileContent.components(separatedBy: "\n")
                let preview = lines.prefix(200).joined(separator: "\n")
                snapshot = ToolSnapshot(type: .text, text: preview, mediaRef: nil, duration: toolDuration)
            } else {
                snapshot = ToolSnapshot(type: .text, text: toolOutput, mediaRef: nil, duration: toolDuration)
            }
        default:
            // [T-delivery-persist] Shell-generated images (b44 inline attach)
            // persist as media like every other image-bearing block.
            if let imagePath = (msgIdx < messages.count && blockIdx < messages[msgIdx].blocks.count)
                ? messages[msgIdx].blocks[blockIdx].imageFilePath : nil,
               let imageData = try? Data(contentsOf: URL(fileURLWithPath: imagePath)),
               let sid = sessionId {
                let ref = await ChatStore.shared.saveMedia(
                    data: imageData, mimeType: Self.detectImageMime(imageData), sessionId: sid,
                    originalFileName: URL(fileURLWithPath: imagePath).lastPathComponent,
                    subdir: "generated", linuxPath: nil
                )
                snapshot = ToolSnapshot(type: .image, text: nil, mediaRef: ref, duration: toolDuration)
            } else {
                snapshot = ToolSnapshot(type: .text, text: toolOutput, mediaRef: nil, duration: toolDuration)
            }
        }

        let snapshotResolver = await ChatStore.shared.mediaFileURLResolver()
        let snapshotItem = ToolSnapshotItem(
            id: tu.id, toolName: tu.name, snapshot: snapshot, mediaResolver: snapshotResolver
        )

        // Update tool block status and store execution duration.
        if msgIdx < messages.count, blockIdx < messages[msgIdx].blocks.count {
            let blk = messages[msgIdx].blocks[blockIdx]
            blk.toolDuration = toolDuration
            if cancelledHere {
                blk.toolStatus = .cancelled
            } else {
                blk.toolStatus = toolSuccess
                    ? .success
                    : .failed(message: toolOutput.components(separatedBy: "\n").first ?? "Failed")
            }
            ctLogger.info("[ToolLifecycle] COMPLETED toolId=\(tu.id.prefix(20)) tool=\(tu.name) sid=\(sessionId?.prefix(8) ?? "nil") appState=\(UIApplication.shared.applicationState == .active ? "fg" : "bg") suspended=\(streamingUIUpdatesSuspended) isProcessing=\(isProcessing) success=\(toolSuccess) duration=\(String(format: "%.1f", toolDuration ?? 0))s")
            scrollToBottomSignal.send()
        }

        // Compose finalOutput with truncation/offload.
        let maxToolResultLength = Self.kMaxToolResultChars
        var finalOutput: String
        if toolOutput.isEmpty {
            finalOutput = "(no output)"
        } else if toolOutput.count > maxToolResultLength {
            let offloadResult = offloadToolOutput(toolOutput, toolName: tu.name, toolId: tu.id)
            let offloadMinisURL = linuxPathToMinisURL(offloadResult.linuxPath)
            let truncatedBody: String
            if tu.name == "shell_execute" || tu.name == "browser_use" {
                let halfLen = maxToolResultLength / 2
                truncatedBody = String(toolOutput.prefix(halfLen))
                    + "\n\n...\n\n"
                    + String(toolOutput.suffix(halfLen))
            } else {
                truncatedBody = String(toolOutput.prefix(maxToolResultLength))
            }
            finalOutput = truncatedBody
                + "\n\n[OUTPUT TRUNCATED] Full output (\(toolOutput.count) chars) saved to: \(offloadResult.linuxPath)"
                + (offloadMinisURL.map { "\nminis_url: \($0)" } ?? "")
                + "\nUse file_read tool to read the complete output."
        } else {
            finalOutput = toolOutput
        }

        // Image budget: reserve a slot atomically via the actor. If
        // declined, swap image bytes for a text placeholder.
        if let imgData = toolImageData {
            let granted = await batchBudget.reserveSlot()
            if !granted {
                let placeholder = Self.imagePlaceholderText(data: imgData, originalPath: toolArgs["path"] as? String, snapshotPath: nil)
                if finalOutput.isEmpty || !toolSuccess {
                    finalOutput = placeholder
                } else {
                    finalOutput += "\n\n" + placeholder
                }
                toolImageData = nil
                toolImageMimeType = nil
                ctLogger.info("🖼️ Tool image budget exhausted, stripped image from \(tu.name) id:\(tu.id.prefix(8))")
            }
        }

        // Loop-detector post-record.
        let postCheck = toolLoopDetector.record(
            toolName: tu.name, params: toolArgs,
            result: toolSuccess ? finalOutput : nil,
            errorMessage: toolSuccess ? nil : finalOutput,
            toolCallId: tu.id
        )
        if postCheck.level == .warning, let warningMsg = postCheck.message {
            if finalOutput.isEmpty {
                finalOutput = warningMsg
            } else {
                finalOutput += "\n\n" + warningMsg
            }
        }

        let resultPart = AgentContentPart.toolResult(
            id: tu.id, name: tu.name, content: finalOutput, isError: !toolSuccess,
            imageData: toolImageData, imageMimeType: toolImageMimeType,
            pageURL: toolPageURL, imageLinuxPath: toolImageLinuxPath
        )

        #if DEBUG
        let head = String(finalOutput.prefix(200))
        let tail = finalOutput.count > 400 ? "...\(String(finalOutput.suffix(200)))" : ""
        ctLogger.debug("🔧 Tool result [\(tu.name)] id:\(tu.id.prefix(8)) success:\(toolSuccess) len:\(finalOutput.count) head=\"\(head)\" \(tail)")
        #endif

        return ToolExecOutcome(
            toolId: tu.id, toolName: tu.name,
            resultPart: resultPart,
            snapshotEntry: (toolName: tu.name, snapshot: snapshot),
            snapshotItem: snapshotItem,
            cancelled: cancelledHere
        )
    }
}

extension AIChatViewModel {
    /// [T-remote-approval] Patterns that must not run on a real machine
    /// without an explicit user yes in this conversation.
    static let dangerousRemotePatterns: [String] = [
        "rm -rf", "rm -fr", "sudo ", "mkfs", "dd if=", "> /dev/",
        "git push --force", "git push -f", "chmod -r 777", "shutdown",
        "reboot", "diskutil erase", "killall ", "launchctl unload",
    ]

    static func dangerousRemotePattern(_ command: String) -> String? {
        let lowered = command.lowercased()
        return dangerousRemotePatterns.first { lowered.contains($0) }
    }

    static func isDangerousRemoteCommand(_ command: String) -> Bool {
        dangerousRemotePattern(command) != nil
    }

}
