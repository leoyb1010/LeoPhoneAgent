const { withInfoPlist } = require('@expo/config-plugins');

// expo-audio@56 defaults enableBackgroundPlayback to true and only ever appends
// UIBackgroundModes/audio; setting the option to false does not remove a value
// left by an earlier incremental prebuild. Cindy's playback and voice capture are
// foreground-only, so deterministically strip just `audio` while preserving any
// unrelated background modes that may be added in the future.
//
// ⚠️ withInfoPlist mods execute in reverse plugin registration order. Keep this
// plugin BEFORE expo-audio in app.json so this cleanup runs after expo-audio.
function stripBackgroundAudioMode(infoPlist) {
  const modes = infoPlist?.UIBackgroundModes;
  if (!Array.isArray(modes)) return infoPlist;

  const foregroundOnlyModes = modes.filter((mode) => mode !== 'audio');
  if (foregroundOnlyModes.length > 0) {
    infoPlist.UIBackgroundModes = foregroundOnlyModes;
  } else {
    delete infoPlist.UIBackgroundModes;
  }
  return infoPlist;
}

function withForegroundOnlyAudio(config) {
  return withInfoPlist(config, (iosConfig) => {
    iosConfig.modResults = stripBackgroundAudioMode(iosConfig.modResults);
    return iosConfig;
  });
}

module.exports = withForegroundOnlyAudio;
module.exports.stripBackgroundAudioMode = stripBackgroundAudioMode;
