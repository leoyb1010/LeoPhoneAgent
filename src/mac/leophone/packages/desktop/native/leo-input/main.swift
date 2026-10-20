// [leo][WP-52] LeoBot 远程操控的输入注入助手:把手机经 DataChannel 发来的归一化事件用 CGEvent 注入本机。
// 契约见 docs/specs/leo-screen.md「R2」。形态仿 native/macos-window-bounds:无 bundle 的命令行程序。
//
// 用法:leo-input serve --display <CGDirectDisplayID> [--target-pid <pid>]
//   stdin 每行一个 JSON 事件(主进程已校验过形状);stdout 每行一个 JSON 状态。
//   --target-pid 只给开发验证用:事件只投给这个进程(CGEventPostToPid),不进系统事件流(只对键盘有效)。
//   --require-front-pid 只给开发验证用:走真实的全局注入,但每个事件发出前确认该位置最前面的窗口属于这个进程,
//                      不是就立刻退出(code front_guard)。
//
// 输入(坐标 x / y 是 0–1,相对被看的那块屏幕):
//   {"t":"move","x":0.5,"y":0.5}
//   {"t":"down"|"up","b":"left"|"right"|"middle","x":…,"y":…}
//   {"t":"click","b":"left","n":1|2,"x":…,"y":…}
//   {"t":"scroll","dx":0,"dy":-120,"x":…,"y":…}                     像素(点),dy>0 内容往下走
//   {"t":"key","code":"KeyA","mods":["cmd","shift","alt","ctrl"],"phase":"press"|"down"|"up"}
//   {"t":"text","s":"任意文字"}
// 输出:
//   {"type":"ready","accessibility":true,"display":{"x":0,"y":0,"w":1728,"h":1117}}
//   {"type":"accessibility","granted":false}     权限变化(每 3 秒检查一次)
//   {"type":"local_escape"}                       本机键盘连按三次 Esc(1.5 秒内):主进程据此断开
//   {"type":"error","code":"…","message":"…"}
//
// 权限:CGEvent 注入与监听 Esc 都需要「辅助功能」授权(归属 LeoBot,助手是它的子进程)。没授权时照常运行并报告,
// 事件会被系统丢弃。自己注入的事件带 eventSourceUserData 标记,Esc 监听会跳过它们 —— 手机发的 Esc 不会触发断开。

import ApplicationServices
import CoreGraphics
import Foundation

setvbuf(stdout, nil, _IOLBF, 0)

func emit(_ object: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]),
        let line = String(data: data, encoding: .utf8)
    else { return }
    print(line)
}

func option(_ name: String) -> String? {
    let args = CommandLine.arguments
    guard let index = args.firstIndex(of: name), index + 1 < args.count else { return nil }
    return args[index + 1]
}

/// 自己注入的事件打这个标记("LEO"),Esc 监听据此区分本机键盘与远端。
let injectedMarker: Int64 = 0x4C454F

guard CommandLine.arguments.dropFirst().first == "serve" else {
    emit(["type": "error", "code": "usage", "message": "用法:leo-input serve --display <id> [--target-pid <pid> | --require-front-pid <pid>]"])
    exit(2)
}

let displayID = option("--display").flatMap { UInt32($0) } ?? CGMainDisplayID()
let targetPid = option("--target-pid").flatMap { pid_t($0) }
let requiredFrontPid = option("--require-front-pid").flatMap { pid_t($0) }
let source = CGEventSource(stateID: .hidSystemState)

func displayBounds() -> CGRect {
    let bounds = CGDisplayBounds(displayID)
    return bounds.isEmpty ? CGDisplayBounds(CGMainDisplayID()) : bounds
}

/// W3C KeyboardEvent.code → macOS 虚拟键码(ANSI 布局)。
let keyCodes: [String: CGKeyCode] = [
    "KeyA": 0, "KeyS": 1, "KeyD": 2, "KeyF": 3, "KeyH": 4, "KeyG": 5, "KeyZ": 6, "KeyX": 7, "KeyC": 8,
    "KeyV": 9, "KeyB": 11, "KeyQ": 12, "KeyW": 13, "KeyE": 14, "KeyR": 15, "KeyY": 16, "KeyT": 17,
    "Digit1": 18, "Digit2": 19, "Digit3": 20, "Digit4": 21, "Digit6": 22, "Digit5": 23, "Equal": 24,
    "Digit9": 25, "Digit7": 26, "Minus": 27, "Digit8": 28, "Digit0": 29, "BracketRight": 30, "KeyO": 31,
    "KeyU": 32, "BracketLeft": 33, "KeyI": 34, "KeyP": 35, "Enter": 36, "KeyL": 37, "KeyJ": 38,
    "Quote": 39, "KeyK": 40, "Semicolon": 41, "Backslash": 42, "Comma": 43, "Slash": 44, "KeyN": 45,
    "KeyM": 46, "Period": 47, "Tab": 48, "Space": 49, "Backquote": 50, "Backspace": 51, "Escape": 53,
    "MetaRight": 54, "MetaLeft": 55, "ShiftLeft": 56, "CapsLock": 57, "AltLeft": 58, "ControlLeft": 59,
    "ShiftRight": 60, "AltRight": 61, "ControlRight": 62, "F17": 64, "NumpadDecimal": 65,
    "NumpadMultiply": 67, "NumpadAdd": 69, "NumpadDivide": 75, "NumpadEnter": 76, "NumpadSubtract": 78,
    "NumpadEqual": 81, "Numpad0": 82, "Numpad1": 83, "Numpad2": 84, "Numpad3": 85, "Numpad4": 86,
    "Numpad5": 87, "Numpad6": 88, "Numpad7": 89, "Numpad8": 91, "Numpad9": 92, "F5": 96, "F6": 97,
    "F7": 98, "F3": 99, "F8": 100, "F9": 101, "F11": 103, "F13": 105, "F14": 107, "F10": 109,
    "F12": 111, "F15": 113, "Home": 115, "PageUp": 116, "Delete": 117, "F4": 118, "End": 119, "F2": 120,
    "PageDown": 121, "F1": 122, "ArrowLeft": 123, "ArrowRight": 124, "ArrowDown": 125, "ArrowUp": 126,
]

/// 注入状态(当前指针位置、按住的键)只在串行队列里改。
final class Injector: @unchecked Sendable {
    func point(_ event: [String: Any]) -> CGPoint {
        let bounds = displayBounds()
        let x = min(1, max(0, (event["x"] as? Double) ?? 0.5))
        let y = min(1, max(0, (event["y"] as? Double) ?? 0.5))
        return CGPoint(x: bounds.minX + x * bounds.width, y: bounds.minY + y * bounds.height)
    }

    /// 开发验证(--require-front-pid):全局注入前确认「这一点上最前面的窗口属于测试进程」,
    /// 否则立刻退出、一个事件也不发 —— 防止测试中途前台变了把点击送进别的 App。
    func frontGuardAllows(_ location: CGPoint, keyboard: Bool) -> Bool {
        guard let requiredFrontPid else { return true }
        guard let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]
        else { return false }
        // 列表按前后顺序。键盘:最前面的普通窗口(layer 0)就是前台 App 的;
        // 鼠标:第一个包含该点的窗口就是会收到这次事件的窗口。
        if keyboard {
            let front = windows.first { ($0[kCGWindowLayer as String] as? Int) == 0 }
            return (front?[kCGWindowOwnerPID as String] as? pid_t) == requiredFrontPid
        }
        // 程序坞等系统层有覆盖全屏的透明窗口(layer 20,点击穿透):只看普通窗口(layer 0)和测试进程自己的
        // 窗口(如它弹出的右键菜单)。前台 App 也必须是测试进程。
        let front = windows.first { ($0[kCGWindowLayer as String] as? Int) == 0 }
        guard (front?[kCGWindowOwnerPID as String] as? pid_t) == requiredFrontPid else { return false }
        for window in windows {
            let owner = window[kCGWindowOwnerPID as String] as? pid_t
            guard (window[kCGWindowLayer as String] as? Int) == 0 || owner == requiredFrontPid,
                let bounds = window[kCGWindowBounds as String] as? NSDictionary,
                let rect = CGRect(dictionaryRepresentation: bounds), rect.contains(location)
            else { continue }
            return owner == requiredFrontPid
        }
        return false
    }

    func post(_ event: CGEvent?) {
        guard let event else { return }
        event.setIntegerValueField(.eventSourceUserData, value: injectedMarker)
        if let targetPid {
            // 只对键盘有效:AppKit / Chromium 不处理直接投给进程的鼠标事件。
            event.postToPid(targetPid)
            return
        }
        if requiredFrontPid != nil {
            let keyboard = event.type == .keyDown || event.type == .keyUp
            guard frontGuardAllows(event.location, keyboard: keyboard) else {
                emit(["type": "error", "code": "front_guard", "message": "前台不是测试窗口,中止"])
                exit(3)
            }
        }
        event.post(tap: .cghidEventTap)
    }

    var lastPoint = CGPoint(x: displayBounds().midX, y: displayBounds().midY)
    var pressed: Set<CGMouseButton> = []

    func button(_ name: Any?) -> CGMouseButton {
        switch name as? String {
        case "right": return .right
        case "middle": return .center
        default: return .left
        }
    }

    func mouseType(_ button: CGMouseButton, down: Bool) -> CGEventType {
        switch button {
        case .right: return down ? .rightMouseDown : .rightMouseUp
        case .center: return down ? .otherMouseDown : .otherMouseUp
        default: return down ? .leftMouseDown : .leftMouseUp
        }
    }

    /// 按住某个键时的移动要发 dragged,否则选区 / 拖拽不生效。
    func moveType() -> CGEventType {
        if pressed.contains(.left) { return .leftMouseDragged }
        if pressed.contains(.right) { return .rightMouseDragged }
        if pressed.contains(.center) { return .otherMouseDragged }
        return .mouseMoved
    }

    func flags(_ mods: Any?) -> CGEventFlags {
        var result: CGEventFlags = []
        for mod in (mods as? [String]) ?? [] {
            switch mod {
            case "cmd": result.insert(.maskCommand)
            case "shift": result.insert(.maskShift)
            case "alt": result.insert(.maskAlternate)
            case "ctrl": result.insert(.maskControl)
            default: break
            }
        }
        return result
    }

    func handle(_ event: [String: Any]) {
        switch event["t"] as? String {
        case "move":
            lastPoint = point(event)
            post(CGEvent(mouseEventSource: source, mouseType: moveType(), mouseCursorPosition: lastPoint, mouseButton: .left))
        case "down", "up":
            let down = event["t"] as? String == "down"
            let which = button(event["b"])
            if event["x"] != nil { lastPoint = point(event) }
            if down { pressed.insert(which) } else { pressed.remove(which) }
            post(CGEvent(mouseEventSource: source, mouseType: mouseType(which, down: down), mouseCursorPosition: lastPoint, mouseButton: which))
        case "click":
            let which = button(event["b"])
            if event["x"] != nil { lastPoint = point(event) }
            let count = min(3, max(1, (event["n"] as? Int) ?? 1))
            for index in 1...count {
                for down in [true, false] {
                    let mouse = CGEvent(mouseEventSource: source, mouseType: mouseType(which, down: down), mouseCursorPosition: lastPoint, mouseButton: which)
                    mouse?.setIntegerValueField(.mouseEventClickState, value: Int64(index))
                    post(mouse)
                }
            }
        case "scroll":
            if event["x"] != nil {
                lastPoint = point(event)
                post(CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: lastPoint, mouseButton: .left))
            }
            let dx = Int32((event["dx"] as? Double) ?? 0)
            let dy = Int32((event["dy"] as? Double) ?? 0)
            // 手机上手指往上推(dy>0)= 内容往下走 = 滚轮负方向(像素单位)。
            let wheel = CGEvent(scrollWheelEvent2Source: source, units: .pixel, wheelCount: 2, wheel1: -dy, wheel2: -dx, wheel3: 0)
        // 新建的滚轮事件位置取的是「此刻」光标,前面那条移动可能还没生效:显式定位到目标点。
        wheel?.location = lastPoint
        post(wheel)
        case "key":
            guard let code = event["code"] as? String, let key = keyCodes[code] else {
                emit(["type": "error", "code": "unknown_key", "message": "不认识的按键 \(event["code"] ?? "")"])
                return
            }
            let phase = (event["phase"] as? String) ?? "press"
            let modifiers = flags(event["mods"])
            for down in phase == "press" ? [true, false] : [phase == "down"] {
                let keyEvent = CGEvent(keyboardEventSource: source, virtualKey: key, keyDown: down)
                keyEvent?.flags = modifiers
                post(keyEvent)
            }
        case "text":
            guard let text = event["s"] as? String, !text.isEmpty else { return }
            // keyboardSetUnicodeString 每个事件最多 20 个 UTF-16 单位:按字素切块,不把 emoji / 汉字拆开。
            var chunk: [UniChar] = []
            func flush() {
                guard !chunk.isEmpty else { return }
                for down in [true, false] {
                    let keyEvent = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: down)
                    keyEvent?.flags = []
                    keyEvent?.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: chunk)
                    post(keyEvent)
                }
                chunk.removeAll()
            }
            for character in text {
                let units = Array(String(character).utf16)
                if chunk.count + units.count > 20 { flush() }
                chunk.append(contentsOf: units)
            }
            flush()
        default:
            emit(["type": "error", "code": "unknown_event", "message": "不认识的事件"])
        }
    }

    /// 会话结束时松开还按着的鼠标键,不留下「按住」状态。
    func releaseAll() {
        for which in pressed {
            post(CGEvent(mouseEventSource: source, mouseType: mouseType(which, down: false), mouseCursorPosition: lastPoint, mouseButton: which))
        }
        pressed.removeAll()
    }
}

let injector = Injector()

// --- 本机 Esc×3 断开 ---
var escapes: [Date] = []
var tap: CFMachPort?
let tapCallback: CGEventTapCallBack = { _, type, event, _ in
    // 系统嫌回调慢或用户输入时会停用 tap;以前直接放行不再启用,Esc×3 断开从此永久失效(HUD 还在)。重新启用。
    if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
        if let tap { CGEvent.tapEnable(tap: tap, enable: true) }
        return Unmanaged.passUnretained(event)
    }
    if type == .keyDown,
        event.getIntegerValueField(.keyboardEventKeycode) == 53,
        event.getIntegerValueField(.eventSourceUserData) != injectedMarker,
        event.getIntegerValueField(.keyboardEventAutorepeat) == 0
    {
        let now = Date()
        escapes = escapes.filter { now.timeIntervalSince($0) < 1.5 } + [now]
        if escapes.count >= 3 {
            escapes.removeAll()
            emit(["type": "local_escape"])
        }
    }
    return Unmanaged.passUnretained(event)
}

func installEscapeTap() {
    guard tap == nil else { return }
    // 主动型(非 listenOnly)的 tap 只要「辅助功能」授权;事件原样放行,不改不吞。
    tap = CGEvent.tapCreate(
        tap: .cgSessionEventTap,
        place: .headInsertEventTap,
        options: .defaultTap,
        eventsOfInterest: CGEventMask(1 << CGEventType.keyDown.rawValue),
        callback: tapCallback,
        userInfo: nil
    )
    if let tap {
        let runLoopSource = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
        CFRunLoopAddSource(CFRunLoopGetMain(), runLoopSource, .commonModes)
        CGEvent.tapEnable(tap: tap, enable: true)
    }
}

var trusted = AXIsProcessTrusted()
if trusted { installEscapeTap() }
let bounds = displayBounds()
emit([
    "type": "ready",
    "accessibility": trusted,
    "display": ["x": bounds.minX, "y": bounds.minY, "w": bounds.width, "h": bounds.height],
])

// 授权可能在会话中途被用户打开 / 关掉。
Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { _ in
    let now = AXIsProcessTrusted()
    if now != trusted {
        trusted = now
        emit(["type": "accessibility", "granted": now])
        if now { installEscapeTap() }
    }
}

// stdin 在后台线程读;注入在同一个串行队列里按顺序做(500 字连续输入不能乱序)。
let queue = DispatchQueue(label: "leo-input")
Thread.detachNewThread {
    while let line = readLine() {
        guard let data = line.data(using: .utf8),
            let event = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { continue }
        queue.sync { injector.handle(event) }
    }
    // 父进程没了 / 会话结束:松开还按着的鼠标键再退出。
    queue.sync { injector.releaseAll() }
    exit(0)
}

CFRunLoopRun()
