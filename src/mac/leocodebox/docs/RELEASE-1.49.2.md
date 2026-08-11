# leocodebox 1.49.2

配图刷新:把整套「3D 实景桌面照」换成极简高级的抽象编辑风视觉,统一到产品主色 teal-emerald。纯资产更新,无功能/逻辑改动。

## 换了什么

- **41 张全新配图**(按 `docs/VISUAL-REFRESH-PROMPTS.md` 的风格系统生成)全量替换旧图:
  onboarding 8 / release 5 / empty-states 20 / errors 4 / brand 4。
  统一 teal-emerald 主色 + 大留白 + 哑光抽象几何,替掉旧的实景工作台照片。
- 清掉 24 张无引用的旧 png 回退(empty-states/errors/brand;渲染只用 webp)。

## 验证

- 生产构建通过;客户端/服务端类型检查、ESLint 0 警告(与 1.49.1 同一代码,仅资产变更)。
- 6 agent 逐图 QA 抽检 41 张(判风格/概念/破损):首轮 40 通过,唯一一张深色首图字形歪已重出为干净对称的 `{ }` 后复检通过。
- 隔离环境真机浏览器核对:onboarding 明暗两版均渲染新图,旧照片已消失。

## 下载校验

- DMG SHA-256:`05086558e444308470794d3a41e5ae53b06662aecc2187484de204cd58f20a87`
- ZIP SHA-256:`57f9aaa5e22e0cbf075f9ecda46657b76647004aca22f5a99112a1b7f57b9de6`
- `latest-mac.yml` SHA-256:`4af211de57004689b3f3a07455c69baf52c52274b71955fac66d3ccb08628251`
