// 折叠算法本体已上移到 @cindy/maker-shared(桌面侧栏与手机版首页共用同一套
// 「前 N 条 + 24h 活动 / 需关注豁免」策略,单侧改动会破坏两端一致性)。
// 本文件保留为 re-export,维持桌面既有 import 路径稳定。
export {
  SESSION_LIST_COLLAPSE_MIN_VISIBLE_COUNT,
  SESSION_LIST_COLLAPSE_RECENT_WINDOW_MS,
  getSessionListCollapseView,
  type SessionListCollapseView,
  type SessionListCollapseViewInput,
} from '@cindy/maker-shared/session-list-collapse';
