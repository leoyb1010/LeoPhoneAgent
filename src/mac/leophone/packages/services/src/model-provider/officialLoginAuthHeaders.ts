// 原放在 Coding Plan 订阅服务里；该服务删除后，账号连接可用性检查仍要用这两个请求头构造。
export function createBigModelLoginAuthHeaders(token: string): Record<string, string> {
  return {
    // BigModel 登录态业务接口要求 Authorization 直接传 accessToken。
    // 这里不能套 Bearer；Bearer 只适用于模型/API Key 类接口。
    Authorization: token,
    "Content-Type": "application/json",
  };
}

export function createZaiLoginAuthHeaders(token: string): Record<string, string> {
  return {
    // Z.ai provider connection 已把 access_token 持久化为业务 JWT。
    // 这里不能使用模型 API key，也不能给业务 JWT 添加 Bearer 前缀。
    Authorization: token,
    "Content-Type": "application/json",
  };
}
