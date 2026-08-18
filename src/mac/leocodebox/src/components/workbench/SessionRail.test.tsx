import test from 'node:test';
import assert from 'node:assert/strict';

import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

import type { Project, ProjectSession } from '../../types/app';
import type { SessionActivityMap } from '../../hooks/useSessionProtection';

import SessionRail from './SessionRail';

const project = {
  projectId: 'p1',
  displayName: 'leocodebox',
  sessions: [
    { id: 's1', summary: '改文案', lastActivity: new Date().toISOString(), __provider: 'claude' },
    { id: 's2', summary: '跑测试', lastActivity: new Date().toISOString(), __provider: 'claude' },
  ] as unknown as ProjectSession[],
} as unknown as Project;

function render(approvalSessionIds: Set<string>, activeSessions: SessionActivityMap = new Map()) {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(
      <SessionRail
        projects={[project]}
        selectedSessionId={null}
        activeSessions={activeSessions}
        approvalSessionIds={approvalSessionIds}
        remotes={[]}
        localName="本机"
        onSelectLocal={() => undefined}
        onTakeOverRemote={() => undefined}
      />,
    );
  });
  return renderer;
}

/** 递归收集一个节点下的所有文本,用来判断这一行有没有"待审批"。 */
function texts(node: TestRenderer.ReactTestInstance): string[] {
  return node.children.flatMap((child) => (typeof child === 'string' ? [child] : texts(child)));
}

/** 返回挂着"待审批"标签的会话标题。 */
function badgedTitles(renderer: TestRenderer.ReactTestRenderer): string[] {
  return renderer.root
    .findAllByType('button')
    .map((row) => texts(row))
    .filter((rowTexts) => rowTexts.includes('待审批'))
    .map((rowTexts) => rowTexts[0]);
}

test('没有挂起的授权请求时,一个"待审批"都不该出现', () => {
  assert.deepEqual(badgedTitles(render(new Set())), []);
});

test('只有真的在等授权的那个会话挂标签', () => {
  assert.deepEqual(badgedTitles(render(new Set(['s2']))), ['跑测试']);
});

test('审批处理完(集合里被移除)标签立刻消失', () => {
  const renderer = render(new Set(['s1']));
  assert.deepEqual(badgedTitles(renderer), ['改文案']);

  act(() => {
    renderer.update(
      <SessionRail
        projects={[project]}
        selectedSessionId={null}
        activeSessions={new Map()}
        approvalSessionIds={new Set()}
        remotes={[]}
        localName="本机"
        onSelectLocal={() => undefined}
        onTakeOverRemote={() => undefined}
      />,
    );
  });
  assert.deepEqual(badgedTitles(renderer), []);
});
