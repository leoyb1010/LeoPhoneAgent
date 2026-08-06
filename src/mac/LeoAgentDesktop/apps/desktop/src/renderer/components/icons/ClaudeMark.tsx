/**
 * ClaudeMark —— Claude Code 官方像素方块脸 mark(CLI 品牌 glyph),双轨:
 *  - variant="mono"(默认):currentColor 单色,跟随主题/状态染色(侧栏
 *    idle/running 灰阶、选中态同文字色等既有染色语义全部生效);
 *  - variant="brand":Anthropic 陶土橙 #d97757 固定品牌色(跨主题一致,语义
 *    豁免——同 docs/design-rules/cindy-design-system.md Toast 三色逻辑,不走主题 token),用于需要品牌辨识
 *    度的场景,父级染色 class 对其无效。
 *
 * 2026-07-20(产品):形状统一用 Claude Code 像素脸(比旧 Anthropic "AA"
 * wordmark 辨识度高);单色为默认,彩色按场景显式启用。
 */

interface ClaudeMarkProps {
  size?: number;
  className?: string;
  variant?: 'mono' | 'brand';
}

export function ClaudeMark({ size = 14, className, variant = 'mono' }: ClaudeMarkProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden
    >
      <path
        fill={variant === 'brand' ? '#d97757' : 'currentColor'}
        fillRule="evenodd"
        clipRule="evenodd"
        d="M20.998 10.949H24v3.102h-3v3.028h-1.487V20H18v-2.921h-1.487V20H15v-2.921H9V20H7.488v-2.921H6V20H4.487v-2.921H3V14.05H0v-3.1h3V5h17.998zM6 10.949h1.488V8.102H6zm10.51 0H18V8.102h-1.49z"
      />
    </svg>
  );
}
