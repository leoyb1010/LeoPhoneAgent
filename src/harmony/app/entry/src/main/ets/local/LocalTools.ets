import { common } from '@kit.AbilityKit';
import { http } from '@kit.NetworkKit';
import { Copy } from '../theme/Copy';
import { collectionStore } from '../store/CollectionStore';
import { memoryStore } from '../store/MemoryStore';
import { skillStore } from '../store/SkillStore';
import { envStore } from '../store/EnvStore';
import { McpStore, mcpStore } from '../store/McpStore';
import { soulStore } from '../store/SoulStore';
import { browserStore } from '../store/BrowserStore';
import { WorkspaceStore } from '../store/WorkspaceStore';
import { InAppBrowser } from './InAppBrowser';
import { SensitiveToolGate } from './SensitiveToolGate';
import { WRITE_GRANT_MARK, allowOpenUrl, htmlToText, sandboxFileName, toolArg } from './LocalProtocol';

export class ToolResult {
  text: string = '';
  title: string = '';
  needWrite: boolean = false;
}

class FileReadPage {
  showStart: number = 1;
  showEnd: number = 0;
  totalLines: number = 0;
  content: string = '';
  truncated: boolean = false;
  nextOffset: number = 0;
}

export class LocalTools {
  static async hydrate(context: common.UIAbilityContext): Promise<void> {
    await Promise.all([
      memoryStore.load(context),
      skillStore.load(context),
      collectionStore.load(context),
      soulStore.load(context),
      envStore.load(context),
      mcpStore.load(context)
    ]);
  }

  static systemPrompt(): string {
    const parts: string[] = [
      '你是 LeoPhoneAgent 的本机 Agent，跑在这台鸿蒙手机上。',
      '不连中继也能工作。远程机器是另一条入口。',
      Copy.noLinux,
      '需要读文件、写文件、记事、打开链接或抓网页时，直接用 function calling，不要把工具写成普通文字。',
      '写沙箱文件必须等人确认。文件路径只用沙箱文件名，例如 notes.md。',
      '本机斜杠命令仍可用：/ls /read /write /remember /open。'
    ];
    const soul = soulStore.promptBlock();
    if (soul.length > 0) {
      parts.push(soul);
    }
    const memory = memoryStore.promptBlock();
    if (memory.length > 0) {
      parts.push(memory);
    }
    const skills = skillStore.promptBlock();
    if (skills.length > 0) {
      parts.push(skills);
    }
    const vault = collectionStore.promptBlock();
    if (vault.length > 0) {
      parts.push(vault);
    }
    const env = envStore.promptBlock();
    if (env.length > 0) {
      parts.push(env);
    }
    const mcp = mcpStore.promptBlock();
    if (mcp.length > 0) {
      parts.push(mcp);
    }
    return parts.join('\n\n');
  }

  static listSandbox(context: common.UIAbilityContext): string {
    const rows = WorkspaceStore.list(context);
    if (rows.length === 0) {
      return '沙箱是空的';
    }
    return rows.map((row) => `${row.name} · ${row.size}`).join('\n');
  }

  static readSandbox(context: common.UIAbilityContext, name: string): string {
    return WorkspaceStore.read(context, sandboxFileName(name));
  }

  static writeSandbox(context: common.UIAbilityContext, name: string, text: string,
    owner: string = ''): string {
    const gate = SensitiveToolGate.fileWrite();
    if (gate.askFirst && !SensitiveToolGate.consumeWriteGrant(owner)) {
      return WRITE_GRANT_MARK;
    }
    WorkspaceStore.write(context, sandboxFileName(name), text);
    return `已写入 ${sandboxFileName(name)}`;
  }

  static openLink(raw: string, newTab: boolean = false): string {
    const err = InAppBrowser.open(raw, newTab);
    return err.length > 0 ? err : (newTab ? '已在应用内打开新标签' : '已在应用内打开');
  }

  /** owner：发起这次工具调用的会话。写沙箱的授权按它配对，远程/定时链路拿不到本机用户的授权。 */
  static async run(context: common.UIAbilityContext, name: string, args: string,
    owner: string = ''): Promise<ToolResult> {
    const out = new ToolResult();
    out.title = toolArg(args, 'tool_title') || name;
    try {
      if (name === 'file_list') {
        out.text = LocalTools.listSandbox(context);
      } else if (name === 'file_read') {
        const path = sandboxFileName(toolArg(args, 'path'));
        const body = LocalTools.readSandbox(context, path);
        const offsetRaw = toolArg(args, 'offset');
        const linesRaw = toolArg(args, 'lines');
        const maxRaw = toolArg(args, 'max_length');
        const direction = toolArg(args, 'direction') || 'head';
        const offset = offsetRaw.length > 0 ? Number(offsetRaw) : 1;
        const hasLines = linesRaw.length > 0;
        const requested = hasLines ? Number(linesRaw) : 0;
        const maxLength = maxRaw.length > 0 ? Number(maxRaw) : 15000;
        out.text = LocalTools.formatFileRead(path, body.length, LocalTools.pageFile(
          body.split('\n'), offset, requested, hasLines, maxLength, direction));
      } else if (name === 'file_write') {
        const written = LocalTools.writeSandbox(context, toolArg(args, 'path'), toolArg(args, 'content'),
          owner);
        if (written === WRITE_GRANT_MARK) {
          out.needWrite = true;
          out.text = '写文件需要你先点「允许写这次」';
        } else {
          out.text = written;
        }
      } else if (name === 'file_edit') {
        const path = sandboxFileName(toolArg(args, 'path'));
        const old = toolArg(args, 'old');
        const next = toolArg(args, 'new');
        const body = LocalTools.readSandbox(context, path);
        if (body.indexOf(old) < 0) {
          out.text = '文件里没有这段原文';
        } else {
          const written = LocalTools.writeSandbox(context, path, body.split(old).join(next), owner);
          if (written === WRITE_GRANT_MARK) {
            out.needWrite = true;
            out.text = '改文件需要你先点「允许写这次」';
          } else {
            out.text = written;
          }
        }
      } else if (name === 'memory_write') {
        await memoryStore.load(context);
        await memoryStore.appendToday(context, toolArg(args, 'content'));
        out.text = '已写入今日记忆';
      } else if (name === 'memory_get') {
        await memoryStore.load(context);
        out.text = memoryStore.search(toolArg(args, 'scope') || 'all', toolArg(args, 'keywords'));
      } else if (name === 'open_url') {
        out.text = LocalTools.openLink(toolArg(args, 'url'));
      } else if (name === 'web_fetch') {
        out.text = await LocalTools.fetchPage(toolArg(args, 'url'));
      } else if (name === 'browser_use') {
        out.text = LocalTools.browser(toolArg(args, 'action'), toolArg(args, 'url'), toolArg(args, 'tab_id'));
      } else if (name === 'mcp_call') {
        const server = mcpStore.find(toolArg(args, 'server'));
        if (!server) {
          out.text = '没有这个 MCP 服务器';
        } else {
          out.text = await McpStore.call(server, toolArg(args, 'name'), toolArg(args, 'arguments'));
        }
      } else {
        out.text = `没有这个工具：${name}`;
      }
    } catch (err) {
      out.text = `${err}`;
    }
    return out;
  }

  private static browser(action: string, url: string, tabId: string): string {
    if (action === 'list_tabs') {
      return browserStore.list();
    }
    if (action === 'close_tab') {
      browserStore.close(tabId);
      return tabId.length > 0 ? `已关 ${tabId}` : '没有这个标签';
    }
    if (action === 'switch_tab') {
      const hit = browserStore.select(tabId);
      return hit ? `已切到 ${hit.id} ${hit.url}` : '没有这个标签';
    }
    if (action === 'get_text') {
      const current = browserStore.active();
      return current ? `当前标签 ${current.id} ${current.url}。正文请再用 web_fetch。` : '没有标签';
    }
    if (action === 'new_tab') {
      return LocalTools.openLink(url, true);
    }
    if (action === 'navigate' || action.length === 0) {
      return LocalTools.openLink(url);
    }
    return `不支持的浏览器动作：${action}`;
  }

  private static async fetchPage(raw: string): Promise<string> {
    const reason = allowOpenUrl(raw);
    if (reason.length > 0) {
      return reason;
    }
    const url = raw.trim();
    if (!url.toLowerCase().startsWith('https://')) {
      return '抓网页只用 https';
    }
    const req = http.createHttp();
    try {
      const resp = await req.request(url, {
        method: http.RequestMethod.GET,
        header: {
          'Accept': 'text/html,text/plain,*/*',
          'User-Agent': 'LeoPhoneAgent-Harmony'
        },
        connectTimeout: 20000,
        readTimeout: 20000
      });
      if (resp.responseCode < 200 || resp.responseCode >= 300) {
        return `http ${resp.responseCode}`;
      }
      const body = htmlToText(`${resp.result}`);
      if (body.length > 20000) {
        return `${body.substring(0, 20000)}\n... (truncated)`;
      }
      return body.length > 0 ? body : '页面没有可读文字';
    } finally {
      req.destroy();
    }
  }

  /** Same pagination contract as Android FileReadPaging / protocol fileReadPage. */
  private static pageFile(allLines: string[], offset: number, requestedLines: number,
    hasLineLimit: boolean, maxLength: number, direction: string): FileReadPage {
    const total = allLines.length;
    const cap = Math.max(1, Math.min(maxLength, 80000));
    const page = new FileReadPage();
    page.totalLines = total;
    if (total === 0) {
      return page;
    }
    const isTail = direction.toLowerCase() === 'tail';
    let selected: string[] = [];
    let showStart = 1;
    if (isTail) {
      const count = hasLineLimit ? requestedLines : total;
      const start = Math.max(0, total - count);
      selected = allLines.slice(start, total);
      showStart = start + 1;
    } else {
      const start = Math.min(Math.max(0, Math.max(offset, 1) - 1), total);
      const end = hasLineLimit ? Math.min(start + Math.max(requestedLines, 0), total) : total;
      selected = allLines.slice(start, end);
      showStart = selected.length === 0 ? Math.max(offset, 1) : start + 1;
    }
    return LocalTools.clipFile(selected, showStart, total, cap, isTail);
  }

  private static clipFile(selected: string[], showStart: number, total: number, cap: number,
    isTail: boolean): FileReadPage {
    const page = new FileReadPage();
    page.showStart = showStart;
    page.totalLines = total;
    if (selected.length === 0) {
      page.showEnd = showStart - 1;
      return page;
    }
    const joined = selected.join('\n');
    if (joined.length <= cap) {
      page.showEnd = showStart + selected.length - 1;
      page.content = joined;
      page.nextOffset = (!isTail && page.showEnd < total) ? page.showEnd + 1 : 0;
      return page;
    }
    let used = 0;
    let complete = 0;
    for (let i = 0; i < selected.length; i++) {
      const extra = complete === 0 ? 0 : 1;
      if (used + extra + selected[i].length > cap) {
        break;
      }
      used += extra + selected[i].length;
      complete++;
    }
    page.truncated = true;
    if (complete === 0) {
      page.showEnd = showStart;
      page.content = selected[0].substring(0, cap);
      page.nextOffset = isTail ? 0 : showStart + 1;
      return page;
    }
    page.showEnd = showStart + complete - 1;
    page.content = selected.slice(0, complete).join('\n');
    page.nextOffset = (!isTail && page.showEnd < total) ? page.showEnd + 1 : 0;
    return page;
  }

  private static formatFileRead(path: string, size: number, page: FileReadPage): string {
    const range = (page.totalLines === 0 || page.showEnd < page.showStart)
      ? 'showing 0-0 of 0'
      : `showing ${page.showStart}-${page.showEnd} of ${page.totalLines}`;
    const trunc = page.truncated ? ' (truncated at 80000 chars or requested max_length)' : '';
    const header = `[${path} | ${size} bytes | ${page.totalLines} lines | ${range}${trunc}]`;
    const next = page.nextOffset > 0 ? `\nnext_offset: ${page.nextOffset}` : '';
    return `${header}\n${page.content}${next}`;
  }
}
