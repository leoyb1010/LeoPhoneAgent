
## 发版铁律(用户指令,长期生效)
- iOS 每次安装到真机的发版,无论改动大小:必须 bump 版本号(MARKETING_VERSION 或 CURRENT_PROJECT_VERSION),在 ReleaseNotesView.swift 的 LeoReleaseNotes.all 加对应条目,保证首启弹出"本次更新"。
- Mac 桌面端同理:resources/release-notes 下加对应版本 JSON 并更新 index。
