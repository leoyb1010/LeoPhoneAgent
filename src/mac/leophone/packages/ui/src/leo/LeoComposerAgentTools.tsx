import { Mic } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { logger } from "@/logger.js";

import { LeoAgentBadge } from "./LeoAgentBadge.js";
import { LEO_DEFAULT_AGENT_KIND, type LeoAgentKind } from "./leoAgentKind.js";
import { LEO_DICTATION_TOGGLE_EVENT } from "./LeoPushToTalk.js";
import { leoSpeechBridge } from "./leoSpeechBridge.js";
import { formatAccelerator } from "./quickEntryAccelerator.js";

/**
 * [leo][wp-31] 输入框工具条的「agent · 麦克风」两件:模式之后跟 agent 类型徽标(ACP 前恒为 LeoBot),
 * 再跟麦克风(只在语音输入可用且开启时出现,点一下开始 / 再点结束,和按住快捷键是同一条链路)。
 */
export function LeoComposerAgentTools({
  agentKind = LEO_DEFAULT_AGENT_KIND,
  disabled = false,
}: {
  agentKind?: LeoAgentKind;
  disabled?: boolean;
}) {
  const bridge = leoSpeechBridge();
  const [hotkey, setHotkey] = useState<string | null>(null);

  useEffect(() => {
    if (!bridge) return;
    const load = () =>
      bridge
        .getSettings()
        .then((result) =>
          setHotkey(
            result.available && result.settings?.dictationEnabled
              ? formatAccelerator(result.settings.accelerator)
              : null,
          ),
        )
        .catch((error: unknown) => logger.warn("[LeoComposerAgentTools] 读取语音设置失败", error));
    load();
    window.addEventListener("focus", load);
    window.addEventListener("leo-speech-settings-changed", load);
    return () => {
      window.removeEventListener("focus", load);
      window.removeEventListener("leo-speech-settings-changed", load);
    };
  }, [bridge]);

  const micLabel = hotkey ? `语音输入（按住 ${hotkey}，或点一下开始 / 结束）` : "";
  return (
    <span className="flex shrink-0 items-center gap-1" data-leo-composer-agent-tools>
      <LeoAgentBadge kind={agentKind} className="mx-0.5" />
      {hotkey ? (
        <ControlHintTooltip title={micLabel}>
          <Button
            type="button"
            variant="ghost"
            size="icon-md"
            disabled={disabled}
            aria-label={micLabel}
            data-testid="leo-composer-mic"
            // 不抢焦点:收音要写进当前输入框,按钮拿走焦点会让 findDictationTarget 找不到编辑器。
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => window.dispatchEvent(new Event(LEO_DICTATION_TOGGLE_EVENT))}
          >
            <Mic className="size-4" />
          </Button>
        </ControlHintTooltip>
      ) : null}
    </span>
  );
}
