import { atomicWriteText } from './AtomicFile';
import { SkillBundle } from '../sync/SkillBundle';
import { util } from '@kit.ArkTS';
import { fileIo } from '@kit.CoreFileKit';
import { common } from '@kit.AbilityKit';
import { SkillMeta, parseSkillMeta, skillsPromptBlock } from '../local/AgentText';

export class LocalSkill {
  id: string = '';
  name: string = '';
  body: string = '';
  enabled: boolean = true;
  bundleDirectory: string = '';
  bundleHash: string = '';
}

export class SkillStore {
  skills: LocalSkill[] = [];
  jsonLoadFailed: boolean = false;
  private loaded: boolean = false;

  async load(context: common.Context): Promise<void> {
    const path = SkillStore.filePath(context);
    if (!fileIo.accessSync(path)) {
      this.skills = [];
      this.loaded = true;
      return;
    }
    try {
      const raw = fileIo.readTextSync(path);
      const parsed = JSON.parse(raw) as Object[];
      if (!Array.isArray(parsed)) throw new Error('技能档案格式无效');
      this.skills = parsed.map((row: Object) => {
        const item = row as Record<string, Object>;
        const skill = new LocalSkill();
        skill.id = `${item['id'] ?? ''}`;
        skill.name = `${item['name'] ?? ''}`;
        skill.body = `${item['body'] ?? ''}`;
        skill.enabled = item['enabled'] === false ? false : true;
        skill.bundleDirectory = typeof item['bundleDirectory'] === 'string' && SkillBundle.safeDirectory(item['bundleDirectory'] as string) ? item['bundleDirectory'] as string : '';
        skill.bundleHash = typeof item['bundleHash'] === 'string' && /^[a-f0-9]{64}$/.test(item['bundleHash'] as string) ? item['bundleHash'] as string : '';
        return skill;
      }).filter((row: LocalSkill) => row.id.length > 0 && row.name.length > 0);
      this.jsonLoadFailed = false;
    } catch (err) {
      this.jsonLoadFailed = true;
      this.skills = [];
    }
    this.loaded = true;
  }

  async save(context: common.Context): Promise<void> {
    if (this.jsonLoadFailed) {
      throw new Error('技能档案读坏了，先别保存，避免覆盖');
    }
    SkillStore.writeText(SkillStore.filePath(context), JSON.stringify(this.skills));
  }

  /** 名字可以不填:SKILL.md 头里写了 name 就用它。 */
  async upsert(context: common.Context, name: string, body: string): Promise<void> {
    const trimmed = name.trim().length > 0 ? name.trim() : parseSkillMeta(body, '').name;
    if (!trimmed) {
      throw new Error('技能名不能空(或在 SKILL.md 的 --- 头里写 name)');
    }
    const next = JSON.parse(JSON.stringify(this.skills)) as LocalSkill[];
    let found = false;
    for (let i = 0; i < next.length; i++) {
      if (next[i].name === trimmed) {
        next[i].body = body;
        found = true;
        break;
      }
    }
    if (!found) {
      const skill = new LocalSkill();
      skill.id = `sk_${Date.now()}_${Math.floor(Math.random() * 1000000)}`;
      skill.name = trimmed;
      skill.body = body;
      skill.enabled = true;
      next.push(skill);
    }
    this.commit(context, next);
  }

  async toggle(context: common.Context, id: string): Promise<void> {
    const next = JSON.parse(JSON.stringify(this.skills)) as LocalSkill[];
    const row = next.find((skill: LocalSkill) => skill.id === id); if (!row) throw new Error('技能已被删除');
    row.enabled = !row.enabled; this.commit(context, next);
  }
  async remove(context: common.Context, id: string): Promise<void> { this.commit(context, this.skills.filter((row: LocalSkill) => row.id !== id)); }
  private commit(context: common.Context, next: LocalSkill[]): void {
    if (this.jsonLoadFailed) throw new Error('技能档案读取失败，原文件已保留');
    SkillStore.writeText(SkillStore.filePath(context), JSON.stringify(next)); this.skills = next;
  }

  meta(row: LocalSkill): SkillMeta {
    return parseSkillMeta(row.body, row.name);
  }

  /**
   * 提示词里只放索引(名字、说明、路径),正文等模型用 file_read 读 skills/<id>/SKILL.md 时再给 ——
   * iOS、安卓同样只放索引。原来把每个启用技能的全文都塞进每一轮的提示词。
   */
  promptBlock(): string {
    return skillsPromptBlock(this.enabled().map((row: LocalSkill) => this.meta(row)));
  }

  /** skills/<id>/SKILL.md 的内容;没有这个启用的技能返回空。 */
  bodyFor(id: string): string {
    const rows = this.enabled();
    for (let i = 0; i < rows.length; i++) {
      if (this.meta(rows[i]).id === id) {
        return rows[i].body;
      }
    }
    return '';
  }

  /** Resolve only enabled skill resources under a verified immutable tree. */
  resourcePath(context: common.Context, raw: string): string {
    const hit = raw.trim().match(/^\/?(?:var\/minis\/)?skills\/([^/]+)\/(.+)$/); if (!hit) return '';
    const row = this.enabled().find((skill: LocalSkill) => skill.id === hit[1] || this.meta(skill).id === hit[1]);
    return row ? SkillBundle.resource(context, row.bundleDirectory, hit[2]) : '';
  }
  resourceText(context: common.Context, raw: string): string {
    const path = this.resourcePath(context, raw); if (!path) throw new Error('找不到已启用技能中的资源');
    const file = fileIo.openSync(path, fileIo.OpenMode.READ_ONLY | fileIo.OpenMode.NOFOLLOW);
    try {
      const size = fileIo.statSync(file.fd).size; if (size > 256 * 1024) throw new Error('技能资源超过256KiB文本读取上限');
      const buffer = new ArrayBuffer(size); if (fileIo.readSync(file.fd, buffer) !== size) throw new Error('技能资源读取不完整');
      return util.TextDecoder.create('utf-8', { fatal: true }).decodeToString(new Uint8Array(buffer));
    } finally { fileIo.closeSync(file); }
  }

  private enabled(): LocalSkill[] {
    return this.skills.filter((row: LocalSkill) => row.enabled && row.body.trim().length > 0);
  }

  private static filePath(context: common.Context): string {
    return context.filesDir + '/skills.json';
  }

  private static writeText(path: string, text: string): void {
    atomicWriteText(path, text);
  }
}

export const skillStore: SkillStore = new SkillStore();
