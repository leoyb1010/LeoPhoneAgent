/**
 * VisibilityEditorDialog — 「管理可见性」弹窗,对齐 SkillHub 工作台同名能力。
 *
 * 一个入口管理三件事(SkillHub origin/main 语义):
 *   1. 可见范围:公开 / 给团队使用 / 仅自己使用(三卡,带「当前」徽标)
 *   2. 发布者:个人 / 团队(+ 发布团队选择)——「谁能管」
 *   3. 谁可以使用:团队可见时的额外团队/部门多选——「谁能用」
 *
 * 保存走两步(同 SkillHub web):
 *   1) PATCH metadata { visibility, teamSlug | null } —— 可见档位 + 归属
 *   2) set-visibility { visibility, visibleSlugs } —— 可见对象
 */
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import * as Dialog from '@radix-ui/react-dialog';
import { Globe, Lock, Users, X } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Spinner } from '@/components/ui/spinner';
import { toast } from '@/lib/toast';

import { AudiencePicker, PublisherPicker } from './TeamScopePicker';
import { VisibilityCard } from '../PublishDialog';
import { marketActionErrorMessage } from '../lib/marketErrors';
import { matchesDeptMirrorTeamSlug } from '../lib/publishForm';
import { selectableUserTeams } from '../lib/userTeams';
import type { TeamOption } from '../lib/marketDetailViewModel';

export type VisibilityTier = 'public' | 'team' | 'private';

type VisibilityEditorDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 已发布 skill 的 slug */
  skillName: string;
  /** 当前可见档位(回显「当前」徽标) */
  currentTier: VisibilityTier;
  /** 当前归属:org = 团队归属 */
  currentOwnerType?: string;
  /** 当前归属团队 slug(ownerType=org 时) */
  currentOwnerSlug?: string;
  /** 保存成功后回调(父组件刷新详情) */
  onSaved: () => void;
  /** viewer 等无写权限时:弹窗只读打开(控件禁用 + 顶部提示),不能保存。 */
  readOnly?: boolean;
};

export function VisibilityEditorDialog({
  open,
  onOpenChange,
  skillName,
  currentTier,
  currentOwnerType,
  currentOwnerSlug,
  onSaved,
  readOnly = false,
}: VisibilityEditorDialogProps) {
  const { t } = useTranslation();
  const currentOwnerIsTeam = currentOwnerType === 'org';

  // loading 初始为 true,且关闭时复位 —— Dialog 在数据就绪前不挂载,
  // 避免"先弹出矮窗再撑开"的跳变(设计规范:拿到数据后一次成型)。
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tier, setTier] = useState<VisibilityTier>(currentTier);
  const [ownerMode, setOwnerMode] = useState<'personal' | 'team'>(currentOwnerIsTeam ? 'team' : 'personal');
  const [ownerTeamSlug, setOwnerTeamSlug] = useState<string>(currentOwnerIsTeam ? (currentOwnerSlug ?? '') : '');
  const [deptIds, setDeptIds] = useState<string[]>([]);
  const [deptNames, setDeptNames] = useState<string[]>([]);
  const [teams, setTeams] = useState<TeamOption[]>([]);
  const [visibleDeptIds, setVisibleDeptIds] = useState<string[]>([]);
  const [sharedTeamSlugs, setSharedTeamSlugs] = useState<string[]>([]);

  useEffect(() => {
    if (!open) {
      setLoading(true);
      return;
    }
    // 每次打开都从当前状态重置(避免上次编辑残留)
    setTier(currentTier);
    setOwnerMode(currentOwnerIsTeam ? 'team' : 'personal');
    setOwnerTeamSlug(currentOwnerIsTeam ? (currentOwnerSlug ?? '') : '');
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    void Promise.all([
      window.electronAPI.skillhub.getPublishedVisibility(skillName),
      window.electronAPI.skillhub.getMyDepts(),
      window.electronAPI.skillhub.listUserTeams(),
    ]).then(([vis, depts, teamsRes]) => {
      if (cancelled) return;
      setLoading(false);
      if (!vis.success) {
        setLoadError(marketActionErrorMessage(vis.error, vis.errorCode));
        return;
      }
      const ids = depts.success ? depts.ids : [];
      const names = depts.success ? depts.names : [];
      setDeptIds(ids);
      setDeptNames(names);
      const regularTeams = teamsRes.success
        ? selectableUserTeams(teamsRes.teams)
        : [];
      // 团队选项:普通团队;部门统一走 od- id(归属保存走 PATCH deptId)
      setTeams(regularTeams
        .map((team) => ({ slug: team.slug, name: team.name, source: team.source })));
      // 当前归属是部门镜像团队时,映射回 od- id,让「部门」组里正确高亮
      if (currentOwnerIsTeam && currentOwnerSlug) {
        const ownerTeamSource = teamsRes.success
          ? teamsRes.teams.find((team) => team.slug === currentOwnerSlug)?.source
          : undefined;
        const ownerOd = ids.find((id) =>
          matchesDeptMirrorTeamSlug(id, currentOwnerSlug, ownerTeamSource));
        if (ownerOd) setOwnerTeamSlug(ownerOd);
      }
      // 回显;不在我可选范围内的历史值原样保留,保存时不静默丢弃
      setVisibleDeptIds(vis.visibleDepts ?? []);
      setSharedTeamSlugs((vis.sharedTeams ?? []).map((team) => team.slug));
    });
    return () => { cancelled = true; };
  }, [open, skillName, currentTier, currentOwnerIsTeam, currentOwnerSlug, t]);

  // ── 校验(对齐 SkillHub StepMeta/管理弹窗规则) ──────────────────────────
  const needsManagementTeam = ownerMode === 'team' && !ownerTeamSlug;
  const needsAudience =
    tier === 'team' &&
    !(ownerMode === 'team' && ownerTeamSlug) &&
    visibleDeptIds.length === 0 &&
    sharedTeamSlugs.length === 0;

  // ── 影响提示(SkillHub origin/main 同款文案) ───────────────────────────
  const tierChanged = tier !== currentTier;
  const leavingMarket = currentTier === 'public' && tier !== 'public';
  const teamOwnedToPrivate = currentOwnerIsTeam && ownerMode === 'personal' && tier === 'private';
  const impactText = useMemo(() => {
    if (tier === 'private') {
      if (teamOwnedToPrivate) {
        return leavingMarket
          ? t('skillhub.visibilityEditor.impactPrivateTeamLeavingMarket')
          : t('skillhub.visibilityEditor.impactPrivateTeam');
      }
      if (leavingMarket) return t('skillhub.visibilityEditor.impactPrivateLeavingMarket');
      return tierChanged ? t('skillhub.visibilityEditor.impactPrivate') : null;
    }
    if (tier === 'team') {
      if (leavingMarket) return t('skillhub.visibilityEditor.impactTeamLeavingMarket');
      return tierChanged ? t('skillhub.visibilityEditor.impactTeam') : null;
    }
    return tierChanged ? t('skillhub.visibilityEditor.impactPublic') : null;
  }, [tier, tierChanged, leavingMarket, teamOwnedToPrivate, t]);

  const chooseTier = (next: VisibilityTier) => {
    setTier(next);
    // 仅自己使用 → 归属强制个人(SkillHub 同款规则)
    if (next === 'private') setOwnerMode('personal');
  };

  const handleSave = async () => {
    if (needsManagementTeam || needsAudience) return;
    setSaving(true);
    try {
      const visibility = tier === 'team' ? 'shared' as const : tier;
      // 第一步:可见档位 + 归属。teamSlug 是统一参数:普通团队 slug 或
      // od- 部门 id(Hub 端识别前缀并懒创建镜像团队),消费方不感知差异
      const fields: {
        visibility: 'private' | 'shared' | 'public';
        teamSlug?: string | null;
      } = { visibility };
      if (ownerMode === 'team' && ownerTeamSlug) fields.teamSlug = ownerTeamSlug;
      else if (currentOwnerIsTeam) fields.teamSlug = null;
      const metaRes = await window.electronAPI.skillhub.updatePublished({ name: skillName, fields });
      if (!metaRes.success) {
        toast.error(marketActionErrorMessage(metaRes.error, metaRes.errorCode));
        return;
      }
      // 第二步:可见对象(非团队档清空)
      const visRes = await window.electronAPI.skillhub.setPublishedVisibility({
        name: skillName,
        visibility,
        visibleSlugs: tier === 'team' ? [...visibleDeptIds, ...sharedTeamSlugs] : [],
      });
      if (!visRes.success) {
        toast.error(marketActionErrorMessage(visRes.error, visRes.errorCode));
        return;
      }
      toast.success(t('skillhub.visibilityEditor.saved'));
      onOpenChange(false);
      onSaved();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog.Root open={open && !loading} onOpenChange={(v) => { if (!saving) onOpenChange(v); }}>
      <Dialog.Portal>
        <Dialog.Overlay
          className="fixed inset-0 z-[10000] bg-[var(--overlay-modal)]"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        />
        <Dialog.Content
          className={cn(
            'fixed left-1/2 top-1/2 z-[10000] -translate-x-1/2 -translate-y-1/2',
            'w-full max-w-[480px] rounded-xl',
            'border bg-[var(--cmd-palette-bg)] border-[var(--cmd-palette-border)]',
            'max-h-[85vh] overflow-y-auto',
          )}
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          aria-describedby={undefined}
        >
          <div className="flex items-start justify-between px-5 pt-5">
            <div className="flex flex-col gap-1">
              <Dialog.Title className="text-lg font-medium text-[var(--msg-assistant-text)]">
                {t('skillhub.visibilityEditor.title')}
              </Dialog.Title>
              <span className="text-xs text-[var(--cmd-palette-item-meta)]">{skillName}</span>
            </div>
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className={cn(
                'flex h-7 w-7 items-center justify-center rounded-full',
                'text-[var(--settings-theme-icon)] hover:bg-[var(--confirm-btn-secondary-hover)]',
                'transition-colors',
              )}
              aria-label={t('skillhub.publishDialog.closeAria')}
            >
              <X size={15} />
            </button>
          </div>

          <div className="flex flex-col gap-4 px-5 pt-4 pb-1">
            {loadError ? (
              <p className="py-4 text-sm text-[var(--cmd-palette-item-meta)]">{loadError}</p>
            ) : (
              <>
                {readOnly ? (
                  <div className="rounded-lg px-3 py-2 text-xs bg-[var(--chat-input-chip-bg)] text-[var(--settings-section-desc)]">
                    {t('skillhub.market.noManagePermission')}
                  </div>
                ) : null}
                {/* 可见范围三卡(与发布弹窗共用 VisibilityCard) */}
                <div className="flex flex-col gap-1.5">
                  <span className="block px-0.5 text-13 font-medium text-[var(--settings-section-desc)]">
                    {t('skillhub.visibilityEditor.tierLabel')}
                  </span>
                  <div className="grid grid-cols-3 gap-2">
                    <VisibilityCard
                      value="PUBLIC"
                      label={t('skillhub.visibilityEditor.tierPublic')}
                      description={t('skillhub.visibilityEditor.tierPublicDesc')}
                      icon={<Globe size={14} strokeWidth={1.75} />}
                      disabled={readOnly}
                      selected={tier === 'public'}
                      onSelect={() => chooseTier('public')}
                    />
                    <VisibilityCard
                      value="DEPARTMENT_SCOPED"
                      label={t('skillhub.visibilityEditor.tierTeam')}
                      description={t('skillhub.visibilityEditor.tierTeamDesc')}
                      icon={<Users size={14} strokeWidth={1.75} />}
                      disabled={readOnly}
                      selected={tier === 'team'}
                      onSelect={() => chooseTier('team')}
                    />
                    <VisibilityCard
                      value="PRIVATE"
                      label={t('skillhub.visibilityEditor.tierPrivate')}
                      description={t('skillhub.visibilityEditor.tierPrivateDesc')}
                      icon={<Lock size={14} strokeWidth={1.75} />}
                      disabled={readOnly}
                      selected={tier === 'private'}
                      onSelect={() => chooseTier('private')}
                    />
                  </div>
                </div>

                {/* 发布者 — 与发布弹窗一致:私有档也显示,团队卡置灰 */}
                <PublisherPicker
                  mode={ownerMode}
                  ownerTeamSlug={ownerTeamSlug}
                  deptIds={deptIds}
                  deptNames={deptNames}
                  teams={teams}
                  disabled={saving || readOnly}
                  teamChoiceDisabled={tier === 'private'}
                  onChange={({ mode, ownerTeamSlug: slug }) => {
                    // 切到团队且未选过时,默认所属部门(第一个),其次普通团队
                    const next = mode === 'team' && !slug
                      ? (deptIds[0] ?? teams[0]?.slug ?? '')
                      : slug;
                    setOwnerMode(mode);
                    setOwnerTeamSlug(next);
                    if (mode === 'team' && next) {
                      // 发布团队天然可见,不重复出现在「谁可以使用」里
                      setSharedTeamSlugs((prev) => prev.filter((s) => s !== next));
                      setVisibleDeptIds((prev) => prev.filter((s) => s !== next));
                    }
                  }}
                />
                {needsManagementTeam ? (
                  <p className="px-0.5 text-xs text-[var(--cmd-palette-item-meta)]">
                    {t('skillhub.publishDialog.publisherTeamRequired')}
                  </p>
                ) : null}

                {/* 谁可以使用(团队档) */}
                {tier === 'team' ? (
                  <>
                    <AudiencePicker
                      value={{ visibleDeptIds, sharedTeamSlugs }}
                      deptIds={deptIds}
                      deptNames={deptNames}
                      teams={teams}
                      lockedOwnerSlug={ownerMode === 'team' && ownerTeamSlug ? ownerTeamSlug : undefined}
                      disabled={saving || readOnly}
                      onChange={(value) => {
                        setVisibleDeptIds(value.visibleDeptIds);
                        setSharedTeamSlugs(value.sharedTeamSlugs);
                      }}
                    />
                    {needsAudience ? (
                      <p className="px-0.5 text-xs text-[var(--cmd-palette-item-meta)]">
                        {t('skillhub.publishDialog.audienceRequired')}
                      </p>
                    ) : null}
                  </>
                ) : null}

                {/* 影响提示 */}
                {impactText ? (
                  <div
                    className={cn(
                      'rounded-xl px-3.5 py-3 text-xs leading-[1.6]',
                      teamOwnedToPrivate
                        ? 'bg-[var(--error-bg)] text-[var(--error-fg)]'
                        : 'bg-[var(--chat-input-chip-bg)] text-[var(--settings-source-meta)]',
                    )}
                  >
                    {impactText}
                  </div>
                ) : null}
              </>
            )}
          </div>

          <div className="flex items-center justify-end gap-2 p-4">
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className={cn(
                'inline-flex h-8 items-center justify-center rounded-full px-4',
                'text-sm font-normal border bg-[var(--cmd-palette-bg)]',
                'border-[var(--confirm-btn-secondary-border)] text-[var(--settings-btn-secondary-text)]',
                'hover:bg-[var(--surface-hover)] transition-colors',
              )}
            >
              {t('skillhub.publishDialog.cancel')}
            </button>
            <button
              type="button"
              disabled={loading || saving || Boolean(loadError) || needsManagementTeam || needsAudience || readOnly}
              onClick={() => void handleSave()}
              className={cn(
                'inline-flex h-8 items-center justify-center gap-1.5 rounded-full px-4',
                'text-sm font-medium leading-none',
                'bg-[var(--lightbox-cta-bg)] text-[var(--lightbox-cta-fg)]',
                'hover:bg-[var(--lightbox-cta-hover)] transition-colors',
                'disabled:cursor-not-allowed disabled:opacity-50',
              )}
            >
              {saving ? <Spinner size={14} /> : null}
              {saving ? t('skillhub.visibilityEditor.saving') : t('skillhub.visibilityEditor.save')}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
