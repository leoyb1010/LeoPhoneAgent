// 跟踪的空模板。真实中继地址与机器名只放在被 git 忽略的 RelayLocal.ets：
//   cp RelayLocal.example.ets RelayLocal.ets  （scripts/build_hap.sh 缺失时会自动复制本模板）
// LOCAL_API_ROOT 为空时，App 显示「未配置中继地址」，不发请求。
// LOCAL_MACHINE_LABELS 每项为 [机器名, 显示名]。
export const LOCAL_API_ROOT: string = '';
export const LOCAL_MACHINE_LABELS: string[][] = [];
