import type { ReactNode } from "react";
import { cn } from "@/components/lib/utils.js";
import { useZCodeStore } from "@/store/StoreProvider.js";
import { resolveTheme } from "@/useTheme.js";
import type { Theme } from "@/useTheme.js";

interface ThemeHeroPalette {
  panel: string;
  meshBase: string;
  meshLight: string;
  glowPrimary: string;
  glowSecondary: string;
  heading: string;
  description: string;
}

function getThemeHeroPalette(theme: Theme): ThemeHeroPalette {
  switch (theme) {
    case "light":
      return {
        meshBase: "#eff6ff",
        meshLight: "#7dd3fc",
        panel:
          "bg-[linear-gradient(180deg,#eff6ff_0%,#dbeafe_34%,#bfdbfe_100%)] before:absolute before:inset-0 before:content-[''] before:bg-[radial-gradient(circle_at_18%_18%,rgba(255,255,255,0.9),transparent_24%),radial-gradient(circle_at_82%_16%,rgba(125,211,252,0.42),transparent_26%),radial-gradient(circle_at_68%_80%,rgba(96,165,250,0.24),transparent_28%)]",
        glowPrimary: "bg-sky-200/70 mix-blend-screen",
        glowSecondary: "bg-blue-200/70 mix-blend-multiply",
        heading: "text-slate-900",
        description: "text-slate-700/80",
      };
    // [leo] 1.9.0：两套 Zai 主题的欢迎背景改成中性灰阶的极淡渐变，不再有青绿光斑
    // （之前暖白 + 青绿 mesh 和全局的米黄底叠在一起，正是"米黄色奇奇怪怪"的来源之一）。
    case "zai-light":
      return {
        meshBase: "#fafafa",
        meshLight: "#e4e4e7",
        panel: "bg-[linear-gradient(180deg,#ffffff_0%,#fafafa_55%,#f4f4f5_100%)]",
        glowPrimary: "bg-transparent",
        glowSecondary: "bg-transparent",
        heading: "text-[#18181b]",
        description: "text-[#71717a]",
      };
    case "zai-dark":
      return {
        meshBase: "#131315",
        meshLight: "#232326",
        panel: "bg-[linear-gradient(180deg,#18181b_0%,#131315_55%,#0f0f11_100%)]",
        glowPrimary: "bg-transparent",
        glowSecondary: "bg-transparent",
        heading: "text-[#e4e4e7]",
        description: "text-[#a1a1aa]",
      };
    case "dark":
    case "system":
    default:
      return {
        meshBase: "#060816",
        meshLight: "#60a5fa",
        panel:
          "bg-[linear-gradient(180deg,#060816_0%,#0b1333_38%,#12245a_72%,#173474_100%)] before:absolute before:inset-0 before:content-[''] before:bg-[radial-gradient(circle_at_16%_20%,rgba(165,243,252,0.14),transparent_22%),radial-gradient(circle_at_82%_14%,rgba(96,165,250,0.18),transparent_24%),radial-gradient(circle_at_68%_84%,rgba(56,189,248,0.14),transparent_28%),linear-gradient(180deg,rgba(255,255,255,0.04),rgba(255,255,255,0))]",
        glowPrimary: "bg-cyan-300/22 mix-blend-screen",
        glowSecondary: "bg-blue-400/18 mix-blend-screen",
        heading: "text-slate-50",
        description: "text-slate-200/72",
      };
  }
}

function useResolvedThemeHeroPalette(): ThemeHeroPalette {
  const theme = useZCodeStore((state) => state.theme);
  // [leo] 跟随系统时全局用的是 theme-zai-*,欢迎背景也要落到 Zai 那两套,否则还是智谱蓝。
  const resolvedTheme =
    theme === "system" ? (resolveTheme(theme) === "dark" ? "zai-dark" : "zai-light") : theme;

  return getThemeHeroPalette(resolvedTheme);
}

export function ThemeHeroVisual(props: {
  className?: string;
  contentClassName?: string;
  children?: ReactNode;
}) {
  const palette = useResolvedThemeHeroPalette();

  return (
    <div className={cn("relative overflow-hidden", palette.panel, props.className)}>
      <div
        className={cn(
          "pointer-events-none absolute left-[-12%] top-[18%] h-[42rem] w-[42rem] rounded-full blur-3xl",
          palette.glowPrimary,
        )}
      />
      <div
        className={cn(
          "pointer-events-none absolute right-[-18%] bottom-[-14%] h-[36rem] w-[36rem] rounded-full blur-3xl",
          palette.glowSecondary,
        )}
      />
      {props.children ? (
        <div className={cn("relative z-10", props.contentClassName)}>{props.children}</div>
      ) : null}
    </div>
  );
}
