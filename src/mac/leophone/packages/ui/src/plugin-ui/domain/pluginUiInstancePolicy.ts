import type { ConversationRow, ToolCallRow } from "@zcode/shared/zcode-protocol-v4";
import { resolvePluginUiLogicalScope } from "./pluginUiLogicalScope.js";

/** ：最近几个回合的插件卡片默认展开，更早的按默认收进折叠区。 */
export const PLUGIN_UI_AUTO_EXPAND_TURNS = 3;

/** 一个逻辑 UI：仅显式 surface 或权限范围一致的 widgetSessionId 共用，其余调用独立。 */
export interface PluginUiLogicalInstance {
  key: string;
  /** 当前显示的调用：最新一次成功（非 isError）的；没有成功的就是最新一条。 */
  activeToolCallId: string;
  /** 被较新成功结果替代的成功调用；它们不建沙箱，只保留普通工具记录。 */
  supersededToolCallIds: string[];
}

/** 单条插件工具行的展示裁决；渲染层据此决定进不进折叠区、要不要建沙箱。 */
export interface PluginUiRowDisposition {
  key: string;
  superseded: boolean;
  /** 所在回合在最近 PLUGIN_UI_AUTO_EXPAND_TURNS 个回合内。 */
  autoExpand: boolean;
  /** 工具级 `openai/widgetShowCodexWidgetInline`（display.ui.showInline）。 */
  forcedInline: boolean;
}

export interface PluginUiInstanceDerivation {
  instances: PluginUiLogicalInstance[];
  byToolCallId: Readonly<Record<string, PluginUiRowDisposition>>;
}

export const EMPTY_PLUGIN_UI_INSTANCE_DERIVATION: PluginUiInstanceDerivation = {
  instances: [],
  byToolCallId: {},
};

function isPluginUiToolRow(row: ConversationRow): row is ToolCallRow {
  return (
    row.kind === "toolCall" && row.display?.kind === "mcp_tool" && row.display.ui !== undefined
  );
}

function isSuccessfulUiRow(row: ToolCallRow): boolean {
  return (
    row.status === "success" &&
    !(row.display?.kind === "mcp_tool" && row.display.ui?.isError === true)
  );
}

/**
 * 纯函数：从投影行推导逻辑 UI 实例与每行的展示裁决（V-a）。
 * key 同时绑定来源、server、资源、权限与逻辑视图；同 key 内最新一次成功结果替代更早的成功结果，
 * running / failed / isError 的行既不替代别人也不被替代（各自显示自己的状态）。
 * autoExpand 按全部行的回合顺序取最近 N 个回合（回合里没有插件卡片也算一个回合）。
 */
const EMPTY_PLUGIN_UI_DERIVATION: PluginUiInstanceDerivation = Object.freeze({
  instances: Object.freeze([]) as unknown as PluginUiLogicalInstance[],
  byToolCallId: Object.freeze({}) as Record<string, PluginUiRowDisposition>,
});

export function deriveLogicalUiInstances(
  rows: readonly ConversationRow[],
  options: { autoExpandTurns?: number } = {},
): PluginUiInstanceDerivation {
  // domain 不用 Map / Set（模块边界约束），全部用数组与普通对象。
  // 快速短路：绝大多数普通对话不含插件 UI 行，避免每次流式分片做 O(N×T) 扫描并分配新对象。
  const groupKeys: string[] = [];
  const groups: Record<string, ToolCallRow[]> = Object.create(null);
  for (const row of rows) {
    if (!isPluginUiToolRow(row)) continue;
    const display = row.display;
    if (display?.kind !== "mcp_tool" || !display.ui) continue;
    const logical = resolvePluginUiLogicalScope(display.ui, {
      kind: "toolCall",
      toolCallId: row.toolCallId,
    });
    const key = JSON.stringify([
      display.ui.pluginId,
      display.serverName,
      display.ui.resourceUri,
      logical,
    ]);
    const group = groups[key];
    if (group) group.push(row);
    else {
      groups[key] = [row];
      groupKeys.push(key);
    }
  }
  if (groupKeys.length === 0) {
    return EMPTY_PLUGIN_UI_DERIVATION;
  }
  const seenTurns: Record<string, true> = Object.create(null);
  const turnOrder: string[] = [];
  for (const row of rows) {
    if (!seenTurns[row.turnId]) {
      seenTurns[row.turnId] = true;
      turnOrder.push(row.turnId);
    }
  }
  const recentTurnSet: Record<string, true> = Object.create(null);
  for (const turnId of turnOrder.slice(-(options.autoExpandTurns ?? PLUGIN_UI_AUTO_EXPAND_TURNS))) {
    recentTurnSet[turnId] = true;
  }
  const instances: PluginUiLogicalInstance[] = [];
  const byToolCallId: Record<string, PluginUiRowDisposition> = {};
  for (const key of groupKeys) {
    const group = groups[key]!;
    const successes = group.filter(isSuccessfulUiRow);
    const active = successes.at(-1) ?? group.at(-1)!;
    const superseded = successes.filter((row) => row !== active).map((row) => row.toolCallId);
    const supersededSet: Record<string, true> = Object.create(null);
    for (const id of superseded) supersededSet[id] = true;
    instances.push({ key, activeToolCallId: active.toolCallId, supersededToolCallIds: superseded });
    for (const row of group) {
      byToolCallId[row.toolCallId] = {
        key,
        superseded: Boolean(supersededSet[row.toolCallId]),
        autoExpand: Boolean(recentTurnSet[row.turnId]),
        forcedInline: row.display?.kind === "mcp_tool" && row.display.ui?.showInline === true,
      };
    }
  }
  return { instances, byToolCallId };
}
