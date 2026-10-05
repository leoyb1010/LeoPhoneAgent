import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
const state = vi.hoisted(() => ({ custom: false }));
vi.mock('./detect-model.js', async importOriginal => ({
  ...await importOriginal<typeof import('./detect-model.js')>(),
  detectModel: async () => state.custom ? {model:'fixture-model', provider:'leostudio', baseUrl:'https://fixture.invalid', apiMode:'chat_completions', hasApiKey:false} : null,
}));
import {buildHermesBaseEnv, execute} from './execute.js';
import {testEnvironment} from './test.js';
const roots:string[]=[];
afterEach(async () => {state.custom=false; vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(root=>fs.rm(root,{recursive:true,force:true})));});
async function fixture(body:string, env:Record<string,string>={}) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'round2-hermes-')); roots.push(root);
  const command=path.join(root,'hermes');
  await fs.writeFile(command, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 'Fixture Hermes 1.0'; exit 0; fi\n${body}\n`, {mode:0o700});
  return {command,cwd:root,model:'fixture-model',env};
}
function context(config:Record<string,unknown>) {
  return {runId:'server-run', authToken:'fixture-server-token', agent:{id:'server-agent',companyId:'server-company',name:'fixture',adapterType:'hermes_local',adapterConfig:config}, runtime:{sessionId:null,sessionParams:null,sessionDisplayId:null,taskKey:null},config,context:{taskId:'server-task'},onLog:async()=>{},onMeta:async()=>{}};
}
async function probe(config:Record<string,unknown>) { return testEnvironment({companyId:'fixture',adapterType:'hermes_local',config}); }
describe('ROUND2 Hermes actual probe/execute contracts', () => {
  it('does not let hello hide a parsed fatal error, even at exit zero, or reflect credential-like stderr in checks', async () => {
    const config=await fixture("echo hello; echo 'error: provider rejected fixture-secret-sentinel' >&2; exit 0");
    const actual=await execute(context(config) as never);
    expect(actual.exitCode).toBe(0); expect(actual.errorMessage).toContain('provider rejected');
    const result=await probe(config);
    expect(result.status).toBe('fail');
    expect(result.checks.some(check=>check.code==='hermes_hello_probe_failed'&&check.level==='error')).toBe(true);
    expect(result.checks.some(check=>check.code==='hermes_hello_probe_passed')).toBe(false);
    expect(JSON.stringify(result)).not.toContain('fixture-secret-sentinel');
  });
  it('filters the complete configured reserved namespace, preserving trusted inherited and ordinary CLI env', () => {
    vi.stubEnv('PAPERCLIP_INSTANCE_ID','server-instance');
    const config={env:{PAPERCLIP_TASK_ID:'forged-task',PAPERCLIP_AGENT_ID:'forged-agent',PAPERCLIP_API_URL:'https://forged.invalid',paperclip_task_id:'forged-lowercase',Paperclip_Agent_ID:'forged-mixedcase',PAPERCLIP_FUTURE_RUNTIME_KEY:'forged-future',PAPERCLIP_INSTANCE_ID:'forged-instance',PAPERCLIP_API_KEY:'forged-secret',PAPERCLIP_WAKE_PAYLOAD_JSON:'forged-wake',HERMES_ROUTE_SENTINEL:'kept',HTTPS_PROXY:'http://fixture.invalid:1234'}};
    const env=buildHermesBaseEnv(config);
    expect(env.PAPERCLIP_INSTANCE_ID).toBe('server-instance');
    for (const [key,value] of Object.entries(config.env)) if(key.toUpperCase().startsWith('PAPERCLIP_')) expect(env[key]).not.toBe(value);
    expect(env.HERMES_ROUTE_SENTINEL).toBe('kept');expect(env.HTTPS_PROXY).toBe('http://fixture.invalid:1234');
  });
  it('injects authoritative execution identity while the selftest never carries a forged task/agent/API endpoint', async () => {
    const config=await fixture('if [ "$1" = "chat" ]; then\n if [ "$PAPERCLIP_RUN_ID" = "server-run" ]; then\n  [ "$PAPERCLIP_AGENT_ID" = "server-agent" ] && [ "$PAPERCLIP_TASK_ID" = "server-task" ] && [ "$PAPERCLIP_API_KEY" = "fixture-server-token" ] || exit 42\n else\n  [ "$PAPERCLIP_TASK_ID" != "forged-task" ] && [ "$PAPERCLIP_AGENT_ID" != "forged-agent" ] || exit 43\n fi\n [ "$PAPERCLIP_API_URL" != "https://forged.invalid" ] && [ -z "$paperclip_task_id" ] && [ -z "$Paperclip_Agent_ID" ] || exit 44\nfi\necho hello', {PAPERCLIP_TASK_ID:'forged-task',PAPERCLIP_AGENT_ID:'forged-agent',PAPERCLIP_API_URL:'https://forged.invalid',paperclip_task_id:'forged-task',Paperclip_Agent_ID:'forged-agent'});
    const actual=await execute(context(config) as never);expect(actual.exitCode).toBe(0);expect(actual.errorMessage).toBeUndefined();
    const result=await probe(config); expect(result.checks.some(check=>check.code==='hermes_hello_probe_passed')).toBe(true);
  });
  it('keeps custom CLI routing informational only when the real child returns hello', async () => {
    state.custom=true;
    const config=await fixture('echo hello');
    const result=await probe(config);
    expect(result.status).toBe('pass');
    expect(result.checks.find(check=>check.code==='hermes_provider_unsupported')?.level).toBe('info');
    expect(result.checks.find(check=>check.code==='hermes_no_api_keys')?.level).toBe('info');
  });
  it('never downgrades a failing custom route or an invalid explicit provider', async () => {
    state.custom=true;
    const config=await fixture("echo hello; echo 'error: rejected custom route' >&2");
    expect((await probe(config)).status).toBe('fail');
    const invalid=await probe({...config,provider:'invalid-provider'});
    expect(invalid.status).toBe('fail');
    expect(invalid.checks.find(check=>check.code==='hermes_provider_invalid')?.level).toBe('error');
    expect(invalid.checks.some(check=>check.code==='hermes_hello_probe_passed')).toBe(false);
  });
});
