export type SessionMoveTarget =
  | { kind: 'project'; workingDir: string }
  | { kind: 'browseProject' }
  | { kind: 'dialogue' };
