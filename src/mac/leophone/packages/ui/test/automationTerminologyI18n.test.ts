import { describe, expect, it } from "vitest";
import enUS from "@/i18n/locales/en-US.js";
import zhCN from "@/i18n/locales/zh-CN.js";

// [leo] Off-peak (idle-time) tasks were removed: off-peak-only copy (create/delete/discard/pause hint)
// and the local Customize template no longer exist, so those cases are dropped.

describe("Automations terminology", () => {
  it("localizes the top-level area as Automations / 自动化", () => {
    expect(enUS["workspace.openScheduledSettings"]).toBe("Automations");
    expect(enUS["settings.automations.title"]).toBe("Automations");
    expect(zhCN["workspace.openScheduledSettings"]).toBe("自动化");
    expect(zhCN["settings.automations.title"]).toBe("自动化");
  });

  it("keeps 定时任务 for the scheduled-task subtype", () => {
    expect(zhCN["automations.list.title"]).toBe("定时任务");
    expect(zhCN["offPeak.tabs.scheduled"]).toBe("定时任务");
    expect(zhCN["taskList.cronTaskLabel"]).toBe("定时任务");
  });

  it("keeps the empty-state description focused on task creation modes", () => {
    // [leo] Scheduled-only copy: idle-time queueing was removed with the off-peak feature.
    expect(enUS["automations.description"]).toBe("Run tasks automatically on a schedule.");
    expect(zhCN["automations.description"]).toBe(
      "按计划自动运行任务，比如每天汇总提交、定期检查项目。",
    );
  });

  it("keeps idle-time permissions on the main conversation vocabulary", () => {
    const modeValues = ["build", "edit", "plan", "yolo"] as const;

    expect(modeValues.map((value) => zhCN[`mode.label.glm.${value}`])).toEqual([
      "变更前确认",
      "自动编辑",
      "计划模式",
      "完全访问",
    ]);
    expect(modeValues.map((value) => enUS[`mode.label.glm.${value}`])).toEqual([
      "Ask before changes",
      "Edit automatically",
      "Plan mode",
      "Full access",
    ]);
    for (const value of modeValues) {
      expect(zhCN[`offPeak.mode.${value}`]).toBeUndefined();
      expect(enUS[`offPeak.mode.${value}`]).toBeUndefined();
    }
  });

  it("does not retain locale entries for deleted static template catalogs", () => {
    const removedPrefixes = [
      "automations.template.",
      "offPeak.newTask.template.standupGitSummary.",
      "offPeak.newTask.template.ciFlakyReport.",
      "offPeak.newTask.template.documentationSyncCheck.",
    ];

    for (const messages of [enUS, zhCN]) {
      expect(
        Object.keys(messages).some((key) =>
          removedPrefixes.some((prefix) => key.startsWith(prefix)),
        ),
      ).toBe(false);
    }
  });

  it("uses action labels for scheduled task creation", () => {
    expect(enUS["automations.createManually"]).toBe("Create scheduled task");
    expect(zhCN["automations.createManually"]).toBe("创建定时任务");
    expect(enUS["automations.createViaChat"]).toBe("Create in chat");
    expect(zhCN["automations.createViaChat"]).toBe("去会话中创建");
  });

  it("removes the idle-time form queue guidance copy", () => {
    expect(enUS["offPeak.form.idleTimeLabel"]).toBeUndefined();
    expect(enUS["offPeak.form.scheduleHint"]).toBeUndefined();
    expect(zhCN["offPeak.form.idleTimeLabel"]).toBeUndefined();
    expect(zhCN["offPeak.form.scheduleHint"]).toBeUndefined();
  });

  it("does not keep idle-time pause confirmation copy", () => {
    expect(enUS["offPeak.pause.title"]).toBeUndefined();
    expect(enUS["offPeak.pause.description"]).toBeUndefined();
    expect(zhCN["offPeak.pause.title"]).toBeUndefined();
    expect(zhCN["offPeak.pause.description"]).toBeUndefined();
  });

  it("keeps imminent next-run copy grammatical across locales", () => {
    const englishNextRun = enUS["automations.nextRun"].replace(
      "{when}",
      enUS["automations.time.soon"],
    );
    const chineseNextRun = zhCN["automations.nextRun"].replace(
      "{when}",
      zhCN["automations.time.soon"],
    );

    expect(englishNextRun).toBe("Next run soon");
    expect(chineseNextRun).toBe("下次运行 1 分钟内");
  });

  it("uses productized discard-draft copy for scheduled tasks", () => {
    expect(enUS["automations.unsaved.title"]).toBe("Discard scheduled task draft?");
    expect(enUS["automations.unsaved.description"]).toBe(
      "Your changes to this scheduled task will be lost",
    );
    expect(zhCN["automations.unsaved.title"]).toBe("丢弃定时任务的草稿？");
    expect(zhCN["automations.unsaved.description"]).toBe("你对这个定时任务的更改将会丢失");
    expect(zhCN["automations.unsaved.discard"]).toBe("丢弃");
  });
});
