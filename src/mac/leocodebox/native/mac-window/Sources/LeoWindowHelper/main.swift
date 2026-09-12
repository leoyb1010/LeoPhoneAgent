import AppKit
import Foundation
import WindowCore

// Establish an AppKit/WindowServer client without creating a window or taking focus.
await MainActor.run {
    let application = NSApplication.shared
    application.setActivationPolicy(.prohibited)
}

let input = FileHandle.standardInput.readData(ofLength: 256 * 1024 + 1)
let response: WindowResponse
if input.count > 256 * 1024 {
    response = WindowResponse(ok: false, reason: "invalid-request", message: "Native request exceeded the size limit.")
} else {
    do {
        let request = try JSONDecoder().decode(WindowRequest.self, from: input)
        response = await WindowEngine(system: MacWindowSystem()).handle(request)
    } catch {
        response = WindowResponse(ok: false, reason: "invalid-request", message: "Invalid native window request.")
    }
}
let output = (try? JSONEncoder().encode(response)) ?? Data("{\"protocolVersion\":1,\"ok\":false,\"reason\":\"execution-failed\",\"message\":\"Encoding failed\"}".utf8)
FileHandle.standardOutput.write(output)
FileHandle.standardOutput.write(Data([10]))
