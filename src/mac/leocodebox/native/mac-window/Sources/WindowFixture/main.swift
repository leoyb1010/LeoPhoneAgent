import AppKit

@MainActor final class FixtureDelegate: NSObject, NSApplicationDelegate {
    private var window: NSWindow?
    private var cover: NSWindow?
    private var label: NSTextField?
    private var count = 0

    func applicationDidFinishLaunching(_ notification: Notification) {
        let main = NSMenu()
        let appItem = NSMenuItem(title: "Leo Window Fixture", action: nil, keyEquivalent: "")
        let appMenu = NSMenu(title: "Leo Window Fixture")
        let quit = NSMenuItem(title: "Quit Fixture", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appMenu.addItem(quit); appItem.submenu = appMenu; main.addItem(appItem)
        let fixture = NSMenuItem(title: "Fixture", action: nil, keyEquivalent: "")
        let commands = NSMenu(title: "Fixture")
        for (title, action) in [("Increment", #selector(increment)), ("Cover Target", #selector(showCover)),
                                 ("Dismiss Cover", #selector(dismissCover)), ("Recreate Window", #selector(recreate))] {
            let item = NSMenuItem(title: title, action: action, keyEquivalent: "")
            item.target = self; commands.addItem(item)
        }
        fixture.submenu = commands; main.addItem(fixture); NSApp.mainMenu = main
        makeWindow()
        NSApp.activate()
    }
    private func makeWindow() {
        let next = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 520, height: 300), styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
        next.title = "Leo Window Fixture"
        next.isReleasedWhenClosed = false
        let view = NSView(frame: NSRect(x: 0, y: 0, width: 520, height: 300))
        let heading = NSTextField(labelWithString: "Only this test window may be controlled.")
        heading.frame = NSRect(x: 24, y: 246, width: 470, height: 24); view.addSubview(heading)
        let field = NSTextField(string: "Initial fixture text")
        field.frame = NSRect(x: 24, y: 194, width: 440, height: 28)
        field.setAccessibilityIdentifier("fixture-input"); view.addSubview(field)
        let button = NSButton(title: "Increment Fixture", target: self, action: #selector(increment))
        button.bezelStyle = .rounded; button.frame = NSRect(x: 24, y: 130, width: 200, height: 36)
        button.setAccessibilityIdentifier("fixture-increment"); view.addSubview(button)
        let result = NSTextField(labelWithString: "Fixture count: \(count)")
        result.frame = NSRect(x: 24, y: 76, width: 300, height: 26)
        result.setAccessibilityIdentifier("fixture-result"); view.addSubview(result); label = result
        next.contentView = view; next.center(); next.makeKeyAndOrderFront(nil); window = next
    }
    @objc private func increment() { count += 1; label?.stringValue = "Fixture count: \(count)" }
    @objc private func showCover() {
        guard let window else { return }
        let next = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 340, height: 180), styleMask: [.titled, .closable], backing: .buffered, defer: false)
        next.isReleasedWhenClosed = false; next.title = "Leo Fixture Cover"
        next.setFrameOrigin(NSPoint(x: window.frame.minX + 20, y: window.frame.minY + 60))
        let button = NSButton(title: "Dismiss Fixture Cover", target: self, action: #selector(dismissCover))
        button.frame = NSRect(x: 30, y: 65, width: 280, height: 40); button.bezelStyle = .rounded
        button.setAccessibilityIdentifier("fixture-dismiss-cover"); next.contentView?.addSubview(button)
        next.makeKeyAndOrderFront(nil); cover = next
    }
    @objc private func dismissCover() { cover?.close(); cover = nil; window?.makeKeyAndOrderFront(nil) }
    @objc private func recreate() { dismissCover(); window?.close(); makeWindow() }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}

MainActor.assumeIsolated {
    let app = NSApplication.shared
    let delegate = FixtureDelegate()
    app.setActivationPolicy(.regular)
    app.delegate = delegate
    withExtendedLifetime(delegate) { app.run() }
}
