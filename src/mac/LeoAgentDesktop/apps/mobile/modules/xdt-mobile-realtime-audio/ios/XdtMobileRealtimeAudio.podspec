require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'XdtMobileRealtimeAudio'
  s.version        = package['version']
  s.summary        = 'Realtime PCM microphone capture for Cindy mobile voice input.'
  s.description    = 'Expo module that streams iOS microphone audio as PCM16 chunks for Cindy mobile realtime dictation.'
  s.license        = { :type => 'Apache-2.0', :file => '../../../../../LICENSE' }
  s.author         = 'Cindy'
  s.homepage       = 'https://github.com/makecindy/cindy'
  s.platforms      = {
    :ios => '16.4'
  }
  # 显式钉 Swift 5 语言模式(canonical '5.0'):SDK 56 / Xcode 26 工具链若把工程默认拉到 Swift 6
  # 严格并发,会对音频线程闭包跨 main actor 的捕获报数据竞争错误。Swift 6 并发改造留 follow-up。
  s.swift_version  = '5.0'
  s.source         = { git: 'https://github.com/makecindy/cindy.git' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  s.source_files = '**/*.{h,m,swift}'
end
