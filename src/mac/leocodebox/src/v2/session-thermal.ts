export function isThermalHot(state?: string | null): boolean {
  return state === 'serious' || state === 'critical';
}

export function thermalHotToast(state?: string | null): string {
  return state === 'critical' ? '机器很烫了。' : '机器有点烫了。';
}

export function thermalCoolToast(): string {
  return '机器不烫了。';
}

export function thermalSendToast(): string {
  return '机器在发烫，模型会更吃这台电脑。';
}
