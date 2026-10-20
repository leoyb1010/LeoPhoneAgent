//
//  HomeMacScreenCover.swift
//  MinisApp
//
//  [up-home] 首页「进行中」旁的「看屏」:不用先开一个 Mac 任务也能看那台 Mac 的屏幕。
//  直接复用任务页的全屏查看(视频优先、截图兜底、可操控)。
//

import SwiftUI

struct HomeMacScreenTarget: Identifiable {
    let host: GatewayHost
    let client: LeoAgentClient
    var id: String { host.id }
}

struct HomeMacScreenCover: View {
    let target: HomeMacScreenTarget
    @StateObject private var poller = MacScreenPoller()

    var body: some View {
        MacScreenFullscreen(poller: poller, hostName: target.host.name)
            .onAppear { poller.client = target.client }
    }
}
