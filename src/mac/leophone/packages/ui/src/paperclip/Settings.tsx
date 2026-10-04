import { useEffect, useState } from "react";
import { ExternalLink } from "lucide-react";
import type { IPaperclipWorkspace, PaperclipSnapshot } from "@zcode/services";
import type { IPlatformService } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog.js";
import { useDialogFocusReturn } from "./useDialogFocusReturn.js";
export function PaperclipSettings({
  settings,
  onOpenChange,
  snapshot,
  service,
  platform,
  invoke,
  error,
}: {
  settings: boolean;
  onOpenChange: (open: boolean) => void;
  snapshot: PaperclipSnapshot;
  service: IPaperclipWorkspace;
  platform: IPlatformService;
  invoke: (action: () => Promise<void>) => Promise<boolean>;
  error: string | null;
}) {
  const [address, setAddress] = useState(snapshot.origin);
  const focusReturn = useDialogFocusReturn("[data-pc-settings-trigger]");
  useEffect(() => setAddress(snapshot.origin), [snapshot.origin]);
  return (
    <Dialog open={settings} onOpenChange={onOpenChange}>
      <DialogContent
        className="pc-settings-dialog max-h-[85vh] max-w-lg overflow-y-auto p-6"
        {...focusReturn}
      >
        <DialogTitle className="pr-8 text-ui-lg font-semibold">服务器与账号</DialogTitle>
        <DialogDescription>连接你的 Paperclip 团队。服务器任务不会转为本机执行。</DialogDescription>
        {error && (
          <p role="alert" className="text-ui-caption leading-relaxed text-destructive">
            {error}
          </p>
        )}
        <form
          className="mt-2 flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void invoke(() => service.configure(address));
          }}
        >
          <label className="flex flex-col gap-2 text-ui-caption">
            服务器根地址
            <Input
              aria-label="服务器根地址"
              value={address}
              placeholder="https://paperclip.example.com"
              onChange={(event) => setAddress(event.target.value)}
              disabled={snapshot.busy}
            />
          </label>
          <Button type="submit" variant="outline" disabled={snapshot.busy || !address.trim()}>
            保存并连接
          </Button>
        </form>
        {snapshot.origin && (
          <div className="border-t border-border pt-4">
            <p className="mb-3 break-all text-ui-sm text-foreground-subtle">{snapshot.origin}</p>
            <div className="flex flex-wrap items-center gap-2">
              <Button disabled={snapshot.busy} onClick={() => void invoke(() => service.signIn())}>
                {snapshot.user ? "重新登录" : "网页登录"}
              </Button>
              {snapshot.user && (
                <Button
                  variant="outline"
                  disabled={snapshot.busy}
                  onClick={() => void invoke(() => service.signOut())}
                >
                  退出账号
                </Button>
              )}
              <Button variant="ghost" onClick={() => platform.openExternal(snapshot.origin)}>
                <ExternalLink size={14} />
                管理网页
              </Button>
            </div>
          </div>
        )}
        {snapshot.user && (
          <div className="space-y-3 border-t border-border pt-4">
            <p className="break-words text-ui-caption text-foreground-subtle">
              已登录 · {snapshot.user.name || snapshot.user.email}
            </p>
            <label className="flex flex-col gap-2 text-ui-caption">
              当前公司
              <select
                aria-label="设置中的公司"
                className="pc-select"
                value={snapshot.companyId}
                disabled={snapshot.busy}
                onChange={(event) => void invoke(() => service.selectCompany(event.target.value))}
              >
                {snapshot.companies.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            {snapshot.companies.length === 0 && (
              <p className="text-ui-caption text-foreground-subtle">
                当前账号没有可访问的公司，请在管理网页完成设置。
              </p>
            )}
          </div>
        )}
        <div className="flex justify-end">
          <Button onClick={() => onOpenChange(false)}>完成</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
