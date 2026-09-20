import os from 'node:os';
import path from 'node:path';

export const CLI_MARK = 'leocodebox desktop shim';
export const CLI_PATH_MARK = 'leocodebox-cli-path';
export const DEFAULT_APP = '/Applications/leocodebox.app';

export function cliShimBody(appPath = DEFAULT_APP) {
  return `#!/bin/sh
# ${CLI_MARK}
APP=${JSON.stringify(String(appPath))}
if [ ! -d "$APP" ]; then
  echo "leocodebox.app 不在 $APP" >&2
  exit 1
fi
if [ -n "$1" ]; then
  TARGET="$1"
else
  TARGET="$PWD"
fi
case "$TARGET" in
  /*) ABS="$TARGET" ;;
  *) ABS="$PWD/$TARGET" ;;
esac
if [ -d "$ABS" ]; then
  ABS="$(cd "$ABS" && pwd)"
fi
exec /usr/bin/open -na "$APP" --args --cwd="$ABS"
`;
}

export function cwdFromArgv(argv) {
  for (const arg of argv || []) {
    const text = String(arg ?? '');
    if (text.startsWith('--cwd=')) return text.slice('--cwd='.length);
  }
  return '';
}

export function cliBinPaths(home = os.homedir()) {
  return [
    '/usr/local/bin/leocodebox',
    path.join(home, '.local', 'bin', 'leocodebox'),
  ];
}

export function localBinDir(home = os.homedir()) {
  return path.join(home, '.local', 'bin');
}

export function pathHasLocalBin(envPath, home = os.homedir()) {
  const local = localBinDir(home);
  return (envPath || '').split(':').includes(local);
}

export function zprofilePathLine() {
  return `export PATH="$HOME/.local/bin:$PATH" # ${CLI_PATH_MARK}`;
}

export function withLocalBinOnPath(existing) {
  const text = String(existing ?? '');
  if (text.includes(CLI_PATH_MARK)) return text;
  const line = zprofilePathLine();
  return text.endsWith('\n') || text === '' ? `${text}${line}\n` : `${text}\n${line}\n`;
}
