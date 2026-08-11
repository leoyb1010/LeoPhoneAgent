const { spawnSync } = require('node:child_process');

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const result = spawnSync('/usr/bin/xattr', ['-cr', context.appOutDir], {
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`Failed to clear macOS extended attributes: ${result.stderr || result.stdout}`);
  }
};
