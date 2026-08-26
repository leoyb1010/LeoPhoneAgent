export class LeoRelease {
  version: string = '';
  date: string = '';
  title: string = '';
  highlights: string[] = [];
}

export class ReleaseCatalog {
  static readonly currentVersion: string = '0.3.0-alpha.15';
  static readonly currentBuild: number = 100020;

  static all(): LeoRelease[] {
    const first = new LeoRelease();
    first.version = '0.3.0-alpha.15';
    first.date = '2026-08-26';
    first.title = '青绿脸 + 四组设置';
    first.highlights = [
      '强调色从橙红改成和其他端一样的青绿。',
      '设置改成同一四组：我的设备 / Agent / 外观与通用 / 数据与关于。'
    ];
    const prev = new LeoRelease();
    prev.version = '0.3.0-alpha.14';
    prev.date = '2026-08-20';
    prev.title = 'Kimi 确认页带设备码';
    prev.highlights = [
      'Kimi 登录直接打开带设备码的确认页，登录后不用再手抄顶栏那串码。'
    ];
    const kimi = new LeoRelease();
    kimi.version = '0.3.0-alpha.13';
    kimi.date = '2026-08-20';
    kimi.title = 'Kimi 确认页能打开';
    kimi.highlights = [
      'Kimi 设备码登录直接打开确认页，不再先停在空白再超时。打不开时仍显示设备码，可复制链接。'
    ];
    const detail = new LeoRelease();
    detail.version = '0.3.0-alpha.12';
    detail.date = '2026-08-20';
    detail.title = '详情页能拉到按钮';
    detail.highlights = [
      '供应商详情里「从上游拉取」和「用作当前」不再被长模型列表顶出屏幕。切换供应商先点名字再展开模型。'
    ];
    const scroll = new LeoRelease();
    scroll.version = '0.3.0-alpha.11';
    scroll.date = '2026-08-20';
    scroll.title = '吐字跟着滚';
    scroll.highlights = [
      '本机对话吐字时，列表跟着滚到最新一句，不用再手滑下去看。'
    ];
    const login = new LeoRelease();
    login.version = '0.3.0-alpha.10';
    login.date = '2026-08-20';
    login.title = '登录打不开会说明';
    login.highlights = [
      '登录页停在空白时不再当成已经打开。八秒后出现「页面打不开」和复制链接，不跳系统浏览器。'
    ];
    const icons = new LeoRelease();
    icons.version = '0.3.0-alpha.9';
    icons.date = '2026-08-20';
    icons.title = '图标和逐字回复';
    icons.highlights = [
      '设置、会话、说话、识图、朗读不再用单个汉字当图标，改成系统图标。',
      '本机对话按帧往气泡上刷字。供应商没配完也能点切换，换回已经配好的那一家。'
    ];
    const layout = new LeoRelease();
    layout.version = '0.3.0-alpha.8';
    layout.date = '2026-08-20';
    layout.title = '排版不再切字';
    layout.highlights = [
      '竖屏不再按内屏宽度强行左右分栏。会话改成卡片，设置分区改成中文。',
      '对话气泡不再切掉左边的字，发送键不再挤成省略号。供应商详情的模型列表可点选，保存钉在底部。'
    ];
    const model = new LeoRelease();
    model.version = '0.3.0-alpha.7';
    model.date = '2026-08-20';
    model.title = '当前模型会跟着变';
    model.highlights = [
      '在详情页换完模型回到首页，「选择执行模型」会显示刚选的那个，不再停在上一份名字。'
    ];
    const pick = new LeoRelease();
    pick.version = '0.3.0-alpha.6';
    pick.date = '2026-08-20';
    pick.title = '选模型能点进去';
    pick.highlights = [
      '加完供应商回到首页，「选择执行模型」会解锁，点进去就能换当前模型。不再停在请先完成上一步。',
      '登录授权不再跳系统浏览器。打不开就停在本页中文说明并可复制链接。'
    ];
    const blank = new LeoRelease();
    blank.version = '0.3.0-alpha.5';
    blank.date = '2026-08-20';
    blank.title = '登录页不再白屏';
    blank.highlights = [
      'OpenAI 登录被地区拦截时，不再把 403 JSON 和「美观输出」铺满屏幕。改成中文说明，并给出复制链接、系统浏览器。',
      '登录页一打开就提示需要境外网络。8 秒打不开也会收掉网页。'
    ];
    const chain = new LeoRelease();
    chain.version = '0.3.0-alpha.4';
    chain.date = '2026-08-20';
    chain.title = '供应商贯通';
    chain.highlights = [
      '添加供应商保存后进入选模型，新实例自动设为当前。本机聊天顶栏可切换供应商和模型。',
      '登录网页打不开会写出原因，可复制链接或用系统浏览器。OpenAI / Claude 会提示需要境外网络。',
      '冷启动后当身体和定时任务会先读供应商档案。定时结果写入「定时·标题」会话，失败原因留在定时页。'
    ];
    const codex = new LeoRelease();
    codex.version = '0.3.0-alpha.3';
    codex.date = '2026-08-20';
    codex.title = 'Codex 能聊';
    codex.highlights = [
      'OpenAI 选 OAuth 登录后，本机对话走 chatgpt.com Codex Responses，和 Fold8 同一条后端，不再拿会话 token 去打 Chat Completions。',
      '刷新 token、Chatgpt-Account-Id、function_call 工具回传都接上了。上一版只登录不聊天的半截拿掉。'
    ];
    const oauth = new LeoRelease();
    oauth.version = '0.3.0-alpha.2';
    oauth.date = '2026-08-20';
    oauth.title = '供应商 OAuth';
    oauth.highlights = [
      '添加供应商按 Fold8 列出这一家真能用的登录：OpenAI / Anthropic / OpenRouter 有 OAuth，Kimi / xAI 设备码排前面，Gemini 只有 API Key。',
      '点 OAuth 在本页打开登录网页，拦 localhost 回调换 token。不再灰一行「设备码」，打开网页也不会把轮询取消。'
    ];
    const body = new LeoRelease();
    body.version = '0.3.0-alpha.1';
    body.date = '2026-08-20';
    body.title = '鸿蒙当身体';
    body.highlights = [
      '打开「当身体」后向中继注册 platform=harmony。iPhone 列表会出现这台机，发的话在本机工具循环里跑。',
      '本机补齐：Kimi/xAI 设备码、语音说/读、Push Kit 要 token、Markdown、识图落盘、模型组失败换、用量 token。',
      '鸿蒙 NEXT 跑不了 Android 那份 PRoot。Push 没配 AGC 时杀进程后仍收不到。'
    ];
    const tools = new LeoRelease();
    tools.version = '0.2.0-alpha.3';
    tools.date = '2026-08-20';
    tools.title = '本机工具循环';
    tools.highlights = [
      '本机对话会走工具循环：读/写/改沙箱文件、记事、打开链接、抓 https 网页。',
      '写文件仍要你点「允许写这次」。没有 Linux 命令，也不做无障碍跨应用。',
      '供应商、深浅色、设置分区保持上一版。远程机器仍是第二个入口。'
    ];
    const providers = new LeoRelease();
    providers.version = '0.2.0-alpha.2';
    providers.date = '2026-08-19';
    providers.title = '供应商和深浅色对齐 Fold8';
    providers.highlights = [
      '供应商按 Fold8 录入：先选类型，再选 API Key，再填身份和接口。多实例、拉 /models、模型组。',
      '外观跟随系统，也可锁浅色或深色；状态栏一起变。启动会话、回车发送、常亮都在外观里。',
      '设置分区对齐 Fold8：供应商、外观、远程机器/中继、技能、Soul、记忆、藏宝阁、环境变量、用量。',
      '没有 Linux 沙箱，也不做无障碍跨应用。远程机器仍是第二个入口。'
    ];
    const local = new LeoRelease();
    local.version = '0.2.0-alpha.1';
    local.date = '2026-08-19';
    local.title = '本机 Agent 对齐 Fold8';
    local.highlights = [
      '本机也能对话：配 OpenAI 兼容供应商后不连中继也能聊，会话落盘，链接应用内打开。',
      'Pura X Max 内屏按 Fold8：左栏自带 Leo 顶栏，会话行 44 图标 + 13 相对时间，左右 56 新任务/搜索。',
      '长按会话可置顶、复制、归档、删除；记忆、技能、藏宝阁和沙箱文件在设置里。',
      '没有 Linux 沙箱，也不做无障碍跨应用。远程机器仍是第二个入口。'
    ];
    const previous = new LeoRelease();
    previous.version = '0.1.0-alpha.2';
    previous.date = '2026-08-19';
    previous.title = 'Pura X Max 完整控制面';
    previous.highlights = [
      '图标、启动页和深色界面按产品做完，不再是三张空卡片。',
      '适配 Pura X Max：外屏单栏远程机器，展开内屏左右分栏（列表 + 新任务）。',
      '中继钥匙、刷新舰队、新任务、断线续传、审批都在这一版里。',
      '本机 Agent 和鸿蒙当身体仍是后面两艘船，设置页写清楚，不装成已开。'
    ];
    const firstShip = new LeoRelease();
    firstShip.version = '0.1.0-alpha.1';
    firstShip.date = '2026-08-19';
    firstShip.title = '鸿蒙瘦控制面';
    firstShip.highlights = [
      '填中继钥匙后读取 /machines，不再写死三台 Mac。',
      '可对在线 Mac 或 Android 身体开新任务，断线按序号续上。'
    ];
    return [first, prev, kimi, detail, scroll, login, icons, layout, model, pick, blank, chain, codex, oauth, body, tools, providers, local, previous, firstShip];
  }
}
