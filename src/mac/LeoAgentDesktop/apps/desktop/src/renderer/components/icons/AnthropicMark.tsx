/**
 * AnthropicMark —— Anthropic 官方 "AA" wordmark,单色 currentColor。
 * 模型厂牌 mark,与 Agent 身份的 ClaudeMark/CodexMark 区分
 * (2026-07-21 产品语义纠偏)。
 */

interface AnthropicMarkProps {
  size?: number;
  className?: string;
}

export function AnthropicMark({ size = 14, className }: AnthropicMarkProps) {
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
        d="M13.827 3.52h3.603L24 20h-3.603l-6.57-16.48zm-7.258 0h3.767L16.906 20h-3.674l-1.343-3.461H5.017l-1.344 3.461H0L6.57 3.52zm4.132 9.876L8.453 7.247 6.205 13.396z"
        fill="currentColor"
      />
    </svg>
  );
}
