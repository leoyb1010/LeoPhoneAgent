/**
 * [leo] LeoBot 新任务的默认权限档：「守护」(guarded，3.15.1 新增)。
 * 等同「完全访问」，但 rm / git reset --hard / push --force 等危险命令每次单独确认；
 * 用户仍可在输入框切到「完全访问」(yolo) 或其他档位，选择会记进 Recent。
 * 用户拍板：guarded 设为默认档，yolo 保留可选（WP-11）。
 */
export const LEO_DEFAULT_TASK_MODE = "guarded" as const;
