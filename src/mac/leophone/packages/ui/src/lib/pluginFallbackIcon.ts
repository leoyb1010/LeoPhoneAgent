// [leo] 商店里大多数插件没有图标，全部显示同一个积木会让列表像占位。
// 没有图标时显示名称首字：每张卡片可区分，又不额外引入装饰色或图标依赖。

/** 名称首字（中文取第一个字，英文取首字母大写）。 */
export function pluginInitial(name: string | undefined): string | undefined {
  const first = Array.from(name?.trim() ?? "")[0];
  return first ? first.toUpperCase() : undefined;
}
