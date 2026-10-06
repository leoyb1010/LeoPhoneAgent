import SwiftUI

// [F5] 首页情境条:会话列表最上面一小块,回答"接着做什么"。
//
// - 专注收尾卡:情境层(D)留下的 24 小时内的专注总结,点一下收起。
// - 继续上次:最近一个没做完 / 被中断的会话;情境层 12 小时内置顶过的会话优先。
// - 今日:今天动过的会话数、待处理数(与顶部提示条同一份数据)。
// - 安静收件箱:一键只看未分组的会话,再点回到全部;安静任务 / 情境触发的未读结果数挂在上面。
//
// 没内容的项不显示,全空时整条不出现(由 ContentView 判断 snapshot.isEmpty)。
// 和 HomeComposer 一样只用具体类型,不加深 ContentView 的类型链。

struct HomeContextStrip: View {
    let snapshot: HomeContextSnapshot
    let onResume: (String) -> Void
    let onToggleInbox: () -> Void
    let onDismissFocus: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: LeoTheme.Spacing.xs) {
            if let focus = snapshot.focus {
                focusCard(focus)
            }
            if let resume = snapshot.resume {
                resumeRow(resume)
            }
            if snapshot.showsToday || snapshot.showsInboxToggle {
                HStack(spacing: LeoTheme.Spacing.xs) {
                    if snapshot.showsToday { todayChip }
                    if snapshot.showsInboxToggle { inboxChip }
                    Spacer(minLength: 0)
                }
            }
        }
        // contain:容器自己的标识不覆盖里面各按钮的 home.context-* 标识。
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("home.context-strip")
    }

    private func focusCard(_ focus: HomeFocusWrapUp) -> some View {
        Button(action: onDismissFocus) {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Image(systemName: "checkmark.seal")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(LeoTheme.ColorToken.accent)
                    Text(focus.title.isEmpty ? "专注收尾" : focus.title)
                        .font(.subheadline.weight(.semibold))
                        .lineLimit(1)
                    Spacer(minLength: 0)
                    Image(systemName: "xmark")
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(.tertiary)
                }
                Text(focusSummaryLine(focus))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            .padding(.horizontal, LeoTheme.Spacing.sm)
            .padding(.vertical, 10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(LeoTheme.ColorToken.accent.opacity(0.08),
                        in: RoundedRectangle(cornerRadius: LeoTheme.Radius.surface, style: .continuous))
            .contentShape(RoundedRectangle(cornerRadius: LeoTheme.Radius.surface, style: .continuous))
        }
        .buttonStyle(.plain)
        .accessibilityHint(Text("轻点收起这张卡片"))
        .accessibilityIdentifier("home.context-focus")
    }

    private func focusSummaryLine(_ focus: HomeFocusWrapUp) -> String {
        var parts: [String] = []
        if !focus.done.isEmpty { parts.append("完成 \(focus.done.count) 项") }
        if let next = focus.pending.first {
            parts.append(focus.pending.count > 1 ? "待办 \(focus.pending.count) 项:\(next) 等" : "待办:\(next)")
        }
        return parts.isEmpty ? "专注时段已结束" : parts.joined(separator: " · ")
    }

    private func resumeRow(_ resume: HomeContextSnapshot.Resume) -> some View {
        Button { onResume(resume.sessionId) } label: {
            HStack(spacing: 10) {
                Image(systemName: resume.pinned ? "pin.fill" : "arrow.uturn.forward.circle.fill")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(LeoTheme.ColorToken.accent)
                    .frame(width: 22)
                VStack(alignment: .leading, spacing: 1) {
                    Text("继续上次")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                    Text(resume.title)
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(.primary)
                        .lineLimit(1)
                }
                Spacer(minLength: LeoTheme.Spacing.xs)
                Text(resume.updatedAt, format: .relative(presentation: .named))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                Image(systemName: "chevron.right")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.tertiary)
            }
            .padding(.horizontal, LeoTheme.Spacing.sm)
            .frame(minHeight: 52)
            .background(LeoTheme.ColorToken.surface,
                        in: RoundedRectangle(cornerRadius: LeoTheme.Radius.surface, style: .continuous))
            .contentShape(RoundedRectangle(cornerRadius: LeoTheme.Radius.surface, style: .continuous))
        }
        .buttonStyle(.plain)
        .hoverEffect(.highlight)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(Text("继续上次:\(resume.title)"))
        .accessibilityIdentifier("home.context-resume")
    }

    private var todayChip: some View {
        HStack(spacing: 5) {
            Image(systemName: "sun.max")
                .font(.caption.weight(.semibold))
            Text(todayText)
                .font(.footnote.weight(.medium))
                .monospacedDigit()
                .lineLimit(1)
        }
        .foregroundStyle(.secondary)
        .padding(.horizontal, 10)
        .frame(minHeight: 32)
        .background(Color.primary.opacity(0.06), in: Capsule())
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("home.context-today")
    }

    private var todayText: String {
        if snapshot.pendingCount > 0 {
            return "今日 \(snapshot.todaySessions) 个会话 · \(snapshot.pendingCount) 待处理"
        }
        return "今日 \(snapshot.todaySessions) 个会话"
    }

    private var inboxChip: some View {
        Button(action: onToggleInbox) {
            HStack(spacing: 5) {
                Image(systemName: snapshot.inboxActive ? "tray.full.fill" : "tray")
                    .font(.caption.weight(.semibold))
                Text(snapshot.inboxActive ? "收件箱 · 看全部" : "安静收件箱")
                    .font(.footnote.weight(.semibold))
                    .lineLimit(1)
                if snapshot.quietUnread > 0 {
                    Text("\(snapshot.quietUnread)")
                        .font(.caption2.weight(.bold))
                        .monospacedDigit()
                        .foregroundStyle(.white)
                        .padding(.horizontal, 6)
                        .frame(minHeight: 18)
                        .background(LeoTheme.ColorToken.accent, in: Capsule())
                        .accessibilityLabel(Text("\(snapshot.quietUnread) 条未读"))
                }
            }
            .foregroundStyle(snapshot.inboxActive ? LeoTheme.ColorToken.accent : Color.primary)
            .padding(.horizontal, 10)
            .frame(minHeight: 32)
            .background(snapshot.inboxActive ? LeoTheme.ColorToken.accent.opacity(0.14) : Color.primary.opacity(0.06),
                        in: Capsule())
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityHint(Text(snapshot.inboxActive ? "回到全部会话" : "只看未分组的会话"))
        .accessibilityAddTraits(snapshot.inboxActive ? .isSelected : [])
        .accessibilityIdentifier("home.context-inbox")
    }
}
