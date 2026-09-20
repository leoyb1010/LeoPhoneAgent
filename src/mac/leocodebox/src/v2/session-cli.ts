export function canInstallCli(desktop?: { setCliInstall?: unknown; getCliInstall?: unknown } | null): boolean {
  return Boolean(desktop?.setCliInstall || desktop?.getCliInstall);
}

export function installCliToast(on: boolean): string {
  return on ? '已装进终端' : '已从终端拿掉';
}

export function installCliLabel(on: boolean): string {
  return on ? '不要装在终端' : '装进终端';
}
