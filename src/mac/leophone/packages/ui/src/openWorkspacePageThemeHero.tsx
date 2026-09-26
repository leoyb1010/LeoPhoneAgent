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
    // [leo] 两套 Zai 主题的欢迎背景从智谱蓝换成 Leo 的暖白 / 暖石墨 + 青绿(与鸿蒙端同一个青绿)。
    case "zai-light":
      return {
        meshBase: "#f7f6f3",
        meshLight: "#8fd6d0",
        panel:
          "bg-[linear-gradient(180deg,#fcfbf9_0%,#f7f6f3_42%,#e6f2f0_100%)] before:absolute before:inset-0 before:content-[''] before:bg-[radial-gradient(circle_at_18%_20%,rgba(255,255,255,0.9),transparent_24%),radial-gradient(circle_at_82%_14%,rgba(46,139,139,0.14),transparent_26%),radial-gradient(circle_at_70%_84%,rgba(143,214,208,0.2),transparent_30%)]",
        glowPrimary: "bg-[#8FD6D0]/40 mix-blend-multiply",
        glowSecondary: "bg-[#E6F2F0]/80 mix-blend-multiply",
        heading: "text-[#1D1B19]",
        description: "text-[#5F5A54]",
      };
    case "zai-dark":
      return {
        meshBase: "#10292a",
        meshLight: "#4dd9d9",
        panel:
          "bg-[linear-gradient(180deg,#151413_0%,#1b1a18_46%,#0f2627_100%)] before:absolute before:inset-0 before:content-[''] before:bg-[radial-gradient(circle_at_18%_18%,rgba(77,217,217,0.12),transparent_24%),radial-gradient(circle_at_82%_12%,rgba(168,241,226,0.12),transparent_26%),radial-gradient(circle_at_66%_84%,rgba(77,217,217,0.1),transparent_28%)]",
        glowPrimary: "bg-[#4DD9D9]/14 mix-blend-screen",
        glowSecondary: "bg-[#A8F1E2]/10 mix-blend-screen",
        heading: "text-[#EFEBE5]",
        description: "text-[#A8A29B]",
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

export function useResolvedThemeHeroPalette(): ThemeHeroPalette {
  const theme = useZCodeStore((state) => state.theme);
  const resolvedTheme =
    theme === "system" ? (resolveTheme(theme) === "dark" ? "dark" : "light") : theme;

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
