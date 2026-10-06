//
//  SyncConflictPolicy.swift
//  MinisApp
//
//  CloudKit 保存冲突(serverRecordChanged)的处理:按记录时间做后写者胜,与各类型合并器同一规则
//  (本地时间 >= 远端就保留本地)。
//
//  以前传输层把本地每个字段原样盖到服务器的新版本上、立即重发,并用成功结果覆盖掉冲突结果:
//  SyncCore 的合并从没生效,另一台设备同时做的修改(例如重命名会话)被直接抹掉。
//  现在:服务器更新 → 本地已由合并器吸收服务器内容,这一版本地快照作废(确认票据,不再上传);
//  本地更新 → 保留票据,下一轮在服务器最新的系统字段(etag)上重发本地内容。
//

import Foundation

enum SyncConflictPolicy {
    enum Resolution: Equatable, Sendable {
        /// 本地这一版更新(或同时):在服务器最新版本上重发。
        case resendLocal
        /// 服务器那一版更新:接受服务器,本地这版快照不再上传。
        case acceptServer
    }

    static func resolve(localUpdatedAt: Date, serverUpdatedAt: Date) -> Resolution {
        serverUpdatedAt > localUpdatedAt ? .acceptServer : .resendLocal
    }
}
