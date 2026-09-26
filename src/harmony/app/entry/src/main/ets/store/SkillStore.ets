import { fileIo } from '@kit.CoreFileKit';
import { common } from '@kit.AbilityKit';
import { SkillMeta, parseSkillMeta, skillsPromptBlock } from '../local/AgentText';

export class LocalSkill {
  id: string = '';
  name: string = '';
  body: string = '';
  enabled: boolean = true;
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
      this.skills = parsed.map((row: Object) => {
        const item = row as Record<string, Object>;
        const skill = new LocalSkill();
        skill.id = `${item['id'] ?? ''}`;
        skill.name = `${item['name'] ?? ''}`;
        skill.body = `${item['body'] ?? ''}`;
        skill.enabled = item['enabled'] === false ? false : true;
        return skill;
      }).filter((row: LocalSkill) => row.id.length > 0 && row.name.length > 0);
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
    let found = false;
    for (let i = 0; i < this.skills.length; i++) {
      if (this.skills[i].name === trimmed) {
        this.skills[i].body = body;
        found = true;
        break;
      }
    }
    if (!found) {
      const skill = new LocalSkill();
      skill.id = `sk_${Date.now()}`;
      skill.name = trimmed;
      skill.body = body;
      skill.enabled = true;
      this.skills = this.skills.concat([skill]);
    }
    await this.save(context);
  }

  async toggle(context: common.Context, id: string): Promise<void> {
    for (let i = 0; i < this.skills.length; i++) {
      if (this.skills[i].id === id) {
        this.skills[i].enabled = !this.skills[i].enabled;
        break;
      }
    }
    await this.save(context);
  }

  async remove(context: common.Context, id: string): Promise<void> {
    this.skills = this.skills.filter((row: LocalSkill) => row.id !== id);
    await this.save(context);
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

  private enabled(): LocalSkill[] {
    return this.skills.filter((row: LocalSkill) => row.enabled && row.body.trim().length > 0);
  }

  private static filePath(context: common.Context): string {
    return context.filesDir + '/skills.json';
  }

  private static writeText(path: string, text: string): void {
    const file = fileIo.openSync(path,
      fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.CREATE | fileIo.OpenMode.TRUNC);
    try {
      fileIo.writeSync(file.fd, text);
    } finally {
      fileIo.closeSync(file);
    }
  }
}

export const skillStore: SkillStore = new SkillStore();
