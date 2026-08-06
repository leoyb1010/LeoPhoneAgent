/**
 * newMakerDraftKeys —— New Maker 草稿页 composer 的草稿键常量(单一来源)。
 *
 * 独立成最小模块的原因:web-browser 插件(RSB 页面评论)需要把项目草稿页
 * 侧栏 bucket 的评论路由到这个键,若直接从 NewMakerDraftRoute.tsx 引会形成
 * 「NewMakerDraftRoute → RSB shell → web-browser 插件 → NewMakerDraftRoute」
 * 的模块环;抽出常量后两侧都只依赖本文件,无环。
 */

/** New Maker 草稿页(尚无真实 session)composer 的 composerDraftStore 键。 */
export const NEW_MAKER_DRAFT_KEY = '__new_maker_draft__';
