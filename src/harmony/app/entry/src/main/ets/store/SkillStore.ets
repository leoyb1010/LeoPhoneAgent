import { fileIo } from '@kit.CoreFileKit';
import { common } from '@kit.AbilityKit';

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

  async load(context: common.UIAbilityContext): Promise<void> {
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

  async save(context: common.UIAbilityContext): Promise<void> {
    if (this.jsonLoadFailed) {
      throw new Error('技能档案读坏了，先别保存，避免覆盖');
    }
    SkillStore.writeText(SkillStore.filePath(context), JSON.stringify(this.skills));
  }

  async upsert(context: common.UIAbilityContext, name: string, body: string): Promise<void> {
    const trimmed = name.trim();
    if (!trimmed) {
      throw new Error('技能名不能空');
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

  async toggle(context: common.UIAbilityContext, id: string): Promise<void> {
    for (let i = 0; i < this.skills.length; i++) {
      if (this.skills[i].id === id) {
        this.skills[i].enabled = !this.skills[i].enabled;
        break;
      }
    }
    await this.save(context);
  }

  promptBlock(): string {
    const enabled = this.skills.filter((row: LocalSkill) => row.enabled && row.body.trim().length > 0);
    if (enabled.length === 0) {
      return '';
    }
    return enabled.map((row: LocalSkill) => `技能 ${row.name}:\n${row.body.trim()}`).join('\n\n');
  }

  private static filePath(context: common.UIAbilityContext): string {
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
