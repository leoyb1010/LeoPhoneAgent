import {
  ZCODE_AGENT_PROVIDER,
  ZCODE_COMMAND_AGENT_SOURCES,
  type ZCodeProvider,
  type CommandAgentSource,
} from "@zcode/shared";

export const COMMAND_AGENT_SOURCES = [
  ...ZCODE_COMMAND_AGENT_SOURCES,
] as const satisfies readonly CommandAgentSource[];

export const COMMAND_AGENT_SOURCE_META: Record<
  CommandAgentSource,
  {
    labelId: string;
    provider: ZCodeProvider;
    pathHint: string;
  }
> = {
  zcodeAgent: {
    labelId: "settings.commands.source.zcodeAgent",
    pathHint: "~/.leophoneagent/commands", // [leo] 用户级数据根
    provider: ZCODE_AGENT_PROVIDER,
  },
};
