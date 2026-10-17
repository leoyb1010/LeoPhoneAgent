//
//  SendFlightAnimator.swift
//  MinisApp
//
//  [WP-42] 「发送飞入」的 UIKit 实现。消息列表是 UICollectionView,所以不走 SwiftUI 的
//  matchedGeometry:发送时对输入框截快照挂在窗口层(盖住清空的那一下),新用户气泡的 cell
//  布局好后用 spring 把快照飞过去、淡出，再露出真实 cell。时序判定在 SendFlightPolicy。
//

import UIKit

@MainActor
final class SendFlightAnimator {
    static let shared = SendFlightAnimator()

    struct Flight {
        let vmId: String
        let snapshot: UIView?
        let source: CGRect?
        weak var window: UIWindow?
        let armedAt: Date
    }

    private var armed: Flight?

    /// 发送前调用(输入框文字还在、键盘还没收起)。拿不到输入框也照样登记：届时退化为淡入。
    func arm(vmId: String) {
        discard(armed)
        var snapshot: UIView?
        var source: CGRect?
        let textView = Self.firstResponderTextView()
        let window = textView?.window
        if let textView, let window, !(textView.text ?? "").isEmpty,
           let snap = textView.snapshotView(afterScreenUpdates: false) {
            let frame = textView.convert(textView.bounds, to: window)
            snap.frame = frame
            snap.isUserInteractionEnabled = false
            window.addSubview(snap)
            snapshot = snap
            source = frame
        }
        let flight = Flight(vmId: vmId, snapshot: snapshot, source: source, window: window, armedAt: Date())
        armed = flight
        // 没人认领(发送失败、插入走了别的路)就收掉，快照不能一直挂着。
        DispatchQueue.main.asyncAfter(deadline: .now() + SendFlightPolicy.maxArmAge) { [weak self] in
            guard let self, let current = self.armed, current.armedAt == flight.armedAt else { return }
            self.armed = nil
            self.discard(current)
        }
    }

    /// 消息列表插入新的用户消息时认领(只认这个 view model、而且是刚发的)。
    func claim(vmId: String, now: Date = Date()) -> Flight? {
        guard let flight = armed, flight.vmId == vmId else { return nil }
        armed = nil
        guard SendFlightPolicy.isFresh(armedAt: flight.armedAt, now: now) else {
            discard(flight)
            return nil
        }
        return flight
    }

    /// `cell` 每次调用都重新取:插入是异步的，cell 可能下一帧才有。
    func run(_ flight: Flight, waits: Int = 0, cell: @escaping () -> UICollectionViewCell?) {
        let target = cell()
        let window = flight.window ?? target?.window
        let cellFrame: CGRect? = target.flatMap { c in c.window.map { c.convert(c.bounds, to: $0) } }
        let decision = SendFlightPolicy.decide(source: flight.source, cellFrame: cellFrame,
                                               window: window?.bounds ?? .zero,
                                               reduceMotion: UIAccessibility.isReduceMotionEnabled, waits: waits)
        switch decision {
        case .wait:
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.0 / 60) { [weak self] in
                self?.run(flight, waits: waits + 1, cell: cell)
            }
        case .fadeIn:
            discard(flight)
            if let content = target?.contentView {
                content.alpha = 0
                UIView.animate(withDuration: SendFlightPolicy.fadeDuration) { content.alpha = 1 }
            }
        case .fly(let landing):
            guard let snapshot = flight.snapshot, let content = target?.contentView else {
                discard(flight)
                return
            }
            content.alpha = 0
            let spring = UISpringTimingParameters(mass: 1, stiffness: SendFlightPolicy.springStiffness,
                                                  damping: SendFlightPolicy.springDampingCoefficient,
                                                  initialVelocity: .zero)
            let animator = UIViewPropertyAnimator(duration: 0, timingParameters: spring)
            animator.addAnimations { snapshot.frame = landing }
            animator.addCompletion { _ in
                UIView.animate(withDuration: SendFlightPolicy.fadeDuration, animations: {
                    snapshot.alpha = 0
                    content.alpha = 1
                }, completion: { _ in snapshot.removeFromSuperview() })
            }
            animator.startAnimation()
        }
    }

    private func discard(_ flight: Flight?) {
        guard let snapshot = flight?.snapshot else { return }
        UIView.animate(withDuration: SendFlightPolicy.fadeDuration, animations: { snapshot.alpha = 0 },
                       completion: { _ in snapshot.removeFromSuperview() })
    }

    // MARK: First responder

    private static weak var foundResponder: UIResponder?

    private static func firstResponderTextView() -> UITextView? {
        foundResponder = nil
        UIApplication.shared.sendAction(#selector(UIResponder.leoCaptureFirstResponder(_:)), to: nil, from: nil, for: nil)
        return foundResponder as? UITextView
    }

    fileprivate static func capture(_ responder: UIResponder) { foundResponder = responder }
}

extension UIResponder {
    @objc fileprivate func leoCaptureFirstResponder(_ sender: Any?) {
        MainActor.assumeIsolated { SendFlightAnimator.capture(self) }
    }
}
