/**
 * 中国大陆手机号输入处理：手机号登录当前只支持 +86，前缀在 UI 固定展示、不可切换，
 * 输入框只承载 11 位本地号码。规则全部代码化，不依赖服务端提示：
 * - 输入只保留数字；粘贴带 "+86" / "86" 国际前缀的完整号码时剥掉前缀；
 * - 超长截断到 11 位；
 * - 提交前必须是大陆手机号段（1[3-9] 开头的 11 位），发给 auth-server 时拼回
 *   完整号码（"+86" + 本地号）。
 */
export const CN_PHONE_LENGTH = 11;
export const CN_PHONE_PREFIX = '+86';
/** 大陆手机号段:1 开头、第二位 3-9、共 11 位(13x-19x 全覆盖)。 */
const CN_MOBILE_PATTERN = /^1[3-9]\d{9}$/;

/** 清洗用户输入为本地号码数字串（粘贴容错：去非数字、剥 86 国际前缀、截断）。 */
export function sanitizeCnPhoneInput(raw: string): string {
  let digits = raw.replace(/\D/g, '');
  // 只有超出本地号长度时才剥 86 前缀：避免把用户正在输入的 "86…" 开头串误剥
  // (大陆手机号首位是 1,11 位内以 86 开头的串会被 isCompleteCnPhone 的号段
  // 校验挡在提交门槛外,不在这里猜测剥前缀)。
  if (digits.length > CN_PHONE_LENGTH && digits.startsWith('86')) {
    digits = digits.slice(2);
  }
  return digits.slice(0, CN_PHONE_LENGTH);
}

/** 是否已是完整且号段合法的大陆手机号。只校验长度不够:固定 +86 的 UI 无法让用户修正错误号段,必须本地拦截。 */
export function isCompleteCnPhone(digits: string): boolean {
  return CN_MOBILE_PATTERN.test(digits);
}

/** 拼回提交给 auth-server 的完整号码。 */
export function toCnE164(digits: string): string {
  return `${CN_PHONE_PREFIX}${digits}`;
}
