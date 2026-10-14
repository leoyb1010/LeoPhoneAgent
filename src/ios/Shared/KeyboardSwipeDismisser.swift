//
//  KeyboardSwipeDismisser.swift
//  MinisApp
//
//  键盘弹着时,在输入框上方的任意位置向下滑就收起键盘 —— 全局兜底。
//  聊天列表自己有 keyboardDismissMode = .onDrag,但很多页面(设置子页、sheet、
//  没内容可滚的列表、非滚动页面)向下滑什么都不会发生,键盘就一直"挂着"。
//  这里在每个 App 窗口上挂一个与其它手势并行、不吞触摸的下滑识别器:
//  · 只在键盘可见时接收触摸;
//  · 从当前输入控件(及其下方:输入栏、键盘区)开始的滑动不算 —— 输入框里滚多行文字不受影响;
//  · 终端不参与(终端故意让键盘常驻,keyboardDismissMode = .none)。
//

import UIKit

@MainActor
final class KeyboardSwipeDismisser: NSObject, UIGestureRecognizerDelegate {
    static let shared = KeyboardSwipeDismisser()

    private var keyboardVisible = false
    private var started = false
    private var dismissedThisGesture = false

    /// 下滑多少点、且以纵向为主才收起。
    static let minTranslation: CGFloat = 40

    func start() {
        guard !started else { return }
        started = true
        let nc = NotificationCenter.default
        nc.addObserver(forName: UIResponder.keyboardWillShowNotification, object: nil, queue: .main) { _ in
            MainActor.assumeIsolated {
                self.keyboardVisible = true
                self.attachToKeyWindows()
            }
        }
        nc.addObserver(forName: UIResponder.keyboardWillHideNotification, object: nil, queue: .main) { _ in
            MainActor.assumeIsolated { self.keyboardVisible = false }
        }
    }

    private func attachToKeyWindows() {
        let windows = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
        for window in windows where window.windowLevel == .normal {
            guard !(window.gestureRecognizers ?? []).contains(where: { $0.delegate === self }) else { continue }
            let pan = UIPanGestureRecognizer(target: self, action: #selector(handlePan(_:)))
            pan.cancelsTouchesInView = false
            pan.delaysTouchesBegan = false
            pan.delaysTouchesEnded = false
            pan.delegate = self
            window.addGestureRecognizer(pan)
        }
    }

    /// 纯判定:从输入控件上方起手、向下为主、超过阈值。
    static func shouldDismiss(translation: CGPoint, startY: CGFloat, inputTopY: CGFloat?) -> Bool {
        if let inputTopY, startY >= inputTopY { return false }
        return translation.y >= minTranslation && translation.y > abs(translation.x) * 1.5
    }

    @objc private func handlePan(_ pan: UIPanGestureRecognizer) {
        switch pan.state {
        case .began:
            dismissedThisGesture = false
        case .changed:
            guard keyboardVisible, !dismissedThisGesture, let window = pan.view as? UIWindow else { return }
            let translation = pan.translation(in: window)
            let start = CGPoint(x: pan.location(in: window).x - translation.x, y: pan.location(in: window).y - translation.y)
            let responder = UIResponder.leoCurrentFirstResponder as? UIView
            let inputTop = responder.map { $0.convert($0.bounds, to: window).minY }
            if Self.shouldDismiss(translation: translation, startY: start.y, inputTopY: inputTop) {
                dismissedThisGesture = true
                window.endEditing(true)
            }
        default:
            break
        }
    }

    // MARK: UIGestureRecognizerDelegate

    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
        guard keyboardVisible, let responder = UIResponder.leoCurrentFirstResponder else { return false }
        // 终端:键盘就是输入设备,不能被滑走。
        if responder is TerminalTextView || responder is TerminalKeyInputView { return false }
        // 起手点落在输入控件里(滚动多行输入、拖选文字)不接。
        if let view = responder as? UIView, let hit = touch.view, hit.isDescendant(of: view) { return false }
        return true
    }

    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer,
                           shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool { true }
}

extension UIResponder {
    private static weak var leoFoundResponder: UIResponder?

    /// 当前第一响应者(把 action 发给 nil 目标,由响应链上的第一响应者接住)。
    static var leoCurrentFirstResponder: UIResponder? {
        leoFoundResponder = nil
        UIApplication.shared.sendAction(#selector(leoTrapFirstResponder), to: nil, from: nil, for: nil)
        return leoFoundResponder
    }

    @objc private func leoTrapFirstResponder() {
        UIResponder.leoFoundResponder = self
    }
}
