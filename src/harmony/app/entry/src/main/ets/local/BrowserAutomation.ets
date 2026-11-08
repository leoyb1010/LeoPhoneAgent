import { webview } from '@kit.ArkWeb';
import { browserStore } from '../store/BrowserStore';
import { SensitiveToolGate } from './SensitiveToolGate';
import { toolArg, WRITE_GRANT_MARK } from './LocalProtocol';

/** 只操作当前可见的 ArkWeb，页面离开后立即解除绑定。 */
export class BrowserAutomation {
  private static owner: string = '';
  private static foreground: boolean = false;
  private static revision: number = 0;
  private static controller: webview.WebviewController | null = null;

  static attach(controller: webview.WebviewController, owner: string): void {
    BrowserAutomation.controller = controller;
    BrowserAutomation.owner = owner;
    BrowserAutomation.revision++;
  }

  static detach(controller: webview.WebviewController): void {
    if (BrowserAutomation.controller === controller) {
      BrowserAutomation.controller = null;
      BrowserAutomation.owner = '';
      BrowserAutomation.revision++;
    }
  }

  static setForeground(value: boolean): void {
    BrowserAutomation.foreground = value;
    BrowserAutomation.revision++;
  }

  static async run(action: string, args: string, owner: string, unattended: boolean,
    isCurrent: () => boolean = () => true): Promise<string> {
    if (unattended || !owner || owner !== BrowserAutomation.owner || !BrowserAutomation.foreground || !isCurrent()) {
      throw new Error('请在发起此操作的本机前台对话中打开浏览页');
    }
    const revision = BrowserAutomation.revision;
    const controller = BrowserAutomation.controller;
    if (!controller || !browserStore.active()) throw new Error('请先打开应用内浏览页，再执行页面操作');
    const origin = /^(https?:\/\/(?:\[[0-9a-fA-F:]+\]|[A-Za-z0-9.-]+)(?::[0-9]{1,5})?)(?:[/?#]|$)/.exec(controller.getUrl());
    if (!origin) throw new Error('页面尚未载入可访问的网址，请稍后重试');
    SensitiveToolGate.setResource(owner, origin[1].toLowerCase());
    const readOnly = ['get_text', 'get_backbone', 'snapshot'].indexOf(action) >= 0;
    if (!readOnly && !SensitiveToolGate.consumeWriteGrant(owner)) return WRITE_GRANT_MARK + 'browser_use';
    const selector = JSON.stringify(toolArg(args, 'selector'));
    let script = '';
    if (action === 'get_text') {
      script = 'JSON.stringify({title:document.title,url:location.href,text:(document.body?.innerText||"" ).slice(0,50000)})';
    } else if (action === 'get_backbone' || action === 'snapshot') {
      script = 'JSON.stringify({title:document.title,url:location.href,elements:Array.from(document.querySelectorAll("a,button,input,textarea,select,[role=button]" )).slice(0,300).map((e,i)=>({index:i,tag:e.tagName,text:(e.innerText||e.getAttribute("aria-label")||e.getAttribute("placeholder")||"" ).slice(0,200),id:e.id,type:e.type,href:e.getAttribute("href")}))})';
    } else if (action === 'click') {
      script = `(()=>{const e=document.querySelector(${selector});if(!e)throw Error('找不到元素');e.click();return '已点击'})()`;
    } else if (action === 'fill' || action === 'type') {
      const text = JSON.stringify(toolArg(args, 'text'));
      script = `(()=>{const e=document.querySelector(${selector});if(!e||!('value' in e))throw Error('找不到可输入元素');const p=e instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;const s=Object.getOwnPropertyDescriptor(p,'value').set;s.call(e,${text});e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));return '已填写'})()`;
    } else if (action === 'scroll') {
      const raw = Number(toolArg(args, 'amount') || '600');
      if (!Number.isFinite(raw)) throw new Error('滚动距离需要数字');
      const amount = Math.max(-5000, Math.min(5000, raw));
      const distance = toolArg(args, 'direction') === 'up' ? -Math.abs(amount) : amount;
      script = `window.scrollBy(0,${distance});JSON.stringify({x:scrollX,y:scrollY})`;
    } else if (action === 'evaluate') {
      script = toolArg(args, 'script');
      if (script.length === 0 || script.length > 20000) throw new Error('脚本为空或超过20000字符');
    } else if (action === 'back') {
      if (controller.accessBackward()) controller.backward();
      return '已请求后退';
    } else if (action === 'forward') {
      if (controller.accessForward()) controller.forward();
      return '已请求前进';
    } else if (action === 'reload') {
      controller.refresh();
      return '已请求重新加载';
    } else {
      throw new Error(`不支持的页面操作：${action}`);
    }
    // 内容只作为工具结果返回，网页文字不能修改授权或工具集合。
    const guarded = 'if(document.hidden)throw Error("页面已隐藏");\n' + script;
    if (!isCurrent() || revision !== BrowserAutomation.revision) throw new Error('浏览器操作已取消');
    const result = await controller.runJavaScript(guarded);
    if (!isCurrent() || revision !== BrowserAutomation.revision) throw new Error('浏览器操作已取消');
    return result.substring(0, 60000);
  }
}
