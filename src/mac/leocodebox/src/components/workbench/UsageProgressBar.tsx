import { useId } from 'react';

import { renderedFillPercent } from './quotaFormat';

/**
 * [T-quota-card] 额度进度条 —— 1:1 复刻上游 CodexBar(MIT,见 NOTICE)的画法。
 *
 * 上游是一整张 SwiftUI Canvas,轨道 / 填充 / 标记全在一层里靠 `destinationOut`
 * 混合模式"打穿"。这里用 SVG 复刻:mask 承担打穿,stripe 在 mask 之外补画。
 * 用 SVG 而不是 div 叠层,是因为这条 6px 的东西上有 1px / 2px 级别的标记,
 * div + 百分比定位在小数宽度上会糊成两个灰点。
 *
 * 坐标系:`percent` 已经是**标签上那个数**(默认"剩余"),标记也都在同一轴上。
 */

const HEIGHT = 6;
const RADIUS = HEIGHT / 2;

/** 配速尖端:6px 打穿 + 正中 2px 条。上游先按 39px 覆盖区排版,平移后正好居中。 */
const PACE_PUNCH = 6;
const PACE_STRIPE = 2;
/** 阈值刻痕:5px 打穿 + 正中 1px 中性条。 */
const NOTCH_PUNCH = 5;
const NOTCH_STRIPE = 1;
/** 打穿留 10% 残影,和上游 stripePunchOpacity = 0.9 一致。 */
const PUNCH_KEEP = 0.1;

const TRACK_FILL = 'hsl(var(--muted-foreground) / 0.22)';
const NOTCH_FILL = 'hsl(var(--foreground) / 0.68)';
const WEEKDAY_FILL = 'hsl(var(--foreground) / 0.30)';
const DEFICIT_FILL = 'hsl(var(--destructive))';
const RESERVE_FILL = 'hsl(var(--success))';

export type UsageProgressBarProps = {
  /** 显示轴上的百分比,和标签同一个数。 */
  percent: number;
  /** 条的颜色:品牌色或状态色,由调用方按三档规则决定。 */
  fillColor: string;
  /** 预期进度落点(同一显示轴)。onTrack 时传 null —— 不画。 */
  pacePercent?: number | null;
  /** true = 实际用量还在预期之内(结余,绿);false = 已经透支(赤字,红)。 */
  paceOnTop?: boolean;
  /** 阈值刻痕位置(显示轴)。 */
  markerPercents?: number[];
  /** 工作日刻度位置(显示轴),只有 7 天窗口才有。 */
  weekdayPercents?: number[];
  /** 卡片内容宽度。基线 310px 卡 − 2×20px 内边距 = 270px。 */
  width?: number;
  className?: string;
};

/** 标记按整像素对齐,免得 1px 的线被抗锯齿摊成两个灰点。 */
function alignedX(center: number, thickness: number): number {
  return Math.round(center) - thickness / 2;
}

export default function UsageProgressBar({
  percent,
  fillColor,
  pacePercent,
  paceOnTop = true,
  markerPercents = [],
  weekdayPercents = [],
  width = 270,
  className,
}: UsageProgressBarProps) {
  const rawId = useId().replace(/[^a-zA-Z0-9-]/g, '');
  const maskId = `quota-bar-${rawId}`;
  const w = Math.max(1, width);

  const fillWidth = (renderedFillPercent(percent) / 100) * w;
  const notchCenters = markerPercents.map((p) => (p / 100) * w);
  const weekdayCenters = weekdayPercents.map((p) => (p / 100) * w);

  const showPace = pacePercent != null && Number.isFinite(pacePercent);
  const paceX = showPace ? (Math.min(100, Math.max(0, pacePercent)) / 100) * w : 0;
  const paceColor = paceOnTop ? RESERVE_FILL : DEFICIT_FILL;

  return (
    <svg
      className={className}
      width={w}
      height={HEIGHT}
      viewBox={`0 0 ${w} ${HEIGHT}`}
      role="presentation"
      aria-hidden="true"
    >
      <defs>
        <mask id={maskId} maskUnits="userSpaceOnUse" x={0} y={0} width={w} height={HEIGHT}>
          <rect x={0} y={0} width={w} height={HEIGHT} fill="#fff" />
          {notchCenters.map((x, index) => (
            <rect
              key={`punch-${index}`}
              x={alignedX(x, NOTCH_PUNCH)}
              y={0}
              width={NOTCH_PUNCH}
              height={HEIGHT}
              fill="#fff"
              fillOpacity={PUNCH_KEEP}
            />
          ))}
          {showPace && (
            <rect
              x={alignedX(paceX, PACE_PUNCH)}
              y={0}
              width={PACE_PUNCH}
              height={HEIGHT}
              fill="#fff"
              fillOpacity={PUNCH_KEEP}
            />
          )}
        </mask>
      </defs>

      <g mask={`url(#${maskId})`}>
        <rect x={0} y={0} width={w} height={HEIGHT} rx={RADIUS} ry={RADIUS} style={{ fill: TRACK_FILL }} />
        {fillWidth > 0 && (
          <rect x={0} y={0} width={fillWidth} height={HEIGHT} rx={RADIUS} ry={RADIUS} style={{ fill: fillColor }} />
        )}
        {/* 工作日刻度是普通描边,不打穿,底部对齐半高。 */}
        {weekdayCenters.map((x, index) => (
          <rect
            key={`weekday-${index}`}
            x={alignedX(x, 1)}
            y={HEIGHT / 2}
            width={1}
            height={HEIGHT / 2}
            style={{ fill: WEEKDAY_FILL }}
          />
        ))}
      </g>

      {notchCenters.map((x, index) => (
        <rect
          key={`notch-${index}`}
          x={alignedX(x, NOTCH_STRIPE)}
          y={0}
          width={NOTCH_STRIPE}
          height={HEIGHT}
          style={{ fill: NOTCH_FILL }}
        />
      ))}

      {showPace && (
        <rect
          x={alignedX(paceX, PACE_STRIPE)}
          y={0}
          width={PACE_STRIPE}
          height={HEIGHT}
          style={{ fill: paceColor }}
        />
      )}
    </svg>
  );
}
