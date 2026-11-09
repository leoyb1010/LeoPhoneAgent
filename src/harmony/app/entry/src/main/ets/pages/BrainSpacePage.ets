import { AppNavigation } from '../navigation/AppNavigation';
import { common } from '@kit.AbilityKit';
import { promptAction } from '@kit.ArkUI';
import { fileIo } from '@kit.CoreFileKit';
import { webview } from '@kit.ArkWeb';
import { BrainAPI, BrainJSON, text, object, items, part } from '../brain/BrainAPI';
import { BrainUpload, BrainUploadJob } from '../brain/BrainUpload';
import { BrainCache } from '../brain/BrainCache';
import { BrainImage } from '../brain/BrainImage';
import { SecretStore } from '../store/SecretStore';
import { ActionButton, IconButton, SurfaceButton, Skeleton } from '../theme/Controls';
import { MotionPolicy } from '../theme/MotionPolicy';
import { Sym } from '../theme/Symbols';
import { curves } from '@kit.ArkUI';
import { Tokens } from '../theme/Tokens';

class BrainRow {
  id: string = '';
  title: string = '';
  body: string = '';
  kind: string = '';
  image: string = '';
  data: BrainJSON = {};
}
function row(data: BrainJSON, kind: string): BrainRow {
  const r = new BrainRow();
  r.id = text(data, 'id');
  r.title = text(data, 'title') || text(data, 'name') || text(data, 'question') || '资料';
  r.body = text(data, 'captured_at').substring(0, 7) + (text(data, 'captured_at') ? '\n' : '') + (text(data, 'detail') || text(data, 'summary') || text(data, 'snippet') || text(data, 'story') || text(data, 'text'));
  r.kind = kind;
  r.data = data;
  if (kind === 'media') {
    r.image = r.id;
    if (r.title === '资料') r.title = text(data, 'media_kind') === 'video' ? '一段视频' : '一张照片';
  }
  return r;
}

@Component
export struct BrainSpacePage {
  @StorageProp('themeTick') themeTick: number = 0;
  @StorageProp('brainLockedAt') @Watch('backgroundLock') backgroundLockAt: number = 0;
  @State authenticating: boolean = false;
  @State viewportWidth: number = 360;
  @State shares: BrainRow[] = [];
  @State tab: number = 0;
  @State mode: string = 'home';
  @State ready: boolean = false;
  @State unlocked: boolean = false;
  @State busy: boolean = false;
  @State error: string = '';
  @State notice: string = '';
  @State rows: BrainRow[] = [];
  @State detail: BrainRow = new BrainRow();
  @State sections: BrainRow[] = [];
  @State base: string = '';
  @State token: string = '';
  @State accessId: string = '';
  @State accessSecret: string = '';
  @State query: string = '';
  @State mediaKind: string = '';
  @State personId: string = '';
  @State selected: string[] = [];
  @State family: BrainRow[] = [];
  @State total: number = 0;
  @State pageOffset: number = 0;
  @State answerId: string = '';
  @State answer: string = '';
  @State askFiles: string[] = [];
  @State shareToken: string = '';
  @State sharePath: string = '';
  @State canUpload: boolean = false;
  @State canShare: boolean = false;
  @State canSteward: boolean = false;
  @State canSave: boolean = false;
  @State canWeb: boolean = false;
  @State jobs: BrainUploadJob[] = [];
  @State videoPath: string = '';
  @State webURL: string = '';
  @State chosenPages: number[] = [];
  private uploader: BrainUpload = new BrainUpload();
  private web: webview.WebviewController = new webview.WebviewController();
  private cookieName: string = '';
  private cookieBase: string = '';
  private epoch: number = 0;
  private expiry: number = -1;

  aboutToAppear(): void {
    this.uploader.load(getContext(this) as common.UIAbilityContext);
    this.jobs = this.uploader.jobs.slice();
    BrainAPI.load().then((cfg) => { this.base = cfg.base; this.ready = cfg.token.length > 0; })
      .catch((error: Error) => this.error = `${error}`);
    this.expiry = setInterval(() => {
      if (this.unlocked && Date.now() >= BrainAPI.unlockedUntil) this.lock();
    }, 1000);
  }
  backgroundLock(): void { this.lock(); }
  onPageHide(): void { this.lock(); }
  aboutToDisappear(): void { this.lock(); clearInterval(this.expiry); }
  private lock(): void {
    this.epoch += 1;
    if (this.cookieName && this.cookieBase) {
      try { webview.WebCookieManager.configCookieSync(this.cookieBase, this.cookieName + '=; Max-Age=0; Path=/; Secure; HttpOnly', true); } catch (_error) { }
      this.cookieName = ''; this.cookieBase = '';
    }
    BrainAPI.invalidate();
    BrainCache.clear();
    this.unlocked = false;
    this.rows = []; this.sections = []; this.family = []; this.selected = []; this.answer = '';
    this.detail = new BrainRow(); this.answerId = ''; this.query = ''; this.askFiles = [];
    this.shareToken = ''; this.sharePath = ''; this.webURL = ''; this.shares = []; this.notice = '';
    this.mode = 'home';
    if (this.videoPath) {
      try { fileIo.unlinkSync(this.videoPath); } catch (_error) { }
      this.videoPath = '';
    }
    this.busy = false;
  }
  private async enter(): Promise<void> {
    if (this.authenticating) return;
    this.authenticating = true;
    try {
      await BrainAPI.unlock('解锁第二大脑');
      const lease = BrainAPI.lease();
      const manifest = await BrainAPI.manifest();
      if (manifest['app'] !== true) throw new Error('设备钥匙缺少第二大脑 app 权限');
      const can = object(manifest, 'can');
      this.canUpload = can['upload'] === true; this.canShare = can['share'] === true;
      this.canSteward = can['steward'] === true; this.canSave = can['save'] === true; this.canWeb = can['web'] === true;
      const savedShares = await SecretStore.read('leo.harmony.brain.shares.' + BrainAPI.generation());
      BrainAPI.assertLease(lease);
      this.shares = savedShares ? JSON.parse(savedShares) as BrainRow[] : [];
      this.unlocked = true;
      await this.reload();
    } catch (error) { this.error = `${error}`; }
    finally { this.authenticating = false; }
  }
  private async configure(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      await BrainAPI.connect(this.base, this.token, this.accessId, this.accessSecret);
      this.token = ''; this.accessId = ''; this.accessSecret = ''; this.ready = true; this.mode = 'home';
      await this.enter();
    } catch (error) { this.error = `${error}`; }
    finally { this.busy = false; }
  }
  private mediaQuery(): string {
    return '?q=' + encodeURIComponent(this.query) + '&kind=' + this.mediaKind + '&smart=1&limit=60&offset=' + this.pageOffset +
      (this.personId ? '&people=' + part(this.personId) : '');
  }
  private async reload(append: boolean = false): Promise<void> {
    const epoch = ++this.epoch;
    this.busy = true; this.error = '';
    if (!append) this.pageOffset = 0;
    try {
      BrainAPI.requireUnlocked();
      let result: BrainRow[] = [];
      if (this.tab === 0) {
        const wall = await BrainAPI.get('/home/wall', '?limit=12');
        result = items(wall).map((o: BrainJSON) => row(o, 'media'));
        const butler = await BrainAPI.get('/butler');
        const summary = row(butler, 'summary'); summary.body = text(object(butler, 'brief'), 'text') || text(butler, 'sub');
        result.unshift(summary);
        const continues = await BrainAPI.get('/continuations');
        result = result.concat(items(continues).map((o: BrainJSON) => row(o, 'continuation')));
        const years = await BrainAPI.get('/media/onthisday');
        items(years, 'years').forEach((year: BrainJSON) => {
          const heading = row(year, 'summary'); heading.title = text(year, 'ago') + ' 年前的今天'; result.push(heading);
          result = result.concat(items(year).map((o: BrainJSON) => row(o, 'media')));
        });
        const recent = await BrainAPI.get('/answers', '?limit=5');
        result = result.concat(items(recent).map((o: BrainJSON) => row(o, 'answer')));
        result = result.concat(items(butler, 'today').map((o: BrainJSON) => row(o, 'summary')));
      } else if (this.tab === 1) {
        if (!this.family.length) {
          const family = await BrainAPI.get('/family');
          if (epoch !== this.epoch) return;
          this.family = items(family).map((o: BrainJSON) => row(o, 'person'));
        }
        const page = await BrainAPI.get('/media/search', this.mediaQuery());
        if (epoch !== this.epoch) return;
        result = items(page).map((o: BrainJSON) => row(o, 'media'));
        this.total = Number(page['total'] ?? 0);
        this.pageOffset += result.length;
      } else if (this.tab === 2) {
        result = items(await BrainAPI.get('/answers', '?limit=30')).map((o: BrainJSON) => row(o, 'answer'));
      } else if (this.tab === 3) {
        result = items(await BrainAPI.get('/family')).map((o: BrainJSON) => row(o, 'person'));
        const report = await BrainAPI.get('/family/report');
        result = items(report, 'people').map((o: BrainJSON) => row(o, 'person')).concat(result);
      } else {
        if (this.query.trim()) {
          const page = await BrainAPI.get('/search', '?q=' + encodeURIComponent(this.query.trim()) + '&limit=30');
          result = items(page).map((o: BrainJSON) => row(o, text(o, 'kind') === 'card' ? 'card' : text(o, 'media_kind') ? 'media' : 'file'));
        } else {
          result = items(await BrainAPI.get('/uploads', '?limit=20')).map((o: BrainJSON) => row(o, 'upload'));
        }
      }
      if (epoch === this.epoch) this.rows = append ? this.rows.concat(result) : result;
    } catch (error) { if (epoch === this.epoch) this.error = `${error}`; }
    finally { if (epoch === this.epoch) this.busy = false; }
  }
  private async open(target: BrainRow): Promise<void> {
    const epoch = ++this.epoch;
    this.detail = target; this.sections = []; this.error = ''; this.chosenPages = []; this.mode = 'detail';
    this.busy = true;
    try {
      BrainAPI.requireUnlocked();
      let sections: BrainRow[] = [];
      if (target.kind === 'continuation') {
        const href = text(target.data, 'href');
        const match = href.match(/(?:files?|document)[/=]([A-Za-z0-9_-]+)/);
        if (match) { const next = row({ 'id': match[1], 'title': target.title }, 'file'); await this.open(next); return; }
        await this.openWeb(href.startsWith('/api/') ? href : 'library'); return;
      } else if (target.kind === 'card') {
        await this.openWeb('card/' + part(target.id)); return;
      } else if (target.kind === 'media') {
        const data = await BrainAPI.get('/media/' + part(target.id));
        if (epoch !== this.epoch) return;
        this.detail = row(data, 'media');
        const info = row(data, 'summary');
        info.body = text(object(data, 'ai'), 'description') || text(data, 'caption');
        info.body += '\n' + text(data, 'captured_at') + '\n' + text(data, 'place');
        sections.push(info);
      } else if (target.kind === 'person') {
        const data = await BrainAPI.get('/family/' + part(target.id));
        const info = row(data, 'summary'); info.body = text(data, 'body'); sections.push(info);
        items(data, 'years').forEach((year: BrainJSON) => {
          const title = row(year, 'summary'); title.title = text(year, 'year') + ' 年 · ' + text(year, 'photos') + ' 张照片'; sections.push(title);
          sections = sections.concat(items(year, 'picks').map((o: BrainJSON) => row(o, 'media')));
        });
        sections = sections.concat(items(data, 'companions').map((o: BrainJSON) => row(o, 'person')));
        sections = sections.concat(items(data, 'places').map((o: BrainJSON) => row(o, 'summary')));
      } else if (target.kind === 'answer') {
        this.answerId = target.id; this.answer = ''; this.mode = 'answer'; await this.pollAnswer(target.id, epoch); return;
      } else if (target.kind === 'upload') {
        const receipt = object(target.data, 'receipt');
        if (!text(receipt, 'file_id')) throw new Error('文件仍在处理中');
        await this.open(row({ 'id': text(receipt, 'file_id'), 'title': target.title }, 'file')); return;
      } else if (target.kind === 'file') {
        const data = await BrainAPI.get('/files/' + part(target.id));
        const info = row(data, 'summary'); info.body += '\n原件可达 ' + text(data, 'original_available'); sections.push(info);
        const provenance = await BrainAPI.get('/files/' + part(target.id) + '/provenance');
        items(provenance, 'locations').forEach((o: BrainJSON) => {
          const location = row(o, 'summary'); location.title = text(o, 'source_name');
          location.body = text(o, 'relative_path') + '\n当前可达 ' + text(o, 'available'); sections.push(location);
        });
        const ocr = await BrainAPI.get('/files/' + part(target.id) + '/ocr');
        if (epoch !== this.epoch) return;
        const required = (ocr['required_pages'] as number[]) ?? [];
        required.forEach((n: number) => { const page = row({ 'id': String(n), 'title': '第 ' + n + ' 页' }, 'ocr'); page.data = ocr; sections.push(page); });
        const chunks = await BrainAPI.chunks(target.id, 0);
        if (epoch !== this.epoch) return;
        sections = sections.concat(items(chunks, 'chunks').map((o: BrainJSON) => { const chunk = row(o, 'chunk'); chunk.title = text(o, 'locator'); chunk.body = text(o, 'text'); return chunk; }));
        this.total = Number(chunks['total'] ?? sections.length);
        this.pageOffset = items(chunks, 'chunks').length;
      }
      if (epoch === this.epoch) this.sections = sections;
    } catch (error) { if (epoch === this.epoch) this.error = `${error}`; }
    finally { if (epoch === this.epoch) this.busy = false; }
  }
  private async moreChunks(): Promise<void> {
    const epoch = this.epoch;
    try {
      const chunks = await BrainAPI.chunks(this.detail.id, this.pageOffset);
      if (epoch !== this.epoch) return;
      this.pageOffset += items(chunks, 'chunks').length;
      this.sections = this.sections.concat(items(chunks, 'chunks').map((o: BrainJSON) => {
        const c = row(o, 'chunk'); c.title = text(o, 'locator'); c.body = text(o, 'text'); return c;
      }));
    } catch (error) { this.error = `${error}`; }
  }
  private async retryOCR(): Promise<void> {
    try {
      const source = this.sections.find((r: BrainRow) => r.kind === 'ocr');
      if (!source || !this.chosenPages.length) return;
      await BrainAPI.unlock('确认补读选中的页面');
      await BrainAPI.post('/files/' + part(this.detail.id) + '/ocr/retry', {
        'sha256': text(source.data, 'sha256'), 'pages': this.chosenPages.slice().sort((a: number, b: number) => a - b)
      });
      await this.open(this.detail);
    } catch (error) { this.error = `${error}`; }
  }
  private async ask(): Promise<void> {
    if (!this.query.trim() || this.busy) return;
    this.busy = true; this.error = '';
    const epoch = ++this.epoch;
    try {
      BrainAPI.requireUnlocked();
      const receipt = await BrainAPI.post('/ask', { 'question': this.query.trim(), 'mode': 'answer', 'file_ids': this.askFiles });
      if (epoch !== this.epoch) return;
      this.answerId = text(receipt, 'id'); this.answer = ''; this.mode = 'answer'; this.sections = [];
      await this.pollAnswer(this.answerId, epoch);
    } catch (error) { if (epoch === this.epoch) this.error = `${error}`; }
    finally { if (epoch === this.epoch) this.busy = false; }
  }
  private async pollAnswer(id: string, epoch: number): Promise<void> {
    for (let i = 0; i < 150 && epoch === this.epoch; i++) {
      BrainAPI.requireUnlocked();
      const data = await BrainAPI.get('/answers/' + part(id));
      if (epoch !== this.epoch) return;
      const result = object(data, 'result'); this.answer = text(result, 'answer') || '正在查找资料与生成回答…';
      this.sections = items(result, 'sources').map((o: BrainJSON) => {
        const source = row(o, 'file'); source.id = text(o, 'file_id'); source.body = text(o, 'locator'); return source;
      });
      if (text(data, 'status') === 'completed') return;
      if (['failed', 'interrupted', 'cancelled'].indexOf(text(data, 'status')) >= 0) throw new Error(text(data, 'error') || '问答已中断');
      await new Promise<void>((resolve) => setTimeout(resolve, 1500));
    }
    if (epoch === this.epoch) throw new Error('问答仍在处理中，可从历史继续查看');
  }
  private async steward(): Promise<void> {
    this.mode = 'steward'; this.sections = []; this.error = ''; this.busy = true;
    const epoch = ++this.epoch;
    try {
      const data = await BrainAPI.get('/steward');
      const butler = await BrainAPI.get('/butler');
      if (epoch !== this.epoch) return;
      this.sections = items(data, 'brief').map((o: BrainJSON) => row(o, 'summary')).concat(
        items(data, 'proposals').map((o: BrainJSON) => row(o, 'proposal'))).concat(
          items(butler, 'log').map((o: BrainJSON) => { const log = row(o, 'summary'); log.body = text(o, 'state') + ' ' + text(o, 'sub'); return log; }));
    } catch (error) { this.error = `${error}`; }
    finally { if (epoch === this.epoch) this.busy = false; }
  }
  private async decide(proposal: BrainRow, action: string): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      await BrainAPI.unlock(action === 'approve' ? '同意管家执行此项操作' : '拒绝此项提案');
      await BrainAPI.post('/steward/decide', { 'id': proposal.id, 'version': text(proposal.data, 'version'), 'action': action });
      await this.steward();
    } catch (error) { this.error = `${error}`; }
    finally { this.busy = false; }
  }
  private async share(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const selected = this.selected.slice();
      if (!selected.length || selected.length > 12) throw new Error('请选择 1 至 12 项');
      await BrainAPI.unlock('确认将所选影像分享给家人');
      const result = await BrainAPI.post('/shares', { 'file_ids': selected, 'days': 7, 'audience': 'family' });
      this.shareToken = text(result, 'token'); this.sharePath = text(result, 'path'); this.mode = 'share';
      const saved = row(result, 'share'); saved.id = this.shareToken; saved.title = '分享 ' + selected.length + ' 项';
      this.shares = [saved].concat(this.shares);
      await SecretStore.write('leo.harmony.brain.shares.' + BrainAPI.generation(), JSON.stringify(this.shares));
    } catch (error) { this.error = `${error}`; }
    finally { this.busy = false; }
  }
  private async revoke(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      await BrainAPI.unlock('撤销这组分享');
      await BrainAPI.post('/shares/revoke', { 'ref': this.shareToken.substring(0, 8) });
      this.shares = this.shares.filter((r: BrainRow) => r.id !== this.shareToken);
      await SecretStore.write('leo.harmony.brain.shares.' + BrainAPI.generation(), JSON.stringify(this.shares));
      this.shareToken = ''; this.sharePath = ''; this.mode = 'shares'; this.notice = '分享已撤销';
    } catch (error) { this.error = `${error}`; }
    finally { this.busy = false; }
  }
  private isVideo(): boolean {
    return text(this.detail.data, 'media_kind') === 'video' || /\.(mov|mp4|m4v)$/i.test(text(this.detail.data, 'ext'));
  }
  private async playVideo(): Promise<void> {
    this.busy = true; this.error = ''; this.notice = '正在准备视频，首次转码可能需要约半分钟';
    try {
      const ctx = getContext(this) as common.UIAbilityContext;
      const path = ctx.cacheDir + '/brain-video.mp4';
      await BrainAPI.download('/media/' + part(this.detail.id) + '/video', path);
      this.videoPath = path; this.error = ''; this.notice = '';
    } catch (error) { this.error = `视频暂未能播放，请稍后重试。${error}`; }
    finally { this.busy = false; }
  }
  private async openWeb(route: string): Promise<void> {
    try {
      BrainAPI.requireUnlocked();
      const session = await BrainAPI.webSession();
      if (!/^(?:[A-Za-z0-9_%/-]+)$/.test(route)) throw new Error('网页路径无效');
      const path = route.startsWith('/api/') ? route : '/#' + route;
      const base = BrainAPI.base();
      if (!/^[A-Za-z0-9_-]+$/.test(text(session, 'cookie')) || /[;\r\n]/.test(text(session, 'value'))) throw new Error('网页会话无效');
      this.cookieName = text(session, 'cookie'); this.cookieBase = base;
      webview.WebCookieManager.configCookieSync(base, this.cookieName + '=' + text(session, 'value') + '; Path=/; Secure; HttpOnly; SameSite=Strict', true);
      this.webURL = base + path; this.mode = 'web';
    } catch (error) { this.error = `${error}`; }
  }
  private async pickUpload(photo: boolean): Promise<void> {
    try { await this.uploader.pick(getContext(this) as common.UIAbilityContext, photo); this.jobs = this.uploader.jobs.slice(); }
    catch (error) { this.error = `${error}`; }
  }
  private async upload(job: BrainUploadJob): Promise<void> {
    this.busy = true;
    try { await this.uploader.run(job, () => this.jobs = this.uploader.jobs.slice()); }
    catch (error) { this.error = `${error}`; }
    finally { this.busy = false; this.jobs = this.uploader.jobs.slice(); }
  }
  private back(): void {
    this.epoch += 1;
    if (this.mode === 'web' && this.shareToken) { this.mode = 'share'; this.webURL = ''; return; }
    if (this.mode !== 'home') { this.mode = 'home'; this.sections = []; this.answer = ''; this.reload(); }
    else AppNavigation.back();
  }
  @Builder
  private card(r: BrainRow) {
    Column({ space: 8 }) {
      if (r.image && this.unlocked) { BrainImage({ fileId: r.image, label: r.title, selected: this.selected.indexOf(r.id) >= 0 }) }
      Text(r.title).fontSize(18).fontWeight(FontWeight.Medium).fontColor(Tokens.text).width('100%').maxLines(r.kind === 'media' ? 2 : 4).textOverflow({ overflow: TextOverflow.Ellipsis })
      if (r.body) {
        if (r.kind === 'media') {
          Text(r.body).fontSize(14).lineHeight(22).fontColor(Tokens.secondary)
            .width('100%').maxLines(3).textOverflow({ overflow: TextOverflow.Ellipsis })
        } else {
          Text(r.body).fontSize(r.kind === 'chunk' ? 17 : 14).lineHeight(r.kind === 'chunk' ? 28 : 22)
            .fontColor(r.kind === 'chunk' ? Tokens.text : Tokens.secondary).width('100%').copyOption(CopyOptions.InApp)
        }
      }
      if (r.kind === 'media') {
        Flex({ wrap: FlexWrap.Wrap }) {
          ActionButton({ label: '查看影像', variant: 'quiet', fullWidth: false, icon: 'photo', onTap: () => this.open(r) })
          if (this.canShare) {
            ActionButton({ label: this.selected.indexOf(r.id) >= 0 ? '取消选择' : '选择分享', variant: 'secondary', fullWidth: false, onTap: () => {
              if (this.selected.indexOf(r.id) >= 0) this.selected = this.selected.filter((id: string) => id !== r.id);
              else if (this.selected.length < 12) this.selected = this.selected.concat([r.id]);
              else this.error = '每组最多分享 12 项';
            } })
          }
        }.width('100%')
      } else if (['person', 'file', 'card', 'answer', 'continuation', 'upload'].indexOf(r.kind) >= 0) {
        ActionButton({ label: r.kind === 'file' ? '阅读资料' : '打开', variant: 'quiet', fullWidth: false, onTap: () => this.open(r) })
      } else if (r.kind === 'proposal') {
        Text('影响 ' + text(r.data, 'impact') + '\n撤销方式 ' + text(r.data, 'undo')).fontSize(14).fontColor(Tokens.secondary)
        Row({ space: 12 }) {
          ActionButton({ label: '同意执行', fullWidth: false, busy: this.busy, isEnabled: this.canSteward, onTap: () => this.decide(r, 'approve') })
          ActionButton({ label: '拒绝', variant: 'secondary', fullWidth: false, isEnabled: this.canSteward && !this.busy, onTap: () => this.decide(r, 'reject') })
        }
      } else if (r.kind === 'ocr') {
        ActionButton({ label: this.chosenPages.indexOf(Number(r.id)) >= 0 ? '已选 ' + r.title : '选择补读 ' + r.title, variant: 'secondary', fullWidth: false, onTap: () => {
          const n = Number(r.id);
          this.chosenPages = this.chosenPages.indexOf(n) >= 0 ? this.chosenPages.filter((v: number) => v !== n) : this.chosenPages.concat([n]);
        } })
      }
    }.alignItems(HorizontalAlign.Start).padding(18).width('100%').backgroundColor(Tokens.card).borderRadius(20).border({ width: 0.5, color: Tokens.separator }).margin({ bottom: 12 })
  }
  @Builder
  tabButtonContent(name: string, index: number) {
                Column({ space: 5 }) {
                  Sym({ name: ['calendar', 'photo', 'text_bubble_left_2', 'person', 'doc_text'][index],
                    dim: 21, color: this.tab === index ? Tokens.accent : Tokens.muted })
                  Text(name).fontSize(12).fontWeight(this.tab === index ? FontWeight.Bold : FontWeight.Regular)
                    .fontColor(this.tab === index ? Tokens.accent : Tokens.secondary)
                }.padding({ top: 9, bottom: 9 }).width('100%')

  }

  build() {
    NavDestination() {
    Column() {
      Row({ space: 12 }) {
        IconButton({ icon: 'chevron_left', label: '返回上一页', onTap: () => this.back() })
        Column({ space: 3 }) {
          Text('第二大脑').fontSize(24).fontWeight(FontWeight.Bold).fontColor(Tokens.text)
          Text(this.unlocked ? '设备已解锁' : '资料与家庭影像').fontSize(12).fontColor(Tokens.secondary)
        }.alignItems(HorizontalAlign.Start).layoutWeight(1)
        if (this.unlocked) { IconButton({ icon: 'lock', label: '锁定资料', filled: true, onTap: () => this.lock() }) }
      }.width('100%').padding(12)
      if (this.error) {
        Row({ space: 10 }) {
          Text(this.error).fontSize(14).lineHeight(21).fontColor(Tokens.text).layoutWeight(1)
          if (this.mode === 'home' && this.unlocked) {
            IconButton({ icon: 'arrow_clockwise', label: '重新读取资料', onTap: () => this.reload() })
          }
        }.padding(14).width('100%').backgroundColor(Tokens.warnTint).borderRadius(14)
      }
      if (this.notice) {
        Text(this.notice).fontSize(13).fontColor(Tokens.accent).padding(12).width('100%').backgroundColor(Tokens.accentSoft).borderRadius(12)
      }
      if (this.busy) {
        Row({ space: 10 }) {
          Skeleton({ label: '正在读取第二大脑' })
          Text('正在处理…').fontSize(13).fontColor(Tokens.secondary)
        }.width('100%').padding({ left: 20, right: 20, top: 6, bottom: 10 })
      }
      if (!this.ready || this.mode === 'settings') {
        Scroll() {
          Column({ space: 12 }) {
            Row() { Sym({ name: 'bookshelf', dim: 34, color: Tokens.accent }) }.width(72).height(72).justifyContent(FlexAlign.Center).backgroundColor(Tokens.accentSoft).borderRadius(22)
            Text('连接 Leo 资料库').fontSize(30).fontWeight(FontWeight.Bold).fontColor(Tokens.text).width('100%')
            Text('使用分配给这台鸿蒙设备的钥匙。地址和凭据作为同一连接加密保存。').fontColor(Tokens.secondary)
            Text('资料库地址').fontSize(13).fontColor(Tokens.secondary).margin({ top: 12 })
            TextInput({ text: this.base, placeholder: 'https://资料库地址' }).onChange((v: string) => this.base = v).height(52).backgroundColor(Tokens.card).borderRadius(14).fontColor(Tokens.text).padding({ left: 16, right: 16 })
            Text('设备钥匙').fontSize(13).fontColor(Tokens.secondary).margin({ top: 6 })
            TextInput({ text: this.token, placeholder: '设备钥匙' }).type(InputType.Password).onChange((v: string) => this.token = v).height(52).backgroundColor(Tokens.card).borderRadius(14).fontColor(Tokens.text).padding({ left: 16, right: 16 })
            Text('Access 凭据（如需）').fontSize(13).fontColor(Tokens.secondary).margin({ top: 6 })
            TextInput({ text: this.accessId, placeholder: 'Access Client ID（如需）' }).onChange((v: string) => this.accessId = v).height(52).backgroundColor(Tokens.card).borderRadius(14).fontColor(Tokens.text).padding({ left: 16, right: 16 })
            TextInput({ text: this.accessSecret, placeholder: 'Access Client Secret（如需）' }).type(InputType.Password).onChange((v: string) => this.accessSecret = v).height(52).backgroundColor(Tokens.card).borderRadius(14).fontColor(Tokens.text).padding({ left: 16, right: 16 })
            ActionButton({ label: '保存并连接', busy: this.busy, onTap: () => this.configure() })
          }.padding(24).width('100%').constraintSize({ maxWidth: 520 }).alignItems(HorizontalAlign.Start)
        }.layoutWeight(1).width('100%')
      } else if (!this.unlocked) {
        Column({ space: 20 }) {
          Row() { Sym({ name: 'lock', dim: 38, color: Tokens.accent }) }.width(88).height(88).justifyContent(FlexAlign.Center).backgroundColor(Tokens.accentSoft).borderRadius(28)
          Text('资料已锁定').fontSize(30).fontWeight(FontWeight.Bold).fontColor(Tokens.text)
          Text('使用设备认证查看家庭影像与资料').fontColor(Tokens.secondary)
          ActionButton({ label: '解锁第二大脑', busy: this.authenticating, fullWidth: false, icon: 'lock', onTap: () => this.enter() })
          ActionButton({ label: '连接设置', variant: 'quiet', fullWidth: false, onTap: () => this.mode = 'settings' })
          ActionButton({ label: '手机收藏', variant: 'quiet', fullWidth: false, icon: 'bookshelf', onTap: () => AppNavigation.pushUrl({ url: 'pages/CollectionsPage' }) })
        }.layoutWeight(1).justifyContent(FlexAlign.Center).width('100%')
      } else if (this.mode === 'web') {
        Web({ src: this.webURL, controller: this.web, incognitoMode: true }).layoutWeight(1).width('100%')
          .javaScriptAccess(true).domStorageAccess(true).fileAccess(false)
          .onLoadIntercept((event: OnLoadInterceptEvent) => !event || !(event.data.getRequestUrl() === BrainAPI.base() || event.data.getRequestUrl().startsWith(BrainAPI.base() + '/')))
      } else {
        if (this.mode === 'home') {
          Flex({ wrap: FlexWrap.Wrap }) {
            if (this.canUpload) { IconButton({ icon: 'arrow_up', label: '上传到资料库', filled: true, onTap: () => this.mode = 'uploads' }) }
            if (this.canShare) { ActionButton({ label: '我的分享', variant: 'quiet', fullWidth: false, onTap: () => this.mode = 'shares' }) }
            IconButton({ icon: 'bell', label: '打开管家', filled: true, onTap: () => this.steward() })
            IconButton({ icon: 'arrow_clockwise', label: '刷新资料', isEnabled: !this.busy, onTap: () => this.reload() })
          }.padding(8).width('100%')
          if ([1, 2, 4].indexOf(this.tab) >= 0) {
            Row({ space: 8 }) {
              TextInput({ text: this.query, placeholder: this.tab === 2 ? '向资料库提问' : '搜索资料与影像' }).layoutWeight(1).onChange((v: string) => this.query = v)
              ActionButton({ label: this.tab === 2 ? '提问' : '搜索', fullWidth: false, busy: this.busy, onTap: () => this.tab === 2 ? this.ask() : this.reload() })
            }.width('100%').padding(12)
          }
          if (this.tab === 1) {
            Scroll() {
              Row({ space: 8 }) {
                ActionButton({ label: '全部家人', variant: !this.personId ? 'primary' : 'secondary', fullWidth: false, onTap: () => { this.personId = ''; this.reload(); } })
                ForEach(this.family, (r: BrainRow) => { ActionButton({ label: r.title, variant: this.personId === r.id ? 'primary' : 'secondary', fullWidth: false, onTap: () => { this.personId = r.id; this.reload(); } }) })
                ActionButton({ label: '照片', variant: this.mediaKind === 'photo' ? 'primary' : 'secondary', fullWidth: false, onTap: () => { this.mediaKind = 'photo'; this.reload(); } })
                ActionButton({ label: '视频', variant: this.mediaKind === 'video' ? 'primary' : 'secondary', fullWidth: false, onTap: () => { this.mediaKind = 'video'; this.reload(); } })
                ActionButton({ label: '全部影像', variant: !this.mediaKind ? 'primary' : 'secondary', fullWidth: false, onTap: () => { this.mediaKind = ''; this.reload(); } })
              }
            }.scrollable(ScrollDirection.Horizontal).width('100%')
          }
          if (this.selected.length > 0) { ActionButton({ label: '分享所选 ' + this.selected.length + ' 项', busy: this.busy, fullWidth: false, onTap: () => this.share() }) }
        }
        Scroll() {
          Column({ space: 8 }) {
            if (this.mode === 'home') {
              if (!this.rows.length && !this.busy && !this.error) { Column({ space: 14 }) {
                  Sym({ name: this.tab === 1 ? 'photo' : 'doc_text', dim: 34, color: Tokens.muted })
                  Text(this.tab === 4 && !this.query ? '搜索你的资料' : '这里还没有资料').fontSize(22).fontWeight(FontWeight.Medium).fontColor(Tokens.text)
                  Text(this.tab === 4 && !this.query ? '输入关键词查找文档、知识卡和影像。' : '调整筛选条件，或上传新的资料。').fontSize(14).fontColor(Tokens.secondary).textAlign(TextAlign.Center)
                }.width('100%').padding({ top: 44, bottom: 44 }) }
              if (this.tab === 1) {
                Flex({ wrap: FlexWrap.Wrap }) {
                  ForEach(this.rows, (r: BrainRow, index: number) => {
                    Column() { this.card(r) }.width(this.viewportWidth >= 840 ? '33.33%' : this.viewportWidth >= 520 ? '50%' : '100%').padding(4)
                  }, (r: BrainRow, index: number) => `${index}:${r.kind}:${r.id}`)
                }.width('100%')
              } else {
                ForEach(this.rows, (r: BrainRow, index: number) => { this.card(r) }, (r: BrainRow, index: number) => `${index}:${r.kind}:${r.id}`)
              }
              if (this.tab === 1 && this.pageOffset < this.total) { ActionButton({ label: '继续加载', variant: 'secondary', busy: this.busy, onTap: () => this.reload(true) }) }
              if (this.canWeb) {
                Flex({ wrap: FlexWrap.Wrap }) {
                  ActionButton({ label: '设备与存储', variant: 'quiet', fullWidth: false, onTap: () => this.openWeb('devices') })
                  ActionButton({ label: '保护与备份', variant: 'quiet', fullWidth: false, onTap: () => this.openWeb('protection') })
                  ActionButton({ label: '系统', variant: 'quiet', fullWidth: false, onTap: () => this.openWeb('system') })
                  ActionButton({ label: '待审阅', variant: 'quiet', fullWidth: false, onTap: () => this.openWeb('review') })
                }.width('100%')
              }
              ActionButton({ label: '手机收藏', variant: 'quiet', fullWidth: false, icon: 'bookshelf', onTap: () => AppNavigation.pushUrl({ url: 'pages/CollectionsPage' }) })
            } else if (this.mode === 'uploads') {
              Flex({ wrap: FlexWrap.Wrap }) {
                ActionButton({ label: '从文件选择', variant: 'secondary', fullWidth: false, icon: 'doc_text', onTap: () => this.pickUpload(false) })
                ActionButton({ label: '从相册选择', fullWidth: false, icon: 'photo', onTap: () => this.pickUpload(true) })
              }
              Text('分片校验，重新打开后可从服务端确认的断点继续。').fontColor(Tokens.secondary)
              ForEach(this.jobs, (job: BrainUploadJob) => {
                Column({ space: 8 }) {
                  Text(job.name).fontColor(Tokens.text)
                  Text(job.stage + ' · ' + Math.round(job.received / job.size * 100) + '%').fontColor(Tokens.secondary)
                  ActionButton({ label: job.fileId ? '查看处理进度' : '继续上传', busy: this.busy, onTap: () => this.upload(job) })
                  ActionButton({ label: '移除本机副本', variant: 'secondary', fullWidth: false, isEnabled: !this.busy, onTap: () => {
                    promptAction.showDialog({ title: '移除上传副本', message: '已上传的服务端资料仍可在资料中查找。', buttons: [{ text: '取消', color: Tokens.text }, { text: '移除', color: Tokens.danger }] })
                      .then((result) => { if (result.index === 1) { this.uploader.remove(job.id); this.jobs = this.uploader.jobs.slice(); } })
                      .catch((error: Error) => this.error = `${error}`);
                  } })
                }.width('100%').padding(16).backgroundColor(Tokens.card).borderRadius(16)
              }, (job: BrainUploadJob) => `${job.id}:${job.received}:${job.stage}`)
            } else if (this.mode === 'shares') {
              Text('我的分享').fontSize(24).fontColor(Tokens.text)
              if (!this.shares.length) { Text('这台设备还没有创建分享').fontColor(Tokens.secondary) }
              ForEach(this.shares, (r: BrainRow) => {
                ActionButton({ label: r.title, variant: 'secondary', fullWidth: false, onTap: () => { this.shareToken = r.id; this.sharePath = text(r.data, 'path'); this.mode = 'share'; } })
              }, (r: BrainRow) => `${r.id}|${r.title}`)
            } else if (this.mode === 'share') {
              Text('分享有效期 7 天').fontSize(22).fontColor(Tokens.text)
              Text(BrainAPI.base() + '/family' + this.sharePath).copyOption(CopyOptions.LocalDevice).fontColor(Tokens.link)
              ActionButton({ label: '先看对方看到的样子', onTap: () => this.openWeb('/api/shares/preview/' + part(this.shareToken)) })
              ActionButton({ label: '撤销分享', variant: 'danger', busy: this.busy, onTap: () => this.revoke() })
            } else {
              if (this.mode === 'answer') {
                Text(this.answer).fontSize(18).lineHeight(30).fontColor(Tokens.text).copyOption(CopyOptions.InApp).width('100%')
                if (this.canSave && this.answerId) {
                  ActionButton({ label: '保存成果', variant: 'secondary', fullWidth: false, onTap: () => {
                    BrainAPI.post('/answers/save', { 'id': this.answerId, 'title': this.query.substring(0, 80) })
                      .then(() => this.notice = '成果已保存').catch((error: Error) => this.error = `${error}`);
                  } })
                }
                ActionButton({ label: '接着问', variant: 'secondary', fullWidth: false, onTap: () => { this.mode = 'home'; this.tab = 2; } })
              }
              if (this.mode === 'detail' && this.detail.kind === 'media') {
                BrainImage({ fileId: this.detail.id, preview: true })
                if (this.videoPath) { Video({ src: this.videoPath }).controls(true).width('100%').height(300) }
                if (this.isVideo()) { ActionButton({ label: '播放视频', busy: this.busy, onTap: () => this.playVideo() }) }
              }
              if (this.mode === 'detail' && ['media', 'file'].indexOf(this.detail.kind) >= 0) {
                ActionButton({ label: '问这份资料', variant: 'secondary', onTap: () => { this.askFiles = [this.detail.id]; this.tab = 2; this.query = ''; this.mode = 'home'; } })
              }
              if (this.mode === 'detail' && this.detail.kind === 'person') {
                ActionButton({ label: '查看此人的全部影像', variant: 'secondary', fullWidth: false, onTap: () => { this.personId = this.detail.id; this.tab = 1; this.mode = 'home'; this.reload(); } })
              }
              ForEach(this.sections, (r: BrainRow, index: number) => { this.card(r) }, (r: BrainRow, index: number) => `${index}:${r.kind}:${r.id}`)
              if (this.mode === 'detail' && this.detail.kind === 'file') {
                if (this.chosenPages.length) { ActionButton({ label: '只补读选中的 ' + this.chosenPages.length + ' 页', variant: 'secondary', fullWidth: false, onTap: () => this.retryOCR() }) }
                if (this.pageOffset < this.total) { ActionButton({ label: '再读 12 段', variant: 'secondary', onTap: () => this.moreChunks() }) }
              }
            }
          }.width('100%').constraintSize({ maxWidth: this.mode === 'home' && this.tab === 1 ? 1200 : Tokens.readable }).padding(20).alignItems(HorizontalAlign.Start)
        }.layoutWeight(1).width('100%').align(Alignment.Top)
        if (this.mode === 'home') {
          Row() {
            ForEach(['今日', '影像', '问', '家人', '资料'], (name: string, index: number) => {
              SurfaceButton({ content: () => { this.tabButtonContent(name, index); } })
              .layoutWeight(1).constraintSize({ minWidth: 44, minHeight: 60 })
              .backgroundColor(this.tab === index ? Tokens.accentSoft : Tokens.card)
              .borderRadius(16).accessibilityText(name)
              .accessibilityDescription(this.tab === index ? '当前页面' : '')
              .onClick(() => {
                if (this.tab === index) return;
                this.getUIContext().animateTo({ duration: MotionPolicy.duration(180), curve: curves.springMotion(0.25, 0.9) }, () => {
                  this.tab = index; this.query = ''; this.askFiles = []; this.rows = [];
                });
                this.reload();
              })
            })
          }.width('100%').constraintSize({ maxWidth: 620 }).padding(8)
            .backgroundColor(Tokens.card).border({ width: { top: 0.5 }, color: Tokens.separator })
        }
      }
    }.width('100%').height('100%').backgroundColor(Tokens.grouped)
      .onAreaChange((_oldArea: Area, newArea: Area) => this.viewportWidth = Number(newArea.width))

    }
    .hideTitleBar(true)
    .onShown(() => { AppNavigation.changed(); })
    .onHidden(() => { this.onPageHide(); })
    .onBackPressed(() => { this.back(); return true; })
  }
}
