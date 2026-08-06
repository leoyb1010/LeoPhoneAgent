require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'XdtWechatLogin'
  s.version        = package['version']
  s.summary        = 'Minimal WeChat authorization-code bridge for Cindy mobile.'
  s.description    = 'Expo module that requests a WeChat native login authorization code.'
  s.license        = { :type => 'Apache-2.0', :file => '../../../../../LICENSE' }
  s.author         = 'Cindy'
  s.homepage       = 'https://cindy.app'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.0'
  s.source         = { git: 'https://github.com/makecindy/cindy.git' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.dependency 'WechatOpenSDK', '2.0.5'
  s.source_files = '**/*.{h,m,swift}'

  # WechatOpenSDK is a pure ObjC static lib without a modulemap.
  # Provide one so Swift can `import WechatOpenSDK` under Xcode's explicit-modules mode.
  # clang resolves a modulemap's relative `header` paths ONLY against the modulemap's own
  # directory (-I / -Xcc -I are never consulted), so the modulemap must sit next to the SDK
  # headers: plugins/with-wechat-opensdk-modulemap.js injects a Podfile post_install hook
  # that copies WechatOpenSDK/module.modulemap into $(PODS_ROOT)/WechatOpenSDK/OpenSDK2.0.5,
  # and SWIFT_INCLUDE_PATHS points swiftc at that directory (keep the version segment in
  # sync with the s.dependency pin above).
  s.preserve_paths = 'WechatOpenSDK/module.modulemap'
  s.pod_target_xcconfig = {
    'SWIFT_INCLUDE_PATHS' => '$(PODS_ROOT)/WechatOpenSDK/OpenSDK2.0.5'
  }
end
