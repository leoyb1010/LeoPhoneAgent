//
//  HarnessInteractionCards.swift
//  MinisApp
//
//  [remote-ctl-ios] Mac 会话页里跟模型来回的几样东西:模型提问(AskUserQuestion)卡、
//  输入框上方的图片附件条与压缩。数据与请求体是纯函数(HarnessRemoteControls),驱动是 HarnessSessionDriver。
//

import SwiftUI
import UIKit
import PhotosUI

// MARK: - 模型提问卡

struct HarnessQuestionCard: View {
    let request: HarnessQuestionRequest
    let onSubmit: ([HarnessQuestionAnswer]) -> Void
    let onDecline: () -> Void
    @State private var draft = HarnessQuestionDraft()

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                Image(systemName: "questionmark.bubble.fill").foregroundStyle(Color.accentColor)
                Text("Mac 上的 agent 在问你").font(.system(size: 15, weight: .semibold))
                Spacer()
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    ForEach(Array(request.questions.enumerated()), id: \.offset) { index, question in
                        questionView(question, index: index)
                    }
                }
            }
            .frame(maxHeight: 340)
            .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 8) {
                Button {
                    LeoHaptics.impact(.medium)
                    onDecline()
                } label: {
                    Text("跳过").frame(maxWidth: .infinity, minHeight: 24).padding(.vertical, 6)
                }
                .buttonStyle(.bordered)
                Button {
                    LeoHaptics.impact(.light)
                    onSubmit(draft.answers(for: request))
                } label: {
                    Text("提交").frame(maxWidth: .infinity, minHeight: 24).padding(.vertical, 6)
                }
                .buttonStyle(.borderedProminent)
                .disabled(!draft.canSubmit(request))
            }
            .font(.system(size: 14, weight: .medium))
        }
        .padding(14)
        .background(Color.accentColor.opacity(0.07))
        .overlay(Rectangle().frame(height: 1).foregroundStyle(Color.accentColor.opacity(0.3)), alignment: .top)
        .accessibilityIdentifier("harness.question")
    }

    @ViewBuilder
    private func questionView(_ question: HarnessQuestion, index: Int) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            if let header = question.header {
                Text(header).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
            }
            Text(question.question).font(.system(size: 14)).textSelection(.enabled)
            if question.multiSelect {
                Text("可多选").font(.caption2).foregroundStyle(.secondary)
            }
            ForEach(question.options, id: \.self) { option in
                let selected = draft.isSelected(option.label, question: index)
                Button {
                    LeoHaptics.selection()
                    draft.toggle(option.label, question: index, multiSelect: question.multiSelect)
                } label: {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Image(systemName: question.multiSelect
                              ? (selected ? "checkmark.square.fill" : "square")
                              : (selected ? "largecircle.fill.circle" : "circle"))
                            .foregroundStyle(selected ? Color.accentColor : Color.secondary)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(option.label).font(.system(size: 14, weight: .medium)).foregroundStyle(.primary)
                            if let description = option.description {
                                Text(description).font(.caption).foregroundStyle(.secondary)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, 10).padding(.vertical, 8)
                    .background(selected ? Color.accentColor.opacity(0.12) : Color.secondary.opacity(0.08),
                                in: RoundedRectangle(cornerRadius: 8))
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(selected ? .isSelected : [])
            }
            TextField("其他想法（可选）", text: Binding(
                get: { draft.text[index] ?? "" },
                set: { draft.text[index] = $0 }), axis: .vertical)
                .lineLimit(1...3)
                .font(.system(size: 14))
                .padding(.horizontal, 10).padding(.vertical, 7)
                .background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
        }
    }
}

// MARK: - 计划审批的正文

/// `ExitPlanMode` 审批卡里的计划:可滚动、可选中,按 Markdown 渲染(和会话正文同一个渲染器)。
struct HarnessPlanBody: View {
    let text: String

    var body: some View {
        ScrollView {
            SelectableMarkdownView(markdown: text)
                .fixedSize(horizontal: false, vertical: true)
                .modifier(MinisOpenURLHandler())
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(10)
        }
        .frame(maxHeight: 320)
        .fixedSize(horizontal: false, vertical: true)
        .background(Color(.tertiarySystemFill), in: RoundedRectangle(cornerRadius: 6))
    }
}

// MARK: - 图片附件

/// 输入框里待发的一张图:附件本体 + 预先解好的缩略图(每次重绘都解一遍 JPEG 太费)。
struct HarnessComposerImage: Identifiable {
    let attachment: HarnessAttachment
    let thumbnail: UIImage
    var id: UUID { attachment.id }
}

enum HarnessImageEncoder {
    /// 解码 → 长边不超过 2048 → JPEG;超过 5 MB 就降质量 / 缩小重来。解不了返回 nil。
    static func encode(_ data: Data, index: Int) -> HarnessComposerImage? {
        guard let image = UIImage(data: data) else { return nil }
        var side: CGFloat = 2048
        var quality: CGFloat = 0.8
        for _ in 0..<8 {
            let scaled = downscale(image, maxSide: side)
            if let jpeg = scaled.jpegData(compressionQuality: quality), jpeg.count <= HarnessAttachment.maxBytes {
                let attachment = HarnessAttachment(name: "photo-\(index).jpg", mime: "image/jpeg", data: jpeg)
                return HarnessComposerImage(attachment: attachment, thumbnail: downscale(scaled, maxSide: 160))
            }
            if quality > 0.5 { quality -= 0.15 } else { side *= 0.75 }
        }
        return nil
    }

    private static func downscale(_ image: UIImage, maxSide: CGFloat) -> UIImage {
        let size = image.size
        let longest = max(size.width, size.height)
        guard longest > maxSide, longest > 0 else { return image }
        let scale = maxSide / longest
        let target = CGSize(width: (size.width * scale).rounded(), height: (size.height * scale).rounded())
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1
        return UIGraphicsImageRenderer(size: target, format: format).image { _ in
            image.draw(in: CGRect(origin: .zero, size: target))
        }
    }
}

/// 输入框上方的缩略图条,每张带删除按钮。
struct HarnessAttachmentStrip: View {
    @Binding var images: [HarnessComposerImage]

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(images) { image in
                    Image(uiImage: image.thumbnail)
                        .resizable()
                        .scaledToFill()
                        .frame(width: 56, height: 56)
                        .clipShape(RoundedRectangle(cornerRadius: 8))
                        .overlay(alignment: .topTrailing) {
                            Button {
                                LeoHaptics.selection()
                                images.removeAll { $0.id == image.id }
                            } label: {
                                Image(systemName: "xmark.circle.fill")
                                    .font(.system(size: 18))
                                    .symbolRenderingMode(.palette)
                                    .foregroundStyle(.white, .black.opacity(0.6))
                            }
                            .buttonStyle(.plain)
                            .offset(x: 6, y: -6)
                            .accessibilityLabel(Text("移除图片"))
                        }
                }
            }
            .padding(.horizontal, 14).padding(.top, 10).padding(.bottom, 2)
        }
    }
}

/// 输入框左边的相册按钮。选好的图压成 JPEG(≤ 5 MB)追加进 `images`,最多 4 张。
struct HarnessPhotoButton: View {
    @Binding var images: [HarnessComposerImage]
    @State private var selection: [PhotosPickerItem] = []
    @State private var loading = false

    var body: some View {
        PhotosPicker(selection: $selection,
                     maxSelectionCount: max(1, HarnessAttachment.remainingSlots(current: images.count)),
                     matching: .images) {
            Group {
                if loading {
                    ProgressView().controlSize(.small)
                } else {
                    Image(systemName: "photo.on.rectangle.angled").font(.system(size: 20))
                }
            }
            .frame(width: 34, height: 34)
        }
        .disabled(loading || HarnessAttachment.remainingSlots(current: images.count) == 0)
        .accessibilityLabel(Text("添加图片"))
        .accessibilityIdentifier("harness.attachPhoto")
        .onChange(of: selection) { _, items in
            guard !items.isEmpty else { return }
            selection = []
            load(items)
        }
    }

    private func load(_ items: [PhotosPickerItem]) {
        loading = true
        Task {
            var added: [HarnessComposerImage] = []
            let base = images.count
            for item in items.prefix(HarnessAttachment.remainingSlots(current: base)) {
                guard let data = try? await item.loadTransferable(type: Data.self) else { continue }
                let index = base + added.count + 1
                if let encoded = await Task.detached(priority: .userInitiated, operation: {
                    HarnessImageEncoder.encode(data, index: index)
                }).value {
                    added.append(encoded)
                }
            }
            images.append(contentsOf: added.prefix(HarnessAttachment.remainingSlots(current: images.count)))
            loading = false
        }
    }
}
