/**
 * 用户自定义 Project 显示名。key 使用 Project identity key，避免同名目录互相覆盖。
 */
export interface ProjectAlias {
  projectKey: string;
  alias: string;
  updatedAt: string;
}
