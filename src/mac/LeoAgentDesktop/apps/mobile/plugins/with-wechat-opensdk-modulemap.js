const { withPodfile } = require("@expo/config-plugins");

// XdtWechatLogin(package.json 依赖,expo autolinking 无条件装 pod)靠手写 modulemap 让 Swift
// `import WechatOpenSDK`(腾讯 SDK 是纯 ObjC 静态库,自身不带 modulemap)。clang 解析 modulemap
// 里 `header "WXApi.h"` 这类相对路径时只认 modulemap 自身所在目录,-I / -Xcc -I 一概不参与
// (2026-07 archive 实测:编译命令带着 -Xcc -I$(PODS_ROOT)/WechatOpenSDK/OpenSDK2.0.5 仍报
// header not found)。所以 modulemap 必须物理落在 SDK 头文件旁边;Podfile 由 expo prebuild
// 重新生成,这份拷贝逻辑只能注入 post_install 才能在每次 prebuild / pod install 后存活。
// podspec 侧配套:XdtWechatLogin.podspec 的 SWIFT_INCLUDE_PATHS 指向同一目录。
// 注意:必须无条件注册(区别于按 env 门控的 xdt-wechat-login/plugin)——只要 pod 装了
// WechatOpenSDK,XdtWechatLogin 的 Swift 编译就依赖这份 modulemap,与微信登录是否启用无关。
const HOOK_MARKER = "xdt-wechat-login: WechatOpenSDK modulemap";
const SIMULATOR_HOOK_MARKER =
  "xdt-wechat-login: arm64 simulator stub linkage v3";
const MODULEMAP_HOOK = `
    # ${HOOK_MARKER}(clang 只按 modulemap 所在目录解析 header 相对路径,拷到 SDK 头文件旁)
    require 'fileutils'
    wechat_mm = File.expand_path('../../modules/xdt-wechat-login/ios/WechatOpenSDK/module.modulemap', installer.sandbox.root.to_s)
    wechat_headers = Dir[File.join(installer.sandbox.root.to_s, 'WechatOpenSDK', '*', 'WXApi.h')]
    raise 'xdt-wechat-login: Pods/WechatOpenSDK 下未找到 WXApi.h,无法落位 module.modulemap(SDK 目录布局变了?)' if wechat_headers.empty?
    wechat_headers.each do |header|
      FileUtils.cp(wechat_mm, File.join(File.dirname(header), 'module.modulemap'))
    end
`;

const SIMULATOR_HOOK = `
    # ${SIMULATOR_HOOK_MARKER}
    # WechatOpenSDK 2.0.5 的 arm64 切片是 iphoneos 格式，podspec 因此会把 arm64
    # 从 iphonesimulator 排除。iOS 26 Simulator 已不能安装这样产出的 x86_64 app。
    # Simulator 由 XdtWechatAuthCoordinator 的 targetEnvironment stub 承载，所以这里:
    # 1. 不让 device-only SDK 把整个 app 迫成 x86_64;
    # 2. 从通用 linker flags 移除 WechatOpenSDK，再只为 iphoneos 加回，避免 simulator 链接设备库;
    # 3. podspec 的 user_target_xcconfig 会把同样的 EXCLUDED_ARCHS 传进聚合 xcconfig
    #    (Pods-<App>.*.xcconfig)迫使 app target 也变 x86_64——一并剥掉(v3;只影响
    #    simulator 构建设置,iphoneos 出包不读该条件化 key)。
    wechat_excluded_archs_key = 'EXCLUDED_ARCHS[sdk=iphonesimulator*]'
    installer.pods_project.targets.each do |target|
      next unless target.name == 'WechatOpenSDK'
      target.build_configurations.each do |configuration|
        configuration.build_settings[wechat_excluded_archs_key] = ''
      end
    end
    installer.aggregate_targets.each do |aggregate_target|
      aggregate_target.xcconfigs.each do |configuration_name, xcconfig|
        changed = false
        # Xcodeproj::Config 会把 -l 库单独存在 other_linker_flags，不能从 attributes 读取。
        if xcconfig.other_linker_flags[:libraries].delete?('WechatOpenSDK')
          xcconfig.attributes['OTHER_LDFLAGS[sdk=iphoneos*]'] =
            '$(inherited) -l"WechatOpenSDK"'
          changed = true
        end
        if xcconfig.attributes[wechat_excluded_archs_key].to_s.include?('arm64')
          xcconfig.attributes.delete(wechat_excluded_archs_key)
          changed = true
        end
        xcconfig.save_as(aggregate_target.xcconfig_path(configuration_name)) if changed
      end
    end
`;

const POST_INSTALL_PATTERN = /post_install do \|installer\|/;

/** 把缺失的 WeChat post_install hook 独立补入，兼容已生成过旧 modulemap hook 的 Podfile。 */
function injectPostInstallHooks(contents) {
  const missingHooks = [];
  if (!contents.includes(HOOK_MARKER)) missingHooks.push(MODULEMAP_HOOK);
  if (!contents.includes(SIMULATOR_HOOK_MARKER)) {
    missingHooks.push(SIMULATOR_HOOK);
  }
  if (missingHooks.length === 0) return contents;
  if (!POST_INSTALL_PATTERN.test(contents)) {
    throw new Error(
      "with-wechat-opensdk-modulemap: Podfile 未找到 post_install 块,无法注入 WechatOpenSDK 安装配置",
    );
  }
  return contents.replace(
    POST_INSTALL_PATTERN,
    `post_install do |installer|${missingHooks.join("")}`,
  );
}

module.exports = function withWechatOpenSdkModulemap(config) {
  return withPodfile(config, (podfileConfig) => {
    podfileConfig.modResults.contents = injectPostInstallHooks(
      podfileConfig.modResults.contents,
    );
    return podfileConfig;
  });
};

module.exports.injectPostInstallHooks = injectPostInstallHooks;
