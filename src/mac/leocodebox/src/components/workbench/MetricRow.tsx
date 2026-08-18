import UsageProgressBar from './UsageProgressBar';
import {
  dedupeWorkdayMarkers,
  displayPercent,
  warningMarkerPercents,
  workdayMarkerPercents,
} from './quotaFormat';
import type { PercentMode, UsagePace } from './quotaFormat';

/**
 * [T-quota-card] 一个额度窗口一行 —— 版式抄上游 CodexBar(MIT,见 NOTICE):
 *
 *   [标题 百分比]                        [重置文案]   ← 同一条基线,两端对齐
 *   [━━━━━━━━━━ 6px 进度条 ━━━━━━━━━━]
 *   [配速 meta,最多两行]
 *   [窗口说明,一行]
 *
 * 行内竖直间距 6px(上游 VStack spacing);标题和重置文案一行放不下时靠
 * flex-wrap 降级成两行(标题左、重置右),对应上游的 ViewThatFits 回退版式。
 */

export type MetricRowProps = {
  title: string;
  percentLabel: string;
  resetText?: string;
  metaText?: string;
  detailText?: string;
  /** 后端给的"已用百分比"。显示轴换算在这里做。 */
  usedPercent: number;
  mode?: PercentMode;
  /** 条的颜色:三档状态色由调用方决定。 */
  fillColor: string;
  pace?: UsagePace | null;
  windowMinutes?: number | null;
  barWidth?: number;
};

export default function MetricRow({
  title,
  percentLabel,
  resetText,
  metaText,
  detailText,
  usedPercent,
  mode = 'left',
  fillColor,
  pace,
  windowMinutes,
  barWidth,
}: MetricRowProps) {
  const warnings = warningMarkerPercents(undefined, mode);
  const workdays = dedupeWorkdayMarkers(workdayMarkerPercents(windowMinutes), warnings);

  // onTrack 不画配速标记 —— 没有偏差时那根条纹只是噪音。
  const showPace = Boolean(pace) && pace!.stage !== 'onTrack';
  const pacePercent = showPace ? displayPercent(pace!.expectedUsedPercent, mode) : null;
  const paceOnTop = pace ? usedPercent <= pace.expectedUsedPercent : true;

  return (
    <div className="flex flex-col gap-[6px]">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium leading-[1.35] text-foreground">
          {title} {percentLabel}
        </span>
        {resetText && (
          <span className="ml-auto shrink-0 text-right text-[10.5px] leading-[1.35] text-muted-foreground">
            {resetText}
          </span>
        )}
      </div>

      <UsageProgressBar
        percent={displayPercent(usedPercent, mode)}
        fillColor={fillColor}
        pacePercent={pacePercent}
        paceOnTop={paceOnTop}
        markerPercents={warnings}
        weekdayPercents={workdays}
        width={barWidth}
        className="block"
      />

      {metaText && (
        <span className="line-clamp-2 text-[10.5px] leading-[1.4] text-muted-foreground">{metaText}</span>
      )}
      {detailText && (
        <span className="truncate text-[10.5px] leading-[1.4] text-muted-foreground">{detailText}</span>
      )}
    </div>
  );
}
