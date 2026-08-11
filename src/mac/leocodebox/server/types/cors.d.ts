declare module 'cors' {
  import type { RequestHandler } from 'express';

  export type CorsOriginCallback = (error: Error | null, allow?: boolean) => void;
  export type CorsOptions = {
    origin?: (origin: string | undefined, callback: CorsOriginCallback) => void;
    exposedHeaders?: string[];
  };

  export default function cors(options?: CorsOptions): RequestHandler;
}
