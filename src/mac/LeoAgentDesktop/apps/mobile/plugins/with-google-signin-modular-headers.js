const { withPodfile } = require("@expo/config-plugins");

// GoogleSignIn 7.x（@react-native-google-signin autolink 引入）依赖 AppCheckCore
// （Swift 静态库），其传递依赖 GoogleUtilities / RecaptchaInterop 不产 module map，
// pod install 直接报
//   "The Swift pod `AppCheckCore` depends upon `GoogleUtilities` and `RecaptchaInterop`,
//    which do not define modules"
// 官方修法是给这两个 pod 开 :modular_headers（bare RN 的 Podfile 同款），
// 不用全局 use_modular_headers!，避免惊动微信 / TapTap 等其它 pod。
const PODS = [
  "pod 'GoogleUtilities', :modular_headers => true",
  "pod 'RecaptchaInterop', :modular_headers => true",
];

module.exports = function withGoogleSigninModularHeaders(config) {
  return withPodfile(config, (podfileConfig) => {
    let contents = podfileConfig.modResults.contents;
    if (!contents.includes(PODS[0])) {
      // 插到 target 块内 use_expo_modules! 之后，保证作用于主 target
      contents = contents.replace(
        /use_expo_modules!/,
        `use_expo_modules!\n  ${PODS.join("\n  ")}`,
      );
      podfileConfig.modResults.contents = contents;
    }
    return podfileConfig;
  });
};
