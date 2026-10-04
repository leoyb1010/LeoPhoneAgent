// @vitest-environment jsdom
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NewAgentSetup } from './NewAgentSetup';
const mocks = vi.hoisted(() => ({ models: vi.fn(async (_company: string, _adapter: string, _options: { provider?: string }) => []), test: vi.fn(async (_options: { adapterType: string; aiConnection?: unknown }) => ({ adapterType:'opencode_local', status:'pass', checks:[], testedAt:'2026-10-04T00:00:00Z' })), create:vi.fn(), managed:vi.fn() }));
vi.mock('@/context/CompanyContext',()=>({useCompany:()=>({selectedCompanyId:'company-1'})}));
vi.mock('@/context/DialogContext',()=>({useDialogActions:()=>({openNewIssue:vi.fn()})}));
vi.mock('@/lib/router',()=>({useNavigate:()=>vi.fn(),useSearchParams:()=>[new URLSearchParams({name:'OpenCode fixture',adapterType:'opencode_local'})]}));
vi.mock('@/hooks/useCloudInstance',()=>({useCloudInstance:()=>false}));
vi.mock('../../hooks/useAgentAppearanceDraft',()=>({useAgentAppearanceDraft:()=>({})}));
vi.mock('@/api/adapters',()=>({adaptersApi:{list:async()=>[{type:'opencode_local',loaded:true,disabled:false}]}}));
vi.mock('@/api/agents',()=>({agentsApi:{list:async()=>[], adapterModels:mocks.models,create:mocks.create}}));
vi.mock('@/api/environments',()=>({environmentsApi:{list:async()=>[{id:'local',driver:'local',status:'active',name:'Mini',config:{},metadata:{defaultForInstance:true}}],capabilities:async()=>({sandboxProviders:{}})}}));
vi.mock('@/api/instanceSettings',()=>({instanceSettingsApi:{get:async()=>({defaultEnvironmentId:null}),getExperimental:async()=>({}),getGeneral:async()=>({executionMode:'any'})}}));
vi.mock('@/api/health',()=>({healthApi:{get:async()=>({nativeAdapterLoginSupported:true})}}));
vi.mock('@/api/secrets',()=>({secretsApi:{list:async()=>[],listMyUserSecrets:async()=>[]}}));
vi.mock('@/adapters',()=>({getUIAdapter:(type:string)=>({buildAdapterConfig:({model,envBindings}:{model?:string;envBindings:object})=>({model,env:envBindings}),type})}));
vi.mock('@/lib/test-agent-setup',()=>({testAgentSetup:mocks.test}));
vi.mock('../AgentConfigForm',()=>({ModelDropdown:({value,onChange}:{value:string;onChange:(value:string)=>void})=><input aria-label="Fixture model" value={value} onChange={event=>onChange(event.target.value)}/>}));
vi.mock('../ai-connections/AiConnectionField',()=>({aiProviderForAdapter:(type:string)=>type==='opencode_local'?'openrouter':undefined,AiConnectionField:(props:{value?:object;onChange:(value:object)=>void})=>{mocks.managed(props);return <button type="button" onClick={()=>props.onChange({provider:'openrouter',method:'api_key',mode:'shared',connectionId:'owned-account',grantId:'owned-grant'})}>选择已有 OpenRouter 账号</button>;}}));
let root:Root;let host:HTMLDivElement;let client:QueryClient;
afterEach(()=>{flushSync(()=>root?.unmount());host?.remove();client?.clear();vi.clearAllMocks();});
async function mount(){host=document.createElement('div');document.body.appendChild(host);root=createRoot(host);client=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});flushSync(()=>root.render(<QueryClientProvider client={client}><NewAgentSetup/></QueryClientProvider>));await vi.waitFor(()=>expect(client.isFetching()).toBe(0));await vi.waitFor(()=>expect(host.querySelector('input[aria-label="Fixture model"]')).not.toBeNull());}
function click(text:string){const button=[...host.querySelectorAll('button')].find(b=>b.textContent?.includes(text))!;expect(button).toBeTruthy();flushSync(()=>button.click());}
function selectProvider(value:string){flushSync(()=>{const select=host.querySelector('select[aria-label="API 密钥提供商"],select[aria-label="API key provider"]') as HTMLSelectElement;expect(select).not.toBeNull();select.value=value;select.dispatchEvent(new Event('change',{bubbles:true}));});}
function setModel(value:string){flushSync(()=>{const input=host.querySelector('input[aria-label="Fixture model"]') as HTMLInputElement;Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));});}
describe('OpenCode CLI and provider selection are independent',()=>{
 it('does not initialize a managed OpenRouter binding when choosing OpenCode',async()=>{await mount();expect(host.textContent).toContain('OpenCode CLI');expect(host.querySelector('select[aria-label="API 密钥提供商"],select[aria-label="API key provider"]')).not.toBeNull();expect(mocks.managed).not.toHaveBeenCalled();expect(mocks.models.mock.calls[0][2]).toEqual({provider:undefined});expect(mocks.create).not.toHaveBeenCalled();});
 it.each([['openai','OPENAI_API_KEY'],['anthropic','ANTHROPIC_API_KEY']])('selects %s with its existing API environment key, preserving the CLI adapter',async(provider,key)=>{await mount();selectProvider(provider);expect(host.querySelector(`input[aria-label="${key}"]`)).not.toBeNull();setModel(`${provider}/fixture-model`);click('运行测试');await vi.waitFor(()=>expect(mocks.test).toHaveBeenCalled());expect(mocks.test.mock.calls.at(-1)![0]).toMatchObject({adapterType:'opencode_local',aiConnection:undefined});expect(mocks.create).not.toHaveBeenCalled();});
 it('keeps existing managed connections available only after explicit choice, and can return to CLI configuration',async()=>{await mount();click('可选：使用 OpenRouter 连接管理');expect(mocks.managed.mock.calls.at(-1)![0].value).toBeUndefined();click('选择已有 OpenRouter 账号');expect(mocks.managed.mock.calls.at(-1)![0].value).toMatchObject({provider:'openrouter',mode:'shared',connectionId:'owned-account',grantId:'owned-grant'});expect(host.querySelector('select[aria-label="API 密钥提供商"],select[aria-label="API key provider"]')).toBeNull();click('使用服务器 OpenCode 配置');expect(host.querySelector('select[aria-label="API 密钥提供商"],select[aria-label="API key provider"]')).not.toBeNull();expect(mocks.create).not.toHaveBeenCalled();});
});
