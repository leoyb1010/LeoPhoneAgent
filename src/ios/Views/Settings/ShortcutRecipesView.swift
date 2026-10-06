//
//  ShortcutRecipesView.swift
//  MinisApp
//
//  [C10] 设置 › Agent › 快捷指令配方:每个配方一张卡,用途、触发器、
//  一键添加链接(还没有时不显示)和三步建自动化。
//

import SwiftUI

struct ShortcutRecipesView: View {
    @Environment(\.openURL) private var openURL

    var body: some View {
        List {
            Section {
                Text("把 LeoBot 的动作接到系统自动化上：到家、上车、按一下按钮，事情就自己发生。每个配方照下面三步做，一分钟内建好。")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                Button {
                    if let url = URL(string: "shortcuts://") { openURL(url) }
                } label: {
                    Label("打开快捷指令 App", systemImage: "square.on.square")
                }
            }
            ForEach(ShortcutRecipes.all) { recipe in
                Section {
                    recipeCard(recipe)
                } header: {
                    Label(recipe.title, systemImage: recipe.symbolName)
                }
            }
        }
        .navigationTitle("快捷指令配方")
        .navigationBarTitleDisplayMode(.inline)
    }

    @ViewBuilder
    private func recipeCard(_ recipe: ShortcutRecipe) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(recipe.purpose)
                .font(.subheadline)
            HStack(spacing: 6) {
                Label(recipe.trigger, systemImage: "bolt.badge.clock")
                Text("·").foregroundStyle(.tertiary)
                Text(recipe.action)
            }
            .font(.caption)
            .foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 6) {
                ForEach(Array(recipe.steps.enumerated()), id: \.offset) { index, step in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text("\(index + 1)")
                            .font(.caption.weight(.semibold).monospacedDigit())
                            .foregroundStyle(.white)
                            .frame(width: 18, height: 18)
                            .background(Circle().fill(Color.accentColor))
                        Text(step)
                            .font(.footnote)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
        }
        .padding(.vertical, 4)
        if let url = recipe.shareURL {
            Button {
                openURL(url)
            } label: {
                Label("一键添加到快捷指令", systemImage: "plus.circle.fill")
            }
        }
        // 还没有一键添加的链接时不显示占位:按上面的步骤手动建即可。
    }
}
