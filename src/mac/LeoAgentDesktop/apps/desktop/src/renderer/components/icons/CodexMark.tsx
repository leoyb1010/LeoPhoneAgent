/**
 * CodexMark —— OpenAI Codex 官方 CLI mark(多瓣圆花 + `>_` 终端提示符),双轨:
 *  - variant="mono"(默认):描边花形轮廓(stroke)+ 增重的 `>_`(fill+stroke),
 *    currentColor 单色,跟随主题/状态染色;小尺寸用更粗描边并整体光学放大,
 *    与实心 Claude 像素脸保持视觉重量一致;
 *  - variant="brand":官方彩色版——实心花形剪影填蓝紫渐变
 *    (#b1a7ff → #7a9dff → #3941ff),`>_` 为镂空透底(官方资产的白色圆角
 *    方底已去掉,内联场景透明底)。固定品牌色跨主题一致(语义豁免——同
 *    docs/design-rules/cindy-design-system.md Toast 三色逻辑);渐变 id 用 useId 派生防同屏多实例冲突。
 *
 * 2026-07-20(产品):形状统一用 Codex CLI glyph(比旧 OpenAI 六瓣花结辨识度
 * 高);单色为默认,彩色按场景显式启用。两个 variant 来自同一官方 path 的拆分:
 * mono 把轮廓子路径改 fill=none + stroke,`>_` 子路径保持 fill——原资产里
 * dash 子路径是相对坐标(接在轮廓闭环终点 = 起点 9.064,3.344 之后),拆分时已
 * 换算为绝对坐标 M12.546 13.909(逐段增量累加验证)。
 */

import { useId } from 'react';

/** 花形轮廓(闭环子路径)。mono 描边 / brand 与 `>_` 合并填渐变。 */
const FLOWER_OUTLINE =
  'M9.064 3.344a4.6 4.6 0 0 1 2.285-.312q1.5.173 2.673 1.275.016.015.037.021a.1.1 0 0 0 .043 0 4.55 4.55 0 0 1 3.046.275l.047.022.116.057a4.58 4.58 0 0 1 2.188 2.399q.313.765.315 1.595a4.2 4.2 0 0 1-.134 1.223.12.12 0 0 0 .03.115q.89.91 1.183 2.17.433 2.138-.887 3.854l-.136.166a4.55 4.55 0 0 1-2.201 1.388.12.12 0 0 0-.081.076c-.191.551-.383 1.023-.74 1.494-.9 1.187-2.222 1.846-3.711 1.838q-1.78-.009-3.157-1.302a.11.11 0 0 0-.105-.024c-.388.125-.78.143-1.204.138a4.44 4.44 0 0 1-1.945-.466 4.54 4.54 0 0 1-1.61-1.335c-.152-.202-.303-.392-.414-.617a6 6 0 0 1-.37-.961 4.6 4.6 0 0 1-.014-2.298.1.1 0 0 0 .006-.056.1.1 0 0 0-.027-.048 4.5 4.5 0 0 1-1.034-1.651 3.9 3.9 0 0 1-.251-1.192 5.2 5.2 0 0 1 .141-1.6Q3.659 7.92 5.086 6.97q.318-.212.601-.33a6 6 0 0 1 .646-.227.1.1 0 0 0 .065-.066 4.5 4.5 0 0 1 .829-1.615 4.54 4.54 0 0 1 1.837-1.388';

/** `>_` 提示符(dash 已换算绝对坐标;chevron 原本就是绝对 M)。 */
const PROMPT_GLYPHS =
  'M12.546 13.909a.637.637 0 0 0 0 1.272h3.636a.637.637 0 1 0 0-1.272zM8.462 9.23a.637.637 0 0 0-1.106.631l1.272 2.224-1.266 2.136a.636.636 0 1 0 1.095.649l1.454-2.455a.64.64 0 0 0 .005-.64z';

interface CodexMarkProps {
  size?: number;
  className?: string;
  variant?: 'mono' | 'brand';
}

export function CodexMark({ size = 14, className, variant = 'mono' }: CodexMarkProps) {
  const gradientId = useId();
  const monoStrokeWidth = size <= 14 ? 2 : 1.6;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden
    >
      {variant === 'brand' ? (
        <>
          {/* 官方原始形态:花形剪影 + `>_` 镂空,同一 path 填渐变(nonzero 反向子路径成孔)。 */}
          <path fill={`url(#${gradientId})`} d={`${FLOWER_OUTLINE}m3.482 10.565a.637.637 0 0 0 0 1.272h3.636a.637.637 0 1 0 0-1.272zM8.462 9.23a.637.637 0 0 0-1.106.631l1.272 2.224-1.266 2.136a.636.636 0 1 0 1.095.649l1.454-2.455a.64.64 0 0 0 .005-.64z`} />
          <defs>
            <linearGradient
              id={gradientId}
              x1="12"
              x2="12"
              y1="3"
              y2="21"
              gradientUnits="userSpaceOnUse"
            >
              <stop stopColor="#b1a7ff" />
              <stop offset=".5" stopColor="#7a9dff" />
              <stop offset="1" stopColor="#3941ff" />
            </linearGradient>
          </defs>
        </>
      ) : (
        <g transform="translate(12 12) scale(1.1) translate(-12 -12)">
          <path
            fill="none"
            stroke="currentColor"
            strokeWidth={monoStrokeWidth}
            strokeLinejoin="round"
            d={`${FLOWER_OUTLINE}z`}
          />
          <path
            fill="currentColor"
            stroke="currentColor"
            strokeWidth="0.5"
            strokeLinejoin="round"
            d={PROMPT_GLYPHS}
          />
        </g>
      )}
    </svg>
  );
}
