//
//  ReplyShareCard.swift
//  MinisApp
//
//  [T-share-card] Batch C: "share" produces a designed image card
//  (question + answer excerpt + date + app badge) rendered with
//  ImageRenderer — the WeChat-friendly form of a reply. Plain-text
//  sharing stays available next to it.
//

import SwiftUI
import UIKit

/// The card itself. Fixed width; height follows content. Rendered
/// off-screen at 3x, never mounted in the live hierarchy.
struct ReplyShareCardView: View {
    let question: String?
    let answer: String
    let date: Date

    private static let dateFormat: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd HH:mm"
        return formatter
    }()

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            if let question, !question.isEmpty {
                HStack(alignment: .top, spacing: 8) {
                    Image(systemName: "person.circle.fill")
                        .font(.system(size: 18))
                        .foregroundStyle(.secondary)
                    Text(question)
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(.primary)
                }
            }

            Rectangle()
                .fill(LinearGradient(colors: [Color.accentColor, Color.accentColor.opacity(0.2)],
                                     startPoint: .leading, endPoint: .trailing))
                .frame(height: 2)
                .clipShape(Capsule())

            Text(answer)
                .font(.system(size: 15))
                .foregroundStyle(.primary.opacity(0.9))
                .lineSpacing(4)
                .fixedSize(horizontal: false, vertical: true)

            HStack {
                Label("LeoPhoneAgent", systemImage: "sparkles")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(Color.accentColor)
                Spacer()
                Text(Self.dateFormat.string(from: date))
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
            }
        }
        .padding(24)
        .frame(width: 420, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 20, style: .continuous)
                .fill(Color(uiColor: .systemBackground))
        )
        .padding(16)
        .background(
            LinearGradient(colors: [Color.accentColor.opacity(0.25), Color.accentColor.opacity(0.05)],
                           startPoint: .topLeading, endPoint: .bottomTrailing)
        )
    }
}

enum ReplyShareCardRenderer {
    /// Render the card to a PNG in tmp and hand back its URL (nil on failure).
    /// Excerpts are capped so a 100KB reply still makes a readable card.
    @MainActor
    static func renderToFile(question: String?, answer: String, date: Date = Date()) -> URL? {
        let trimmedQuestion = question.map { String($0.prefix(140)) }
        var excerpt = String(answer.prefix(900))
        if answer.count > 900 { excerpt += " …" }
        let view = ReplyShareCardView(question: trimmedQuestion, answer: excerpt, date: date)
        let renderer = ImageRenderer(content: view)
        renderer.scale = 3
        guard let image = renderer.uiImage, let data = image.pngData() else { return nil }
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("reply-card-\(Int(date.timeIntervalSince1970)).png")
        do {
            try data.write(to: url)
            return url
        } catch {
            return nil
        }
    }
}
