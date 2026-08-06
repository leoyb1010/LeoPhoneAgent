/**
 * BrandArrow —— 品牌箭头(品牌资产 SVG,单 path,currentColor 继承色)。
 *
 * 源:dinkie-icons_cat-face.svg(24×24 viewBox,单 path)。入仓改 fill=currentColor,
 * 做成继承父级 text 色的图标组件(light/dark/状态色由父级驱动)。
 *
 * D4-1:替代 VendorIcon 中 Claude(AA 字标)/Codex(六瓣)两个 glyph——常规任务/会话
 * 行首统一品牌箭头,vendor 视觉不再区分(用户拍板);协同(UsersRound)/状态(Archive/
 * RadioTower/running/attention/draft)glyph 不变。
 */
interface BrandArrowProps {
  size?: number;
  className?: string;
}

export function BrandArrow({ size = 12, className }: BrandArrowProps) {
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
        d="M19 10.7224V13.2775L7 22V15.1088L11.2366 11.9974L7 8.8859V2L19 10.7224Z"
        fill="currentColor"
      />
    </svg>
  );
}
