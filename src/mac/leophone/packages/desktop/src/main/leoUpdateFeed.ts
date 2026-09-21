/**
 * [leo] LeoPhoneAgent 的更新源。
 *
 * 上游正式包只认自家服务端 manifest(且忽略环境变量覆盖),这里把默认 manifest
 * 指向我们自己的 GitHub Release 资产;形状由 manifestUpdateProvider 决定:
 * `{ version, files: [{ url, sha512 }], releaseDate }`。
 * 生成见 scripts/leo-finalize-mac-artifacts.mjs。
 */
export const LEO_UPDATE_MANIFEST_URL =
  "https://github.com/leoyb1010/leocodebox-updates/releases/latest/download/leophone-manifest-darwin-arm64.json";
