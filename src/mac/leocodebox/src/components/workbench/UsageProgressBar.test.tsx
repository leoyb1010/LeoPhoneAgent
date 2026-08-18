import test from 'node:test';
import assert from 'node:assert/strict';

import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

import UsageProgressBar from './UsageProgressBar';

/**
 * 进度条上的标记是 1~2px 级别的东西,肉眼看不出画错 —— 这里直接量几何。
 * 尺寸取上游基线:310px 卡 − 2×20px 内边距 = 270px,高 6px。
 */
const W = 270;

function render(props: React.ComponentProps<typeof UsageProgressBar>) {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => { renderer = TestRenderer.create(<UsageProgressBar {...props} />); });
  return renderer;
}

function rects(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findAllByType('rect').map((node) => node.props as Record<string, unknown>);
}

test('轨道和填充都是 6px 高、半高圆角的胶囊', () => {
  const renderer = render({ percent: 72, fillColor: '#10a37f', width: W });
  const svg = renderer.root.findByType('svg').props as Record<string, unknown>;
  assert.equal(svg.height, 6);
  assert.equal(svg.width, W);

  // 圆角矩形只有轨道和填充两个(mask 里的白底是直角)。
  const [track, fill] = rects(renderer).filter((rect) => rect.rx === 3);
  assert.equal(track.width, W);
  assert.equal(track.height, 6);
  assert.equal(fill.width, (72 / 100) * W);
});

test('填充跟标签对齐:显示 0% 就画空,显示 100% 就画满', () => {
  // 0.4% → 标签写 "<1%",条按上游 renderedFillPercent 收成 0 宽。
  const empty = rects(render({ percent: 0.4, fillColor: '#000', width: W }));
  assert.ok(!empty.some((rect) => rect.width === (0.4 / 100) * W), '不应画出 0.4% 的残条');
  const full = rects(render({ percent: 99.7, fillColor: '#000', width: W }));
  assert.ok(full.some((rect) => rect.width === W && rect.rx === 3), '99.7% 应画满');
});

test('阈值刻痕:5px 打穿 + 正中 1px 中性条,按整像素对齐', () => {
  const renderer = render({ percent: 72, fillColor: '#000', markerPercents: [50, 20], width: W });
  const all = rects(renderer);

  // mask 里两个 5px 打穿(留 10% 残影,对应上游 stripePunchOpacity 0.9)
  const punches = all.filter((rect) => rect.width === 5 && rect.fillOpacity === 0.1);
  assert.equal(punches.length, 2);
  assert.deepEqual(punches.map((rect) => rect.x), [135 - 2.5, 54 - 2.5]);

  // mask 外两条 1px 实线,正好落在打穿的中心
  const stripes = all.filter((rect) => rect.width === 1 && rect.height === 6);
  assert.equal(stripes.length, 2);
  assert.deepEqual(stripes.map((rect) => rect.x), [135 - 0.5, 54 - 0.5]);
});

test('配速尖端:6px 打穿 + 正中 2px 条,颜色分赤字红 / 结余绿', () => {
  const deficit = rects(render({ percent: 40, fillColor: '#000', pacePercent: 60, paceOnTop: false, width: W }));
  const punch = deficit.find((rect) => rect.width === 6 && rect.fillOpacity === 0.1);
  assert.ok(punch, '缺少配速打穿');
  assert.equal(punch!.x, Math.round(0.6 * W) - 3);
  const stripe = deficit.find((rect) => rect.width === 2);
  assert.ok(stripe, '缺少配速条纹');
  assert.equal(stripe!.x, Math.round(0.6 * W) - 1);
  assert.deepEqual(stripe!.style, { fill: 'hsl(var(--destructive))' });

  const reserve = rects(render({ percent: 80, fillColor: '#000', pacePercent: 60, paceOnTop: true, width: W }));
  const reserveStripe = reserve.find((rect) => rect.width === 2);
  assert.deepEqual(reserveStripe!.style, { fill: 'hsl(var(--success))' });
});

test('onTrack(pacePercent = null)时完全不画配速标记', () => {
  const all = rects(render({ percent: 72, fillColor: '#000', pacePercent: null, width: W }));
  assert.equal(all.filter((rect) => rect.width === 2 || rect.width === 6).length, 0);
});

test('工作日刻度:1px 宽、半高、底部对齐,不打穿', () => {
  const week = [100 / 7, 200 / 7].map((value) => value);
  const all = rects(render({ percent: 72, fillColor: '#000', weekdayPercents: week, width: W }));
  const ticks = all.filter((rect) => rect.width === 1 && rect.height === 3);
  assert.equal(ticks.length, 2);
  assert.equal(ticks[0].y, 3);
  assert.deepEqual(ticks[0].style, { fill: 'hsl(var(--foreground) / 0.30)' });
  // 刻度不产生打穿。
  assert.equal(all.filter((rect) => rect.fillOpacity === 0.1).length, 0);
});
