import { useState, type ReactNode } from "react";
import { Blocks } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { pluginInitial } from "@/lib/pluginFallbackIcon.js";
import { resolvePluginIconSource } from "@/lib/pluginIconSource.js";

/** Plugin 原始图标；支持官方内置图标与 HTTPS，缺失或失败时使用调用方兜底，默认回退 Blocks。 */
export function PluginIcon({
  src,
  pluginId,
  name,
  className,
  iconClassName,
  fallbackIcon,
}: {
  src?: string;
  pluginId?: string;
  /** [leo] 传入时，无图标插件显示名称首字，而不是统一的积木。 */
  name?: string;
  className?: string;
  iconClassName?: string;
  fallbackIcon?: ReactNode;
}) {
  const [imageFailed, setImageFailed] = useState(false);
  const resolvedSrc = resolvePluginIconSource(pluginId, src);
  const showImage = Boolean(resolvedSrc) && !imageFailed;
  const initial = pluginInitial(name);
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex shrink-0 select-none items-center justify-center rounded-xl bg-surface",
        !showImage && "text-foreground-subtle",
        className,
      )}
    >
      {showImage ? (
        <img
          src={resolvedSrc}
          alt=""
          draggable={false}
          className="h-2/3 w-2/3 object-contain"
          onError={() => setImageFailed(true)}
        />
      ) : fallbackIcon ? (
        fallbackIcon
      ) : initial ? (
        <span className="text-[13px] font-semibold leading-none">{initial}</span>
      ) : (
        <Blocks className={cn("size-4", iconClassName)} />
      )}
    </span>
  );
}
