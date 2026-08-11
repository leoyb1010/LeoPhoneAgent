import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Copy, Download, Pencil, Play, Plus, Trash2, Upload } from 'lucide-react';

import { cn } from '../../../lib/utils';
import { Badge, Button, Dialog, DialogContent } from '../../../shared/view/ui';
import { PERMISSION_MODE_LABELS, PROVIDER_LABELS } from '../constants';
import { useAgentProfiles } from '../hooks/useAgentProfiles';
import type { AgentProfile, AgentProfileDraft } from '../types';

import ProfileEditor from './ProfileEditor';

type AgentHubProps = {
  /** Closes the Settings modal after a launch so the new conversation is visible. */
  onAfterLaunch?: () => void;
};

/**
 * Agent Profile Hub (智能体档案): a library of named launch presets. Each card
 * one-click launches a fresh conversation preconfigured with the profile's
 * provider / model / effort / permission and opening prompt. Import/export make
 * the library portable.
 */
export default function AgentHub({ onAfterLaunch }: AgentHubProps) {
  const { t } = useTranslation();
  const { profiles, loading, error, create, update, remove, launch, exportAll, importFile } = useAgentProfiles(true, onAfterLaunch);
  const [editing, setEditing] = useState<AgentProfile | null>(null);
  const [creating, setCreating] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const dialogOpen = creating || editing !== null;
  const closeDialog = () => {
    setCreating(false);
    setEditing(null);
  };

  const handleSave = async (draft: AgentProfileDraft) => {
    const saved = editing ? await update(editing.id, draft) : await create(draft);
    if (saved) closeDialog();
  };

  const handleDuplicate = (profile: AgentProfile) => {
    const { id: _id, createdAt: _c, updatedAt: _u, ...draft } = profile;
    void create({ ...draft, name: `${profile.name} 副本` });
  };

  const handleDelete = (profile: AgentProfile) => {
    if (!window.confirm(t('agentHub.confirmDelete', { name: profile.name, defaultValue: `删除档案「${profile.name}」?此操作不可撤销。` }))) return;
    void remove(profile.id);
  };

  const handleImportClick = () => {
    setImportError(null);
    fileInputRef.current?.click();
  };

  const handleFileChosen = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      await importFile(file);
    } catch (err) {
      setImportError(err instanceof Error ? err.message : '导入失败');
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-foreground">{t('agentHub.title', { defaultValue: '智能体档案' })}</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {t('agentHub.description', { defaultValue: '保存常用的智能体设定,一键启动预配置的新对话。' })}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <input ref={fileInputRef} type="file" accept="application/json,.json" className="hidden" onChange={(event) => void handleFileChosen(event)} />
          <Button variant="ghost" size="sm" onClick={handleImportClick} className="gap-1.5">
            <Upload className="h-4 w-4" />{t('agentHub.import', { defaultValue: '导入' })}
          </Button>
          <Button variant="ghost" size="sm" onClick={exportAll} disabled={profiles.length === 0} className="gap-1.5">
            <Download className="h-4 w-4" />{t('agentHub.export', { defaultValue: '导出' })}
          </Button>
          <Button size="sm" onClick={() => setCreating(true)} className="gap-1.5">
            <Plus className="h-4 w-4" />{t('agentHub.new', { defaultValue: '新建' })}
          </Button>
        </div>
      </div>

      {(error || importError) && (
        <div className="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning dark:text-warning">
          {importError || error}
        </div>
      )}

      {loading && profiles.length === 0 ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {Array.from({ length: 4 }).map((_, index) => (
            <div key={index} className="skeleton h-32 rounded-xl" />
          ))}
        </div>
      ) : profiles.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border bg-muted/20 px-6 py-12 text-center">
          <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-primary/10 text-primary">
            <Plus className="h-5 w-5" />
          </div>
          <p className="text-sm font-medium text-foreground">{t('agentHub.emptyTitle', { defaultValue: '还没有智能体档案' })}</p>
          <p className="mx-auto mt-1 max-w-sm text-xs text-muted-foreground">
            {t('agentHub.emptyHint', { defaultValue: '创建一个档案来固定你常用的 CLI、模型、权限模式和开场提示词。' })}
          </p>
          <Button size="sm" onClick={() => setCreating(true)} className="mt-4 gap-1.5">
            <Plus className="h-4 w-4" />{t('agentHub.new', { defaultValue: '新建' })}
          </Button>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {profiles.map((profile) => (
            <div
              key={profile.id}
              className="group relative flex flex-col overflow-hidden rounded-xl border border-border/70 bg-card p-4 transition-all hover:border-primary/40 hover:shadow-elevation-2 hover:shadow-primary/5"
            >
              <div className="flex items-start gap-3">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted/60 text-xl">{profile.emoji}</span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold text-foreground">{profile.name}</div>
                  <div className="mt-1 flex flex-wrap items-center gap-1">
                    <Badge variant="secondary" className="text-[10px]">{PROVIDER_LABELS[profile.provider]}</Badge>
                    {profile.model.trim() && <Badge variant="outline" className="text-[10px]">{profile.model.trim()}</Badge>}
                    {profile.effort !== 'default' && <Badge variant="outline" className="text-[10px]">{profile.effort}</Badge>}
                    {profile.permissionMode !== 'default' && (
                      <Badge variant="outline" className="text-[10px]">{PERMISSION_MODE_LABELS[profile.permissionMode] ?? profile.permissionMode}</Badge>
                    )}
                  </div>
                </div>
              </div>

              {(profile.openingPrompt.trim() || profile.notes.trim()) && (
                <p className="mt-3 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                  {profile.notes.trim() || profile.openingPrompt.trim()}
                </p>
              )}

              <div className="mt-3 flex items-center gap-1.5">
                <Button size="sm" onClick={() => launch(profile)} className="h-8 flex-1 gap-1.5">
                  <Play className="h-3.5 w-3.5" />{t('agentHub.launch', { defaultValue: '启动' })}
                </Button>
                <button
                  type="button"
                  onClick={() => setEditing(profile)}
                  title={t('agentHub.edit', { defaultValue: '编辑' })}
                  className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  <Pencil className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => handleDuplicate(profile)}
                  title={t('agentHub.duplicate', { defaultValue: '复制' })}
                  className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  <Copy className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => handleDelete(profile)}
                  title={t('agentHub.delete', { defaultValue: '删除' })}
                  className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={(open) => { if (!open) closeDialog(); }}>
        <DialogContent
          className={cn('w-[min(560px,92vw)] overflow-hidden rounded-xl border border-border bg-card p-0 shadow-elevation-3')}
          onEscapeKeyDown={closeDialog}
          onPointerDownOutside={closeDialog}
        >
          <ProfileEditor initial={editing} onCancel={closeDialog} onSave={handleSave} />
        </DialogContent>
      </Dialog>
    </div>
  );
}
