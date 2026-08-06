/**
 * 邮箱格式本地校验：登录 identifier 提交前的确定性格式判断（规则 9：能代码化的
 * 校验不甩给 server 往返或 prompt）。设计稿把非法邮箱定义为本地即时错误态
 * （figma 347:1727：输入框红边 + 底部红字「请输入正确邮箱」），提交前本地拦截、
 * 不发 discover——与 cnPhone 的 isCompleteCnPhone 同源语义，供 mobile 与 desktop
 * 登录共同消费。
 *
 * 判定：trim 后必须形如 local@domain.tld —— 非空 local 段、单个 @、非空 domain 段、
 * 至少一个点分且点后 TLD 非空，且全程不含空白。刻意从严（覆盖设计稿反例 "2222@"
 * / "Sam@" 均判非法），不追求 RFC 5322 全量正确——真正的邮箱可达性仍由
 * auth-server discovery 权威兜底，本地只挡「明显不是邮箱」的格式错误。
 */
/**
 * 是否为格式合法的邮箱（trim 后按 local@domain.tld 判定；空串 / 缺段 / 含空白均为 false）。
 *
 * 用确定性的分段判断（indexOf/lastIndexOf + 单次线性 \s 扫描）而非歧义正则实现，
 * 语义与旧正则 /^[^\s@]+@[^\s@]+\.[^\s@]+$/ 逐字节等价，但无回溯——消除
 * polynomial-redos（旧正则在 "x@" + "a".repeat(n) 这类「有 @ 无点分」的输入上会
 * 平方级回溯）。这里的 /\s/ 是单字符类、线性匹配，不构成 ReDoS。
 */
export function isValidEmail(value: string): boolean {
  const email = value.trim();
  // 含任意空白直接判非法（等价旧正则 [^\s@] 对空白的排除）。
  if (email.length === 0 || /\s/.test(email)) return false;
  // 恰好一个 @，且左侧 local 段非空。
  const at = email.indexOf('@');
  if (at <= 0 || email.indexOf('@', at + 1) !== -1) return false;
  // domain 段：至少一个点分，点前主体非空、点后 TLD 非空。
  const domain = email.slice(at + 1);
  const dot = domain.lastIndexOf('.');
  return dot > 0 && dot < domain.length - 1;
}
