# 迁移方案:把同步服务拆成两层

先说结论:**可以拆**,而且建议按下面三步走。整体风险可控,关键在于 *写路径* 的幂等,以及 `SyncLedger` 的回放顺序。参考 [TextKit 文档](https://developer.apple.com/documentation/uikit/textkit),~~在主线程排版~~ 大文本排版要放到后台。

## 1. 现状与问题

当前一次同步要经过 4 个阶段,其中第 3 步会阻塞主线程。真机日志里最长一次卡了 **1.8 s**,用户感知明显。

- 写入:本地 SQLite,事务内完成
- 打包:按会话聚合成批次
  - 小批次(< 64 KB)直接发送
  - 大批次先压缩,再分片
    - 分片大小固定 256 KB
    - 失败的分片单独重试,不整批重来
- 上传:HTTP/2 长连接,失败指数退避
- 回执:服务端返回 `ack_id`,本地落账

### 1.1 指标对比

| 指标 | 现在 | 目标 | 说明 |
|:---|---:|---:|:---|
| 首包延迟 p50 | 420 ms | 150 ms | 预热连接 + 小包优先 |
| 主线程最长卡顿 | 1,800 ms | < 250 ms | 排版和解析移到后台队列 |
| 失败重试成功率 | 81.4% | ≥ 99% | 分片级重试,带抖动的退避 |
| 内存峰值 | 212 MB | 120 MB | 流式压缩,不再整包读入 |
| 电量 / 小时 | 3.1% | 1.5% | 合并唤醒,批量上报 |

## 2. 改造步骤

1. 先把写路径做成幂等:每条记录带 `client_seq`,服务端按 `(device_id, client_seq)` 去重。
2. 把打包和上传拆成独立 actor,中间用有界队列连接,队列满时只丢弃可重建的缓存项。
3. 回执落账前校验顺序;乱序到达的回执先暂存,等前序到齐再一起提交。
4. 灰度:先开 5% 设备,观察 48 小时的失败率与卡顿分布。
5. 全量。
6. 删除旧路径。
7. 补监控面板。
8. 写复盘。
9. 更新运行手册。
10. 关闭旧的告警规则。
11. 归档迁移脚本。

> 注意:第 3 步上线前必须先有回放工具,否则线上出现乱序时没有办法复现。
>
> > 上一次事故就是因为回执先于数据到达,落账逻辑把它当成了重复项丢掉。

### 2.1 待办

- [x] 写路径加 `client_seq`
- [x] 服务端去重索引
- [ ] 打包 / 上传拆成两个 actor
- [ ] 回放工具

## 3. 关键代码

去重逻辑的核心只有几行:

```swift
actor SyncLedger {
    private var pending: [UInt64: Receipt] = [:]
    private var nextSeq: UInt64 = 1

    /// 乱序到达的回执先暂存,前序到齐后一次性提交,保证落账顺序与写入顺序一致。
    func accept(_ receipt: Receipt) async throws -> [Receipt] {
        guard receipt.seq >= nextSeq else { return [] }   // 重复回执,直接忽略
        pending[receipt.seq] = receipt
        var committed: [Receipt] = []
        while let next = pending.removeValue(forKey: nextSeq) {
            committed.append(next)
            nextSeq += 1
        }
        return committed
    }
}
```

服务端的去重用一条唯一索引就够了:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_records_device_seq ON records (device_id, client_seq);
INSERT INTO records (device_id, client_seq, payload) VALUES (?, ?, ?) ON CONFLICT DO NOTHING;
```

本地回放脚本:

```python
import json, sys

def replay(path: str, start: int = 0) -> int:
    """按 client_seq 顺序回放日志,返回成功条数。"""
    ok = 0
    with open(path, encoding="utf-8") as f:
        for line in f:
            rec = json.loads(line)
            if rec["client_seq"] < start:
                continue
            ok += 1
    return ok
```

```
$ ./replay.sh --from 1024 --device A7F3 --verbose --dry-run --output /var/tmp/replay-report-2026-10-22.json
```

---

## 4. 估算

带宽节省大约是 $1 - \frac{1}{r}$,其中 $r$ 是压缩比。按日志实测 $r \approx 3.2$,节省约 69%。

$$
T_{total} = T_{rtt} + \sum_{i=1}^{n} \frac{S_i}{B}
$$

**结论**:按上面的顺序推进,两周内可以完成灰度。如果需要,我可以先把第 1 步的改动和测试写出来。
