import test from 'node:test';
import assert from 'node:assert/strict';

import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

import type { NewTaskLaunch } from '../newTask';

import NewTaskCard from './NewTaskCard';

// ChipMenu 展开时往 document 上挂"点外面就关"的监听;node 里没有 DOM,给个空壳。
const globals = globalThis as unknown as {
  document?: unknown;
  window?: unknown;
  CustomEvent?: unknown;
};
globals.document ??= { addEventListener: () => undefined, removeEventListener: () => undefined };

type Dispatched = { type: string; detail: unknown };

class FakeCustomEvent {
  type: string;
  detail: unknown;
  constructor(type: string, init?: { detail?: unknown }) {
    this.type = type;
    this.detail = init?.detail;
  }
}

/** 把 window 换成一个只记录 dispatch 的壳,跑完还原。 */
function withFakeWindow<T>(run: (seen: Dispatched[]) => T): T {
  const seen: Dispatched[] = [];
  const previousWindow = globals.window;
  const previousCustomEvent = globals.CustomEvent;
  globals.CustomEvent = FakeCustomEvent;
  globals.window = {
    dispatchEvent: (event: FakeCustomEvent) => {
      seen.push({ type: event.type, detail: event.detail });
      return true;
    },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  try {
    return run(seen);
  } finally {
    globals.window = previousWindow;
    globals.CustomEvent = previousCustomEvent;
  }
}

const agents = [
  { provider: 'claude', label: 'Claude Code', status: 'v2.0.1 · 已连接' },
  { provider: 'codex', label: 'Codex', status: 'v0.9.0 · 已连接' },
];
const machines = [
  { name: null, label: '本机', desc: '这台 Mac' },
  { name: 'mini', label: 'mini', desc: '空闲 · 经中继下发' },
];
const projects = [
  { projectId: 'p1', displayName: 'leocodebox', path: '/Users/me/leocodebox' },
  { projectId: 'p2', displayName: 'relay', path: '/Users/me/relay' },
];

type Rendered = {
  renderer: TestRenderer.ReactTestRenderer;
  launches: NewTaskLaunch[];
};

function render(overrides: { defaultProvider?: string; selectedProjectId?: string | null } = {}): Rendered {
  const launches: NewTaskLaunch[] = [];
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(
      <NewTaskCard
        agents={agents}
        machines={machines}
        projects={projects}
        defaultProvider={overrides.defaultProvider ?? 'claude'}
        selectedProjectId={overrides.selectedProjectId ?? 'p1'}
        onStartTask={(launch) => launches.push(launch)}
        onOpenAgentSettings={() => undefined}
        onOpenProjects={() => undefined}
      />,
    );
  });
  return { renderer, launches };
}

const chip = (renderer: TestRenderer.ReactTestRenderer, ariaLabel: string) =>
  renderer.root.findAll((node) => node.props?.['aria-label'] === ariaLabel && node.props?.['aria-haspopup'] === 'menu')[0];

/** 递归收集一个节点下的所有文本。 */
function texts(node: TestRenderer.ReactTestInstance): string[] {
  return node.children.flatMap((child) => (typeof child === 'string' ? [child] : texts(child)));
}

/** 展开某个芯片,点中写着 `label` 的那一档。 */
function pick(renderer: TestRenderer.ReactTestRenderer, ariaLabel: string, label: string) {
  act(() => { chip(renderer, ariaLabel).props.onClick(); });
  const option = renderer.root
    .findAll((node) => node.props?.role === 'menuitemradio')
    .find((node) => texts(node).includes(label));
  assert.ok(option, `菜单里应该有「${label}」`);
  act(() => { option.props.onClick(); });
}

function typePrompt(renderer: TestRenderer.ReactTestRenderer, text: string) {
  const textarea = renderer.root.findByType('textarea');
  act(() => { textarea.props.onChange({ target: { value: text } }); });
}

function start(renderer: TestRenderer.ReactTestRenderer) {
  const button = renderer.root
    .findAllByType('button')
    .find((node) => node.props['aria-label'] === '开始新会话')!;
  act(() => { button.props.onClick(); });
}

test('在主控台选中的 Agent 被显式带进新会话的创建请求', () => {
  // 这是这一整轮改动的验收点:主控台选 Codex,创建请求里必须是 codex,
  // 而不是"当前会话恰好是谁"。
  withFakeWindow((seen) => {
    const { renderer, launches } = render({ defaultProvider: 'claude' });
    pick(renderer, '为这个新会话选 Agent', 'Codex');
    typePrompt(renderer, '把 README 里的版本号对一遍');
    start(renderer);

    assert.equal(launches.length, 1);
    assert.equal(launches[0].provider, 'codex', '创建请求必须带上用户选的 Agent');
    assert.equal(launches[0].projectId, 'p1');
    assert.equal(launches[0].machine, null);
    assert.equal(launches[0].prompt, '把 README 里的版本号对一遍');

    // 光把 provider 放进 launch 还不够:会话侧的 provider 只认这条事件。
    assert.deepEqual(
      seen.filter((event) => event.type === 'leocodebox-preferences:changed'),
      [{ type: 'leocodebox-preferences:changed', detail: { defaultProvider: 'codex' } }],
    );
    act(() => renderer.unmount());
  });
});

test('只是在主控台点选 Agent、还没按开始时,一个字都不许宣告出去', () => {
  // 用户可能是从某个 Claude 会话点回主控台的,selectedSession 还挂在外壳上。
  // 这时候一点选就改全局 provider,等于把那个已有会话的 composer 也换成了
  // Codex —— 正是「选了 Codex 发出去还是 Claude」的另一面。
  withFakeWindow((seen) => {
    const { renderer, launches } = render({ defaultProvider: 'claude' });
    pick(renderer, '为这个新会话选 Agent', 'Codex');
    assert.deepEqual(seen, [], '未按开始前不得触碰会话侧的 provider');
    assert.deepEqual(launches, []);
    act(() => renderer.unmount());
  });
});

test('目录跟着选,任务落在用户挑的那个项目上', () => {
  withFakeWindow(() => {
    const { renderer, launches } = render({ selectedProjectId: 'p1' });
    pick(renderer, '任务的工作目录', 'relay');
    typePrompt(renderer, '跑一遍测试');
    start(renderer);
    assert.equal(launches[0].projectId, 'p2');
    act(() => renderer.unmount());
  });
});

test('目标切到远程 Mac 时,任务带着机器名出去,且不改本机的 provider', () => {
  withFakeWindow((seen) => {
    const { renderer, launches } = render();
    pick(renderer, '任务跑在哪台机器上', 'mini');
    typePrompt(renderer, '看看磁盘还剩多少');
    start(renderer);
    assert.equal(launches[0].machine, 'mini');
    assert.equal(launches[0].provider, 'claude', 'Agent 仍然显式随请求下发');
    assert.deepEqual(seen, [], '远程任务不经本机 composer,不该宣告');
    act(() => renderer.unmount());
  });
});

test('没写第一句话就点开始,什么都不发生', () => {
  withFakeWindow((seen) => {
    const { renderer, launches } = render();
    start(renderer);
    assert.deepEqual(launches, []);
    assert.deepEqual(seen, []);
    act(() => renderer.unmount());
  });
});
