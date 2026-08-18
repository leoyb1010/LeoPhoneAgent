import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

/**
 * [T-quota-panel] 菜单栏额度面板的渲染契约测试。
 *
 * 为什么要有这个:1.69.0 出过一次真事故 —— 后端换成新契约(status/source/
 * primary)后,这个面板还在读旧字段 `p.available`,于是**永远** undefined、
 * 永远显示 "Not connected"。后端测试全绿、端到端也能取到 33%,唯独用户
 * 看到的那块是死的。单测只覆盖服务层是不够的,渲染层也要钉住契约。
 *
 * 做法:把 html 里的 <script> 抽出来,喂一份最小 DOM,用**真实形状的**快照
 * 跑一遍 render(),断言屏幕上真的出现了数字。
 */

const html = readFileSync(fileURLToPath(new URL('../public/leocodebox-quota.html', import.meta.url)), 'utf8');
const source = html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'));

/** 够跑这段脚本的最小 DOM。只实现脚本真正用到的那几个 API。 */
function makeDom() {
  const make = (tag) => {
    const node = {
      tagName: tag, className: '', textContent: '', children: [], style: {}, disabled: false,
      append(...kids) { for (const k of kids) this.children.push(typeof k === 'string' ? { textContent: k, children: [] } : k); },
      replaceChildren(...kids) { this.children = []; this.append(...kids); },
      addEventListener() {}, remove() {},
    };
    return node;
  };
  const byId = { tabs: make('div'), head: make('div'), body: make('div'), acts: make('div') };
  byId.acts.after = () => {};
  return {
    document: {
      createElement: make,
      createTextNode: (t) => ({ textContent: t, children: [] }),
      getElementById: (id) => byId[id],
      querySelector: (sel) => (sel === '.shell'
        ? { getBoundingClientRect: () => ({ height: 500 }) }
        : null),
      addEventListener() {},
    },
    byId,
  };
}

/** 把渲染出来的树拍平成一段文本,用来断言"屏幕上有没有这句话"。 */
function flatten(node) {
  if (!node) return '';
  const own = node.textContent || '';
  return own + (node.children || []).map(flatten).join(' ');
}

function runRender(providers) {
  const { document, byId } = makeDom();
  const sandbox = {
    document,
    localStorage: { getItem: () => '', setItem() {} },
    fetch: async () => ({ ok: true, json: async () => ({ providers: [] }) }),
    setInterval: () => 0,
    // 面板渲染完会量一次高度回传主进程;测试里同步跑掉即可。
    requestAnimationFrame: (fn) => { fn(); return 0; },
    // 面板用它跟随内容高度;测试里不需要真的观察,存在即可。
    ResizeObserver: class { observe() {} disconnect() {} },
    window: { leocodeboxLocal: { resizePanel() {} } },
    console,
  };
  const fn = new Function(...Object.keys(sandbox), `${source}\n; return { render, setState: (p) => { providers = p; } };`);
  const api = fn(...Object.values(sandbox));
  api.setState(providers);
  api.render();
  return { head: flatten(byId.head), body: flatten(byId.body), tabs: flatten(byId.tabs) };
}

const CODEX_LIVE = {
  id: 'codex', label: 'Codex', accentColor: '#49A3B0', status: 'ok', source: 'oauth',
  updatedAt: Date.now() - 30_000,
  identity: { accountEmail: 'someone@example.com', plan: 'pro' },
  primary: { usedPercent: 33, windowMinutes: 10080, resetsAt: Date.now() + 2 * 86400_000 },
  extraRateWindows: [
    { id: 'spark', title: 'Spark', window: { usedPercent: 0, windowMinutes: 10080, resetsAt: Date.now() + 5 * 86400_000 }, usageKnown: true },
  ],
  credits: { remaining: 0, total: null, unit: 'credits', hint: '未购买额外积分' },
};

test('拿到权威额度时,面板显示真实数字,而不是"未接入"', () => {
  const out = runRender([CODEX_LIVE]);
  assert.match(out.body, /剩 67%/, '应显示剩余百分比(100-33)');
  assert.match(out.body, /已用 33%/, '应显示已用百分比');
  assert.doesNotMatch(out.body, /未接入/, '拿到数据了就不能说未接入 —— 这正是 1.69.0 的事故');
  assert.match(out.head, /pro/, '套餐应出现在头部');
});

test('占位窗口(isSyntheticPlaceholder)不渲染 —— 它的 0% 是"没数据"不是"没用"', () => {
  // 用一个独一无二的标题来认人:面板上出现它,就说明占位窗口被当真窗口画了。
  const ghost = { usedPercent: 0, windowMinutes: 300, resetsAt: null, isSyntheticPlaceholder: true };
  const withGhost = {
    ...CODEX_LIVE,
    extraRateWindows: [{ id: 'ghost', title: '幽灵窗口', window: ghost, usageKnown: false }],
    secondary: ghost,
  };
  const out = runRender([withGhost]);
  assert.doesNotMatch(out.body, /幽灵窗口/, '占位窗口不该出现在面板上');
  assert.doesNotMatch(out.body, /会话/, '300 分钟的占位窗口不该被画成「会话」一行');
});

test('未接入时,把缺什么写在脸上', () => {
  const out = runRender([{
    id: 'gemini', label: 'Gemini', status: 'unconfigured', source: 'none',
    note: '本机 gemini 的登录方式是 gemini-api-key,个人配额接口只对 oauth-personal 开放',
  }]);
  assert.match(out.body, /未接入/);
  assert.match(out.body, /gemini-api-key/, '要写清楚缺什么,而不是笼统一句未接入');
});

test('本机日志累加的数据必须标注出来,不能冒充官方配额', () => {
  const out = runRender([{ ...CODEX_LIVE, source: 'local' }]);
  assert.match(out.head, /本机日志累加/);
});

test('渲染脚本里不残留任何旧契约字段', () => {
  for (const stale of ['p.available', 'p.windows', 'p.rolling', 'todayCostUSD', 'hasCredits']) {
    assert.ok(!source.includes(stale), `渲染层仍在读旧契约字段 ${stale}`);
  }
});
