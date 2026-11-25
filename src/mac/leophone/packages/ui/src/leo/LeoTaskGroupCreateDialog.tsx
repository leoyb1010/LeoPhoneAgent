import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button.js";
import { Checkbox } from "@/components/ui/checkbox.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { Textarea } from "@/components/ui/textarea.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

import {
  leoTaskGroups,
  taskGroupAgentChoices,
  type LeoTaskGroupAgentChoice,
} from "./leoTaskGroups.js";

export function TaskGroupCreateDialog({
  open,
  onOpenChange,
  workspacePath,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspacePath: string;
  onCreated: () => void;
}) {
  const { intl } = useZCodeIntl();
  const [prompt, setPrompt] = useState("");
  const [choices, setChoices] = useState<LeoTaskGroupAgentChoice[]>(() => taskGroupAgentChoices([]));
  const [selected, setSelected] = useState<string[]>(["leo"]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const acp = (
      window as unknown as {
        leoAcp?: { list(): Promise<Array<{ id: string; name: string; available: boolean }>> };
      }
    ).leoAcp;
    void (acp?.list() ?? Promise.resolve([]))
      .then((agents) => setChoices(taskGroupAgentChoices(agents)))
      .catch(() => undefined);
  }, [open]);

  const toggle = (key: string, checked: boolean) =>
    setSelected((current) =>
      checked ? [...new Set([...current, key])] : current.filter((entry) => entry !== key),
    );

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await leoTaskGroups.create({
        workspacePath,
        prompt: prompt.trim(),
        agents: choices
          .filter((choice) => selected.includes(choice.key))
          .map((choice) => choice.agent),
      });
      setPrompt("");
      onOpenChange(false);
      onCreated();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl rounded-2xl p-6">
        <DialogHeader className="space-y-2">
          <DialogTitle>{intl.formatMessage({ id: "leoHome.taskGroups.create" })}</DialogTitle>
          <DialogDescription>
            {intl.formatMessage({ id: "leoHome.taskGroups.dialogDesc" })}
          </DialogDescription>
        </DialogHeader>
        <Textarea
          value={prompt}
          rows={4}
          placeholder={intl.formatMessage({ id: "leoHome.taskGroups.promptPlaceholder" })}
          onChange={(event) => setPrompt(event.target.value)}
        />
        <div className="flex flex-wrap gap-x-5 gap-y-2">
          {choices.map((choice) => (
            <label key={choice.key} className="flex items-center gap-2 text-ui-base text-foreground">
              <Checkbox
                checked={selected.includes(choice.key)}
                onCheckedChange={(checked) => toggle(choice.key, checked === true)}
              />
              {choice.label}
            </label>
          ))}
        </div>
        {error ? (
          <p role="alert" className="text-ui-sm text-destructive">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
            {intl.formatMessage({ id: "leoHome.taskGroups.cancel" })}
          </Button>
          <Button
            type="button"
            disabled={submitting || !prompt.trim() || selected.length === 0 || selected.length > 4}
            onClick={() => void submit()}
          >
            {submitting
              ? intl.formatMessage({ id: "leoHome.taskGroups.preparing" })
              : intl.formatMessage({ id: "leoHome.taskGroups.startCount" }, { count: selected.length })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
