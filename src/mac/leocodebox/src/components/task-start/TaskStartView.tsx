import { Command, Monitor, ShieldCheck } from 'lucide-react';

import type { Project } from '../../types/app';

type TaskStartViewProps = {
  project: Project | null;
};

/**
 * The quiet canvas underneath the single Task Dock.
 * It deliberately has no second prompt, dashboard cards, or module launchers.
 */
export default function TaskStartView({ project }: TaskStartViewProps) {
  return (
    <main className="flex h-full min-h-0 items-center justify-center overflow-y-auto px-6 py-10">
      <section className="wb-anim-entry w-full max-w-[760px]" aria-labelledby="task-start-title">
        <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.2em] text-primary">
          新任务
        </p>
        <h1 id="task-start-title" className="mt-3 max-w-[680px] text-balance text-[38px] font-semibold leading-[1.12] tracking-[-0.035em] text-foreground">
          选好执行位置，然后直接说要完成什么。
        </h1>
        <p className="mt-4 max-w-[620px] text-sm leading-6 text-muted-foreground">
          上方任务坞是唯一入口。Agent、项目、设备、权限和推理档会在创建会话时一起锁定，后续回复只在会话自己的输入框继续。
        </p>

        <div className="mt-8 divide-y divide-border/80 border-y border-border/80">
          <div className="flex items-center gap-4 py-4">
            <Command className="h-4 w-4 flex-none text-primary" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-foreground">当前项目</p>
              <p className="truncate font-mono text-[11px] text-muted-foreground">
                {project?.fullPath || '尚未选择；点击任务坞里的“选项目”继续'}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-4 py-4">
            <Monitor className="h-4 w-4 flex-none text-primary" />
            <div>
              <p className="text-sm font-medium text-foreground">本机或远程</p>
              <p className="text-[11px] text-muted-foreground">远程任务沿用目标 Mac 的权限与运行环境，失败不会伪装成已提交。</p>
            </div>
          </div>
          <div className="flex items-center gap-4 py-4">
            <ShieldCheck className="h-4 w-4 flex-none text-primary" />
            <div>
              <p className="text-sm font-medium text-foreground">执行前就确定边界</p>
              <p className="text-[11px] text-muted-foreground">权限、Thinking 和 Provider 都随新会话保存；高风险动作仍会单独请求确认。</p>
            </div>
          </div>
        </div>

        <p className="mt-6 font-mono text-[10px] text-wb-faint">
          ⌘N 新任务 · ⌘K 查找与导航 · ⌘, 设置
        </p>
      </section>
    </main>
  );
}
