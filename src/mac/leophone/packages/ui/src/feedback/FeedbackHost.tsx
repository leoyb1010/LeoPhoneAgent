import type { ComponentProps } from "react";
import type { FeedbackCenter } from "@/feedback/FeedbackCenter.js";

// [leo] 上游的反馈中心（问题上报 / 产品需求 / 我的工单）会把内容和日志上传到官方反馈服务。
// LeoPhoneAgent 不连官方服务：宿主整体不渲染，原生菜单等残留入口打开时也不会弹出任何上传界面。
export function FeedbackHost(_props: ComponentProps<typeof FeedbackCenter>) {
  return null;
}
