import { useEffect, useState } from 'react';

import { LAST_CWD_KEY, LAST_MODEL_KEY, POLICY_LABEL, composerShouldSend, highlightQueryParts, isLiveRow, markupParts, modelChoiceHint, modelLikelyUnusable, pickInitialCwd, pickInitialModel, prettyModelName, userTurnLabel, type FlowRow, type Group } from './model';

function FindBits({ text, query }: { text: string; query?: string }) {
  return (
    <>
      {highlightQueryParts(text, query ?? '').map((bit, i) => (
        bit.hit ? <mark className="find-hit" key={i}>{bit.t}</mark> : <span key={i}>{bit.t}</span>
      ))}
    </>
  );
}

export function FlowText({ text, query }: { text: string; query?: string }) {
  return (
    <>
      {markupParts(text).map((part, i) => {
        const inner = <FindBits text={part.v} query={query} />;
        if (part.k === 'code') return <code key={i}>{inner}</code>;
        if (part.k === 'strong') return <strong key={i}>{inner}</strong>;
        return <span key={i}>{inner}</span>;
      })}
    </>
  );
}

export function Row({ row, model, query, onApprove, onDiff }: {
  row: FlowRow;
  model: string | null;
  query?: string;
  onApprove: (id: string, choice: string) => unknown;
  onDiff: () => void;
}) {
  const [open, setOpen] = useState(row.k === 'think' ? false : undefined);
  const [thinkOpen, setThinkOpen] = useState(false);
  const live = isLiveRow(row) ? ' live' : '';
  switch (row.k) {
    case 'user': {
      const mode = row.mode ?? 'prompt';
      return <div className={`frow frow-user${mode === 'prompt' ? '' : ` frow-${mode}`}${live}`}><div className="fl">{userTurnLabel(mode)}</div><div className="fc"><FlowText text={row.text} query={query} /></div></div>;
    }
    case 'ai': return <div className={`frow frow-ai${live}`}><div className="fl">{prettyModelName(model).split(' ')[0] || '模型'}</div><div className={`fc ${row.streaming ? 'streaming' : ''}`}><FlowText text={row.text} query={query} /></div></div>;
    case 'think': return (
      <div className={`frow frow-think${live}`}><div className="fl">思考</div><div className="fc">
        <button className="think-toggle" onClick={() => setThinkOpen((v) => !v)}>{thinkOpen ? '收起思考' : row.streaming ? '正在想…' : '想过一步'}</button>
        {thinkOpen ? <div className={`think-body ${row.streaming ? 'streaming' : ''}`}><FindBits text={row.text} query={query} /></div> : null}
      </div></div>
    );
    case 'tool': return (
      <div className={`frow frow-tool${live}`}><div className="fl">$</div><div className="fc">
        <div className="tool-line"><code><FindBits text={row.preview || row.tool} query={query} /></code>
          {row.running ? <><span className="prog" /><span className="tool-meta run">运行中</span></> : <span className={`tool-meta ${row.error ? 'err' : ''}`}>{row.error ? '失败' : '完成'}</span>}
          {row.output ? <button className="tool-toggle" onClick={() => setOpen((o) => !o)}>{open ? '收起' : '展开'}</button> : null}
        </div>
        {open && row.output ? <pre className="tool-out"><FindBits text={row.output} query={query} /></pre> : null}
      </div></div>
    );
    case 'edit': return (
      <div className={`frow frow-edit${live}`}><div className="fl">{row.tool === 'write' ? '写入' : '编辑'}</div><div className="fc">
        <div className="tool-line"><button className="tool-line" onClick={onDiff} style={{ gap: 10 }}><code><FindBits text={row.file} query={query} /></code>{row.running ? <span className="tool-meta run">进行中</span> : <span className={`tool-meta ${row.error ? 'err' : ''}`}>{row.error ? '失败' : '已改'}</span>}</button></div>
      </div></div>
    );
    case 'ap': return (
      <div className={`frow frow-ap${live}`}><div className="fl">需要确认</div><div className="fc">
        <p><FindBits text={`${row.title || `要在 ${row.host || '这台机器'} 上执行`}${row.tool ? ` · ${row.tool}` : ''}`} query={query} /></p>
        <code className="cmd"><FindBits text={row.command} query={query} /></code>
        <div className="ap-actions">
          {row.choices.includes('once') && <button className="btn-p" onClick={() => onApprove(row.approvalId, 'once')}>批准一次<kbd>⌘↩</kbd></button>}
          {row.choices.includes('session') && <button className="btn" onClick={() => onApprove(row.approvalId, 'session')}>本会话允许</button>}
          {row.choices.includes('always') && <button className="btn" onClick={() => onApprove(row.approvalId, 'always')}>总是允许</button>}
          {row.choices.filter((c) => !['once', 'session', 'always', 'deny'].includes(c)).map((c) => <button key={c} className="btn" onClick={() => onApprove(row.approvalId, c)}>{c}</button>)}
          {row.choices.includes('deny') && <button className="btn-g" onClick={() => onApprove(row.approvalId, 'deny')}>拒绝<kbd>Esc</kbd></button>}
        </div>
        <div className="ap-meta"><b>绑定:</b>{row.host || '本机'} + 这条完整命令,改一个字都要重新批准 · <b>同一张卡</b>已推到手机,任一端处理即可{row.cwd ? ` · ${row.cwd}` : ''}</div>
      </div></div>
    );
    case 'sys': return <div className="frow"><div className="fl" /><div className={`fc sys ${row.tone === 'remote' ? 'remote' : row.tone === 'error' ? 'error' : ''}`}><FindBits text={row.text} query={query} /></div></div>;
    default: return null;
  }
}

export type ModelChoice = { provider: string; providerName: string; id: string; name: string; reasoning?: boolean; contextWindow?: number | null };

export function NewSessionBox({ machine, groups, models, defaultCwd, recentCwds, initialPrompt, initialModel, busy, onCancel, onCreate, onOpenSettings }: {
  machine: string; groups: Group[]; models: ModelChoice[]; defaultCwd: string; recentCwds?: string[]; initialPrompt?: string; initialModel?: string; busy: boolean;
  onCancel: () => void; onCreate: (input: { machine: string; cwd: string; prompt: string; model: string | null; policy: string }) => void; onOpenSettings: () => void;
}) {
  const [target, setTarget] = useState(machine);
  const [cwd, setCwd] = useState(() => {
    try { return pickInitialCwd(defaultCwd, localStorage.getItem(LAST_CWD_KEY) || ''); } catch { return pickInitialCwd(defaultCwd, ''); }
  });
  const [model, setModel] = useState<string>(() => {
    try { return pickInitialModel(models, initialModel || localStorage.getItem(LAST_MODEL_KEY) || ''); } catch { return pickInitialModel(models, initialModel || ''); }
  });
  const [policy, setPolicy] = useState(() => {
    try { return localStorage.getItem('leo2.defaultPolicy') || 'default'; } catch { return 'default'; }
  });
  const [prompt, setPrompt] = useState(initialPrompt ?? '');
  useEffect(() => { setTarget(machine); }, [machine]);
  useEffect(() => {
    try { setCwd(pickInitialCwd(defaultCwd, localStorage.getItem(LAST_CWD_KEY) || '')); }
    catch { setCwd(pickInitialCwd(defaultCwd, '')); }
  }, [defaultCwd]);
  useEffect(() => { setPrompt(initialPrompt ?? ''); }, [initialPrompt]);
  useEffect(() => {
    const remembered = (() => { try { return initialModel || localStorage.getItem(LAST_MODEL_KEY) || ''; } catch { return initialModel || ''; } })();
    if (models.length === 0) return;
    if (model && models.some((m) => `${m.provider}/${m.id}` === model) && !modelLikelyUnusable(model)) return;
    setModel(pickInitialModel(models, remembered));
  }, [models, model, initialModel]);
  const needModel = target === 'local' && models.length === 0;
  const submit = () => {
    if (!prompt.trim() || needModel) return;
    try {
      if (model) localStorage.setItem(LAST_MODEL_KEY, model);
      const nextCwd = cwd.trim();
      if (nextCwd) localStorage.setItem(LAST_CWD_KEY, nextCwd);
    } catch { /* ignore */ }
    onCreate({ machine: target, cwd: cwd.trim() || '~', prompt: prompt.trim(), model: model || null, policy });
  };
  return (
    <div className="newbox">
      {needModel && <div className="newbox-warn"><b>还没有可用的模型。</b>先到「设置」登录一个供应商、粘贴密钥,或录入兼容接口,再回来开会话。<button className="btn-s" onClick={onOpenSettings}>去设置</button></div>}
      {!needModel && modelLikelyUnusable(model) ? <div className="newbox-warn">这个模型当前 ChatGPT 登录可能用不了。开始后多半要换。</div> : null}
      <div className="row2">
        <div><label>机器</label><select value={target} onChange={(e) => setTarget(e.target.value)}>{groups.filter((g) => g.online || g.id === machine).map((g) => <option key={g.id} value={g.id}>{g.name}{g.id === 'local' ? '(本机)' : g.online ? '' : ' (待确认)'}</option>)}</select></div>
        <div><label>审批</label><select value={policy} onChange={(e) => setPolicy(e.target.value)}>{(['default', 'accept_edits', 'plan', 'auto'] as const).map((p) => <option key={p} value={p}>{POLICY_LABEL[p]}</option>)}</select></div>
      </div>
      <div><label>模型</label><select value={model} onChange={(e) => setModel(e.target.value)}>
        {target !== 'local' && <option value="">由那台机器决定</option>}
        {initialModel && !models.some((m) => `${m.provider}/${m.id}` === initialModel) ? <option value={initialModel}>{prettyModelName(initialModel)} · 原会话</option> : null}
        {models.map((m) => <option key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`}>{prettyModelName(m.id, m.name)} · {m.providerName}{modelChoiceHint(m) ? ` · ${modelChoiceHint(m)}` : ''}</option>)}
      </select></div>
      <div><label>目录</label><input value={cwd} onChange={(e) => setCwd(e.target.value)} className="mono" placeholder="~/项目路径" list="leo2-cwds" />
        {recentCwds && recentCwds.length > 0 && <datalist id="leo2-cwds">{recentCwds.map((c) => <option key={c} value={c} />)}</datalist>}
      </div>
      <div><label>第一句话</label><textarea autoFocus value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="要它做什么 · ↩ 开始,⇧↩ 换行" onKeyDown={(e) => { if (composerShouldSend(e) && prompt.trim()) { e.preventDefault(); submit(); } }} /></div>
      <div className="acts"><button className="btn-g" onClick={onCancel}>取消</button><button className="btn-s" onClick={submit} disabled={busy || !prompt.trim() || needModel}>开始</button></div>
    </div>
  );
}
