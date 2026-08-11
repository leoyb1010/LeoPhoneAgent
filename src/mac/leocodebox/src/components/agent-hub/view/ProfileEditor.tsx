import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { cn } from '../../../lib/utils';
import { Button } from '../../../shared/view/ui';
import type { LLMProvider } from '../../../types/app';
import {
  emptyDraft,
  HUB_PROVIDERS,
  PERMISSION_MODE_LABELS,
  PROFILE_EMOJI_CHOICES,
  PROVIDER_DEFAULT_MODEL,
  PROVIDER_EFFORT_VALUES,
  PROVIDER_LABELS,
  PROVIDER_PERMISSION_MODES,
} from '../constants';
import type { AgentProfile, AgentProfileDraft } from '../types';

type ProfileEditorProps = {
  initial: AgentProfile | null;
  onCancel: () => void;
  onSave: (draft: AgentProfileDraft) => Promise<void>;
};

const fieldLabel = 'text-xs font-medium text-muted-foreground';
const inputBase = 'h-9 w-full rounded-md border border-input bg-background px-3 text-sm outline-none transition-colors focus:ring-2 focus:ring-ring';

/** Modal form for creating or editing one agent profile. */
export default function ProfileEditor({ initial, onCancel, onSave }: ProfileEditorProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<AgentProfileDraft>(() => (initial ? { ...initial } : emptyDraft()));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setDraft(initial ? { ...initial } : emptyDraft());
  }, [initial]);

  // Keep effort/permission valid whenever the provider changes.
  const efforts = PROVIDER_EFFORT_VALUES[draft.provider];
  const permissionModes = PROVIDER_PERMISSION_MODES[draft.provider];
  useEffect(() => {
    setDraft((prev) => ({
      ...prev,
      effort: PROVIDER_EFFORT_VALUES[prev.provider].includes(prev.effort) ? prev.effort : 'default',
      permissionMode: PROVIDER_PERMISSION_MODES[prev.provider].includes(prev.permissionMode) ? prev.permissionMode : 'default',
    }));
  }, [draft.provider]);

  const set = <K extends keyof AgentProfileDraft>(key: K, value: AgentProfileDraft[K]) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
  };

  const canSave = draft.name.trim().length > 0 && !saving;
  const modelPlaceholder = useMemo(() => PROVIDER_DEFAULT_MODEL[draft.provider], [draft.provider]);

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    try {
      await onSave({ ...draft, name: draft.name.trim() });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex max-h-[80vh] flex-col">
      <div className="flex items-center gap-3 border-b border-border/60 px-5 py-4">
        <span className="text-2xl leading-none">{draft.emoji}</span>
        <h2 className="text-base font-semibold text-foreground">
          {initial
            ? t('agentHub.editTitle', { defaultValue: '编辑档案' })
            : t('agentHub.newTitle', { defaultValue: '新建智能体档案' })}
        </h2>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
        <div className="grid grid-cols-[auto_1fr] gap-3">
          <div className="space-y-1.5">
            <label className={fieldLabel}>{t('agentHub.emoji', { defaultValue: '图标' })}</label>
            <div className="flex w-[132px] flex-wrap gap-1">
              {PROFILE_EMOJI_CHOICES.map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  onClick={() => set('emoji', emoji)}
                  className={cn(
                    'flex h-7 w-7 items-center justify-center rounded-md text-base transition-colors',
                    draft.emoji === emoji ? 'bg-primary/15 ring-1 ring-primary/40' : 'hover:bg-accent',
                  )}
                >
                  {emoji}
                </button>
              ))}
            </div>
          </div>
          <div className="space-y-1.5">
            <label className={fieldLabel} htmlFor="profile-name">{t('agentHub.name', { defaultValue: '名称' })}</label>
            <input
              id="profile-name"
              value={draft.name}
              onChange={(event) => set('name', event.target.value)}
              placeholder={t('agentHub.namePlaceholder', { defaultValue: '例如:代码审查员' })}
              className={inputBase}
              autoFocus
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <label className={fieldLabel} htmlFor="profile-provider">{t('agentHub.provider', { defaultValue: 'CLI' })}</label>
            <select
              id="profile-provider"
              value={draft.provider}
              onChange={(event) => set('provider', event.target.value as LLMProvider)}
              className={inputBase}
            >
              {HUB_PROVIDERS.map((provider) => (
                <option key={provider} value={provider}>{PROVIDER_LABELS[provider]}</option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <label className={fieldLabel} htmlFor="profile-model">{t('agentHub.model', { defaultValue: '模型' })}</label>
            <input
              id="profile-model"
              value={draft.model}
              onChange={(event) => set('model', event.target.value)}
              placeholder={t('agentHub.modelPlaceholder', { defaultValue: `留空用默认(${modelPlaceholder})`, model: modelPlaceholder })}
              className={inputBase}
            />
          </div>
          <div className="space-y-1.5">
            <label className={fieldLabel} htmlFor="profile-effort">{t('agentHub.effort', { defaultValue: '努力度' })}</label>
            <select
              id="profile-effort"
              value={draft.effort}
              onChange={(event) => set('effort', event.target.value)}
              className={inputBase}
            >
              {efforts.map((value) => (
                <option key={value} value={value}>{value}</option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <label className={fieldLabel} htmlFor="profile-permission">{t('agentHub.permission', { defaultValue: '权限模式' })}</label>
            <select
              id="profile-permission"
              value={draft.permissionMode}
              onChange={(event) => set('permissionMode', event.target.value)}
              className={inputBase}
            >
              {permissionModes.map((value) => (
                <option key={value} value={value}>{PERMISSION_MODE_LABELS[value] ?? value}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="space-y-1.5">
          <label className={fieldLabel} htmlFor="profile-prompt">{t('agentHub.openingPrompt', { defaultValue: '开场提示词(可选)' })}</label>
          <textarea
            id="profile-prompt"
            value={draft.openingPrompt}
            onChange={(event) => set('openingPrompt', event.target.value)}
            placeholder={t('agentHub.openingPromptPlaceholder', { defaultValue: '启动时自动填入对话框的内容' })}
            rows={3}
            className={cn(inputBase, 'h-auto resize-y py-2 leading-relaxed')}
          />
        </div>

        <div className="space-y-1.5">
          <label className={fieldLabel} htmlFor="profile-notes">{t('agentHub.notes', { defaultValue: '备注(可选)' })}</label>
          <textarea
            id="profile-notes"
            value={draft.notes}
            onChange={(event) => set('notes', event.target.value)}
            rows={2}
            className={cn(inputBase, 'h-auto resize-y py-2 leading-relaxed')}
          />
        </div>
      </div>

      <div className="flex justify-end gap-2 border-t border-border/60 px-5 py-3">
        <Button variant="ghost" onClick={onCancel} disabled={saving}>
          {t('common.cancel', { defaultValue: '取消' })}
        </Button>
        <Button onClick={() => void handleSave()} disabled={!canSave}>
          {saving ? t('agentHub.saving', { defaultValue: '保存中…' }) : t('common.save', { defaultValue: '保存' })}
        </Button>
      </div>
    </div>
  );
}
