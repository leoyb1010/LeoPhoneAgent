import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {describe,it,expect,vi}from'vitest';import {testEnvironment}from'./test.js';
describe('OpenCode authoritative model rejection is a configuration failure',()=>{
 for(const phase of ['models','run'])it(`blocks a ProviderModelNotFoundError during ${phase}`,async()=>{
 const nativeTimeout=globalThis.setTimeout;const backoff=vi.spyOn(globalThis,'setTimeout').mockImplementation(((callback:Parameters<typeof setTimeout>[0],delay?:number,...args:unknown[])=>nativeTimeout(callback,[2000,4000].includes(delay??0)?0:delay,...args)) as typeof setTimeout);
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'opencode-rejection-'));const command=path.join(root,'opencode');
 await fs.writeFile(command,`#!/bin/sh\nif [ "$1" = "models" ]; then\n${phase==='models' ? "echo 'ProviderModelNotFoundError: configured model unavailable' >&2; exit 1" : "echo 'opencode/fixture'; exit 0"}\nfi\necho 'ProviderModelNotFoundError: configured model unavailable' >&2\nexit 1\n`,{mode:0o700});
 try{const result=await testEnvironment({companyId:'fixture',adapterType:'opencode_local',config:{cwd:root,command:'opencode',model:'opencode/fixture',env:{PATH:`${root}${path.delimiter}${process.env.PATH??''}`}}});expect(result.status).toBe('fail');expect(result.checks).toEqual(expect.arrayContaining([expect.objectContaining({code:'opencode_hello_probe_model_unavailable',level:'error'})]));}finally{backoff.mockRestore();await fs.rm(root,{recursive:true,force:true});}
 }, 10000);
});
