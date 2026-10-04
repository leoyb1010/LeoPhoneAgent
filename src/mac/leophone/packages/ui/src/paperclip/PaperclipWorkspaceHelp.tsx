import { Button } from "../components/ui/button.js";
export function PaperclipWorkspaceHelp({
  help,
  recovery,
  hasReceipt,
  closeHelp,
  closeRecovery,
  onRecovery,
}: {
  help: boolean;
  recovery: boolean;
  hasReceipt: boolean;
  closeHelp: () => void;
  closeRecovery: () => void;
  onRecovery: () => void;
}) {
  return (
    <>
      {help && (
        <section
          className="max-h-72 overflow-auto border-b border-border bg-surface p-4"
          aria-label="使用帮助"
        >
          <div className="mx-auto max-w-3xl space-y-2">
            <h2 className="text-ui-lg font-medium">从连接到交付</h2>
            <ol className="list-inside list-decimal space-y-2">
              <li>填写服务器地址，点击“登录服务器”，在独立安全窗口中登录个人账号</li>
              <li>选择有权访问的组织。智能体的模型、工作目录和 CLI 都在服务器端配置</li>
              <li>新建任务时选择智能体，在任务中查看回复、运行日志、审批和成果</li>
              <li>
                网络中断时保留只读快照；恢复网络后刷新。若操作结果未知，点击“核实结果”，不要新建重复任务
              </li>
            </ol>
            <p>Mac 不会替代服务器执行命令。旧本地历史只通过“本地恢复模式”访问，不自动上传或迁移</p>
            <p>任务列表显示最近 100 项；对话显示最近 100 条。服务器返回的原始内容和日志保留原文</p>
            <Button variant="outline" onClick={() => closeHelp()}>
              知道了
            </Button>
          </div>
        </section>
      )}
      {recovery && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="paperclip-recovery-title"
          className="absolute inset-0 z-50 flex items-center justify-center bg-background/90 p-4"
        >
          <section className="w-full max-w-lg space-y-4 rounded-2xl border border-popover-border bg-popover p-6 shadow-lg">
            <h2 id="paperclip-recovery-title" className="text-ui-lg font-medium">
              进入本地恢复模式？
            </h2>
            <p>
              这里保留旧版本地历史和工作区。它与 Paperclip 服务器独立，不会自动上传、迁移或同步任务
            </p>
            {hasReceipt && (
              <p className="text-warning">
                服务器仍有待核实操作，回执会保留。请返回服务器工作区完成核实
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => closeRecovery()}>
                留在服务器工作区
              </Button>
              <Button onClick={onRecovery}>进入本地恢复模式</Button>
            </div>
          </section>
        </div>
      )}
    </>
  );
}
