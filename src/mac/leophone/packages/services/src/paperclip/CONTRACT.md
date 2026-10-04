# Paperclip 客户端契约

服务器是唯一业务状态源；客户端只持有读取投影、generation 和 mutation receipt。身份是 origin/user/company，无文件 cwd。改变身份即撤销旧读取的发布权；结果未知不能当成失败自动重发。创建去重键的官方保留时间为 7 天。UI 的 UUID 草稿保持原正文及首次提交时间，过期或无时间的创建重试被拒绝。下载来源由当前任务的新附件清单确认，Main 再验证人类身份并执行另存为。没有本机执行 fallback。
