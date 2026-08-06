/**
 * QuotaResetConfetti — 限额窗口重置揭晓时刻的一次性撒花粒子。
 *
 * 这是 DESIGN §14.4 的 sanctioned 豁免动效(用户拍板 2026-07-23, 与容器形变同级,
 * 条目见 DESIGN.md):红(耗尽告警)→ 悬念(重置中…)→ 撒花 + 0%→100% 滚动揭晓。
 * 形态(用户四/五轮拍板 2026-07-23): 上抛烟花, **真实抛物线物理** —— 全部粒子
 * 同时从揭晓段中心以约 100° 扇形(正上方 ±50°)同速率抛出, 水平匀速、垂直恒定
 * 重力(上升恒减速、过顶点恒加速回落), 全程速度感一致;角度大的粒子弧低、
 * 飞得远、先落地(物理自然给出错落), 落到地面线的最后一小段短渐隐消失
 * (可以落地, 但不允许「落定后躺尸再突然没」)。
 * 实现: 每粒两层 span —— 外层只做水平位移(linear), 内层只做垂直位移
 * (精确二次缓动 = 恒定重力)+ 旋转 + 渐隐;x/y 分离是速度一致的关键,
 * 合在一个 transform 里会让水平速度跟着垂直缓动忽快忽慢。
 * 红线内实现:
 *   - 一次性庆祝, 同时起飞, 单粒时长由弧高物理决定(clamp 0.9s-1.6s), 总时长
 *     约 1.6s 收尾(数字滚动 1.2s 站定后纸屑再落零点几秒);
 *     不循环不常驻, 放完即拆(粒子节点 onfinish 自删);
 *   - 粒子是 HTML span, 只动 transform / opacity(compositor-only, 工程规范 §7);
 *   - 数量与尺寸克制(18 颗, 3-5px), 抛物线轨迹 + 落地短渐隐;
 *   - 颜色取「小状态点 hue 豁免簇」四色(done 绿 / awaiting 青 / thinking 橙 /
 *     error 红), light/dark 同值, 双模式天然一致;
 *   - prefers-reduced-motion → 整体跳过;
 *   - portal 到 body + fixed 定位在锚点矩形, 不受状态栏 overflow 裁剪。
 */

import * as React from 'react';
import { createPortal } from 'react-dom';

const CONFETTI_COLORS = [
  'var(--card-status-done)',
  'var(--card-status-awaiting)',
  'var(--warning-accent)',
  'var(--card-status-error)',
];
const PARTICLE_COUNT = 18;
/** 物理时间单位 → 毫秒的换算(调这个 = 整体快慢);时长再 clamp 进下面区间。 */
const TIME_SCALE_MS = 78;
const MIN_FLIGHT_MS = 900;
const MAX_FLIGHT_MS = 1600;
/** 精确二次缓动: 上升段(恒减速到顶点零速)/ 下落段(顶点零速起恒加速)。 */
const QUAD_EASE_OUT = 'cubic-bezier(0.33, 0.67, 0.67, 1)';
const QUAD_EASE_IN = 'cubic-bezier(0.33, 0, 0.67, 0.33)';

interface QuotaResetConfettiProps {
  /**
   * 迸发锚点(揭晓的窗口段元素, 兜底 chip 容器)。mount 时取一次几何矩形,
   * 礼花从矩形中心爆开。
   */
  anchor: HTMLElement;
  /** 全部粒子放完(或被降级跳过)后回调, 由调用方卸载本组件。 */
  onDone: () => void;
}

export function QuotaResetConfetti({ anchor, onDone }: QuotaResetConfettiProps) {
  const hostRef = React.useRef<HTMLSpanElement | null>(null);
  const onDoneRef = React.useRef(onDone);
  onDoneRef.current = onDone;

  React.useEffect(() => {
    const host = hostRef.current;
    if (!host || !anchor.isConnected) {
      onDoneRef.current();
      return undefined;
    }
    if (
      typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ) {
      onDoneRef.current();
      return undefined;
    }
    const rect = anchor.getBoundingClientRect();
    host.style.left = `${rect.left}px`;
    host.style.top = `${rect.top}px`;

    const animations: Animation[] = [];
    let remaining = PARTICLE_COUNT;
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const size = 3 + Math.random() * 2;
      // 两层结构: carrier 只做水平匀速位移, particle 只做垂直位移 + 旋转 + 渐隐。
      const carrier = document.createElement('span');
      carrier.style.position = 'absolute';
      carrier.style.left = `${rect.width * 0.5 - size / 2}px`;
      carrier.style.top = `${rect.height * 0.5 - size / 2}px`;
      carrier.style.willChange = 'transform';
      const particle = document.createElement('span');
      particle.style.display = 'block';
      particle.style.width = `${size}px`;
      particle.style.height = `${size}px`;
      // 方粒与圆粒混合, 更像纸屑;颜色循环取豁免簇四色。
      particle.style.borderRadius = Math.random() < 0.4 ? '9999px' : '1px';
      particle.style.background = CONFETTI_COLORS[i % CONFETTI_COLORS.length];
      particle.style.willChange = 'transform, opacity';
      carrier.appendChild(particle);
      host.appendChild(carrier);

      // 真实抛物线运动学(g 归一为 1, 长度单位 px):
      //   speedSq = v²/g —— 同一批速率相近(带抖动), 决定整体弧的尺度;
      //   θ 取自正上方 ±50°(约 100° 扇形): 角度越大弧越低、横向越远、越早落地。
      const speedSq = 40 + Math.random() * 35;
      const theta = (Math.random() - 0.5) * (Math.PI * 100 / 180);
      const cosT = Math.cos(theta);
      const rise = (speedSq * cosT * cosT) / 2;
      // 地面线: 原点下方一小段(带随机抖动, 落点不整齐排队)。
      const groundY = 14 + Math.random() * 8;
      const timeUp = Math.sqrt(speedSq) * cosT;
      const timeDown = Math.sqrt(speedSq * cosT * cosT + 2 * groundY);
      const apexOffset = timeUp / (timeUp + timeDown);
      const xTotal = Math.sqrt(speedSq) * Math.sin(theta) * (timeUp + timeDown);
      const duration = Math.min(
        MAX_FLIGHT_MS,
        Math.max(MIN_FLIGHT_MS, (timeUp + timeDown) * TIME_SCALE_MS),
      );
      const rotate = (Math.random() - 0.5) * 720;

      // 水平: 全程匀速(真实抛物线的关键 —— 不跟垂直缓动走)。
      const carrierAnimation = carrier.animate(
        [
          { transform: 'translateX(0px)' },
          { transform: `translateX(${xTotal}px)` },
        ],
        { duration, easing: 'linear', fill: 'forwards' },
      );
      animations.push(carrierAnimation);

      // 垂直: 精确二次缓动模拟恒定重力(升到顶点恰好零速), 顶点时刻按物理
      // 算出的 apexOffset;落地前最后 12% 短渐隐(部分关键帧只写 opacity,
      // 不打断 transform 的抛物线插值)。
      const particleAnimation = particle.animate(
        [
          {
            transform: 'translateY(0px) rotate(0deg)',
            opacity: 1,
            easing: QUAD_EASE_OUT,
          },
          {
            transform: `translateY(${-rise}px) rotate(${rotate * apexOffset}deg)`,
            offset: apexOffset,
            easing: QUAD_EASE_IN,
          },
          { opacity: 1, offset: 0.88 },
          {
            transform: `translateY(${groundY}px) rotate(${rotate}deg)`,
            opacity: 0,
          },
        ],
        { duration, fill: 'forwards' },
      );
      particleAnimation.onfinish = () => {
        carrier.remove();
        remaining -= 1;
        if (remaining === 0) onDoneRef.current();
      };
      animations.push(particleAnimation);
    }
    return () => {
      for (const animation of animations) animation.cancel();
      host.replaceChildren();
    };
    // anchor 由调用方在触发瞬间快照进 state, 组件以 key=nonce 重建 —— effect
    // 实际只在 mount 跑一次。
  }, [anchor]);

  return createPortal(
    <span ref={hostRef} aria-hidden="true" className="pointer-events-none fixed z-[9999]" />,
    document.body,
  );
}
