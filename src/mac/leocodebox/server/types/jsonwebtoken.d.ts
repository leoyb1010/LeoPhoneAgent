declare module 'jsonwebtoken' {
  export type JwtPayload = {
    [key: string]: unknown;
    exp?: number;
    iat?: number;
    userId?: number;
  };

  export type SignOptions = {
    expiresIn?: string | number;
  };

  const jwt: {
    sign(payload: object, secret: string, options?: SignOptions): string;
    verify(token: string, secret: string): JwtPayload;
  };

  export default jwt;
}
