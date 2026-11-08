export function pack(token: string, destination: string, sources: string[]): Promise<void>;
export function progress(token: string): number;
export function cancel(token: string): void;
