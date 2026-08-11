import { useCallback, useEffect, useRef, useState } from 'react';

import { apiClient } from '../../../utils/apiClient';
import type { ExistingPrdFile, SavePrdInput, SavePrdResult } from '../types';
import { ensurePrdExtension } from '../utils/fileName';

type UsePrdSaveArgs = {
  // DB primary key of the project (post migration).
  projectId?: string;
  existingPrds: ExistingPrdFile[];
  isExistingFile: boolean;
  onAfterSave?: () => Promise<void>;
};

type UsePrdSaveResult = {
  savePrd: (input: SavePrdInput) => Promise<SavePrdResult>;
  saving: boolean;
  saveSuccess: boolean;
};

export function usePrdSave({
  projectId,
  existingPrds,
  isExistingFile,
  onAfterSave,
}: UsePrdSaveArgs): UsePrdSaveResult {
  const [saving, setSaving] = useState<boolean>(false);
  const [saveSuccess, setSaveSuccess] = useState<boolean>(false);
  const saveSuccessTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (saveSuccessTimeoutRef.current) {
        clearTimeout(saveSuccessTimeoutRef.current);
      }
    };
  }, []);

  const savePrd = useCallback(
    async ({ content, fileName, allowOverwrite = false }: SavePrdInput): Promise<SavePrdResult> => {
      if (!content.trim()) {
        return { status: 'failed', message: 'Please add content before saving.' };
      }

      if (!fileName.trim()) {
        return { status: 'failed', message: 'Please provide a filename for the PRD.' };
      }

      if (!projectId) {
        return { status: 'failed', message: 'No project selected. Please reopen the editor.' };
      }

      const finalFileName = ensurePrdExtension(fileName.trim());
      const hasConflict = existingPrds.some((prd) => prd.name === finalFileName);

      // Overwrite confirmation is only required when creating a brand-new PRD.
      if (hasConflict && !allowOverwrite && !isExistingFile) {
        return { status: 'needs-overwrite', fileName: finalFileName };
      }

      setSaving(true);

      try {
        await apiClient.post(`/api/taskmaster/prd/${encodeURIComponent(projectId)}`, {
          fileName: finalFileName,
          content,
        });

        if (saveSuccessTimeoutRef.current) {
          clearTimeout(saveSuccessTimeoutRef.current);
        }

        setSaveSuccess(true);
        saveSuccessTimeoutRef.current = setTimeout(() => {
          setSaveSuccess(false);
          saveSuccessTimeoutRef.current = null;
        }, 2000);

        if (onAfterSave) {
          await onAfterSave();
        }

        return { status: 'saved', fileName: finalFileName };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return { status: 'failed', message: `Error saving PRD: ${message}` };
      } finally {
        setSaving(false);
      }
    },
    [existingPrds, isExistingFile, onAfterSave, projectId],
  );

  return {
    savePrd,
    saving,
    saveSuccess,
  };
}
