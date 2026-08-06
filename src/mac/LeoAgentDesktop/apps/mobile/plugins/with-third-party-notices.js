const fs = require("node:fs");
const path = require("node:path");

const { withDangerousMod, withXcodeProject } = require("@expo/config-plugins");

const NOTICE_FILES = [
  {
    filename: "THIRD-PARTY-NOTICES.txt",
    androidFilename: "third_party_notices.txt",
  },
  {
    filename: "THIRD-PARTY-RESTRICTED.txt",
    androidFilename: "third_party_restricted.txt",
  },
];

function noticeSource(projectRoot, platform, destinationName) {
  const repoRoot = path.resolve(projectRoot, "..", "..");
  const filename =
    destinationName === "THIRD-PARTY-RESTRICTED.txt"
      ? `mobile-${platform}-restricted.txt`
      : `mobile-${platform}.txt`;
  return path.join(repoRoot, "docs", "legal", "notices", filename);
}

function copyNoticeFiles(projectRoot, platform, destinationDir) {
  fs.mkdirSync(destinationDir, { recursive: true });
  for (const notice of NOTICE_FILES) {
    const source = noticeSource(projectRoot, platform, notice.filename);
    if (!fs.existsSync(source)) {
      throw new Error(
        `third-party notice missing: ${source}; run pnpm licenses:generate`,
      );
    }
    const destinationName =
      platform === "android" ? notice.androidFilename : notice.filename;
    fs.copyFileSync(source, path.join(destinationDir, destinationName));
  }
}

function hasXcodeResource(project, filename) {
  return Object.values(project.pbxFileReferenceSection()).some(
    (entry) => entry && typeof entry === "object" && entry.path === filename,
  );
}

function withThirdPartyNotices(config) {
  config = withDangerousMod(config, [
    "android",
    async (androidConfig) => {
      const destination = path.join(
        androidConfig.modRequest.platformProjectRoot,
        "app",
        "src",
        "main",
        "res",
        "raw",
      );
      copyNoticeFiles(
        androidConfig.modRequest.projectRoot,
        "android",
        destination,
      );
      return androidConfig;
    },
  ]);

  config = withXcodeProject(config, (iosConfig) => {
    const projectRoot = iosConfig.modRequest.projectRoot;
    const platformRoot = iosConfig.modRequest.platformProjectRoot;
    copyNoticeFiles(projectRoot, "ios", platformRoot);
    const project = iosConfig.modResults;
    const target = project.getFirstTarget().uuid;
    for (const { filename } of NOTICE_FILES) {
      if (!hasXcodeResource(project, filename)) {
        project.addResourceFile(filename, { target });
      }
    }
    return iosConfig;
  });

  return config;
}

module.exports = withThirdPartyNotices;
module.exports.copyNoticeFiles = copyNoticeFiles;
module.exports.noticeSource = noticeSource;
