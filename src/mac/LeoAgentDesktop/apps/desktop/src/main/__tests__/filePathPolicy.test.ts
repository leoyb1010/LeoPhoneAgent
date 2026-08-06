/**
 * filePathPolicy.test.ts
 * ---------------------------------------------------------------------------
 * Directory-confinement policy for the auto-loaded xdt-file:// media protocol.
 * Pure functions — no Electron / real fs. Platform is injected so Windows path
 * semantics (backslashes, case-insensitivity, drive letters) are exercised on
 * a POSIX runner too (rule 15: macOS / Windows parity).
 *
 * Covers: sensitive-dir hit rejected, normal media path allowed, `..` collapse
 * into a sensitive dir rejected, prefix confusion (/data/foobar NOT inside
 * /data/foo) allowed, and macOS firmlink coverage (realpath'd /private/etc and
 * firmlinked home still match).
 */

import { describe, it, expect } from 'vitest';

import {
  buildSensitiveMediaBlocklist,
  buildSystemPathBlocklist,
  buildWin32SystemBlocklist,
  isPathAllowedAgainst,
} from '../filePathPolicy';

// ---------------------------------------------------------------------------
// isPathAllowedAgainst — containment + prefix-boundary (platform injected)
// ---------------------------------------------------------------------------

describe('isPathAllowedAgainst — prefix boundary + `..` collapse', () => {
  const bl = ['/data/foo'];

  it('blocks the root itself and files strictly inside it', () => {
    expect(isPathAllowedAgainst('/data/foo', bl, 'linux')).toBe(false);
    expect(isPathAllowedAgainst('/data/foo/x.png', bl, 'linux')).toBe(false);
    expect(isPathAllowedAgainst('/data/foo/deep/y.pdf', bl, 'linux')).toBe(false);
  });

  it('does NOT treat a sibling with a shared prefix as inside (/data/foobar)', () => {
    expect(isPathAllowedAgainst('/data/foobar/x.png', bl, 'linux')).toBe(true);
    expect(isPathAllowedAgainst('/data/foo-bar/x.png', bl, 'linux')).toBe(true);
  });

  it('collapses `..` before the check so escapes back into a blocked dir are caught', () => {
    expect(isPathAllowedAgainst('/data/foo/../foo/secret.svg', bl, 'linux')).toBe(false);
    expect(isPathAllowedAgainst('/data/bar/../foo/secret.svg', bl, 'linux')).toBe(false);
    // `..` that lands OUTSIDE the blocked dir stays allowed.
    expect(isPathAllowedAgainst('/data/foo/../bar/ok.png', bl, 'linux')).toBe(true);
  });

  it('rejects non-absolute / empty input (fail-closed)', () => {
    expect(isPathAllowedAgainst('', bl, 'linux')).toBe(false);
    expect(isPathAllowedAgainst('relative/x.png', bl, 'linux')).toBe(false);
  });

  it('win32: case-insensitive + backslash boundary', () => {
    const wbl = ['C:\\Windows'];
    expect(isPathAllowedAgainst('C:\\Windows\\System32\\a.png', wbl, 'win32')).toBe(false);
    expect(isPathAllowedAgainst('c:\\windows\\system32\\a.png', wbl, 'win32')).toBe(false);
    // prefix confusion: C:\Windows123 is NOT inside C:\Windows
    expect(isPathAllowedAgainst('C:\\Windows123\\a.png', wbl, 'win32')).toBe(true);
    expect(isPathAllowedAgainst('D:\\photos\\a.png', wbl, 'win32')).toBe(true);
  });

  it('win32: extended-length / device-namespace prefixes cannot bypass the blocklist', () => {
    const wbl = ['C:\\Windows'];
    // \\?\ (extended-length) and \\.\ (device namespace) must canonicalize to
    // the same C:\Windows form — otherwise they slip straight past the entry.
    expect(isPathAllowedAgainst('\\\\?\\C:\\Windows\\System32\\a.svg', wbl, 'win32')).toBe(false);
    expect(isPathAllowedAgainst('\\\\.\\C:\\Windows\\System32\\a.svg', wbl, 'win32')).toBe(false);
    expect(isPathAllowedAgainst('\\\\?\\c:\\windows\\system32\\a.svg', wbl, 'win32')).toBe(false);
    // innocuous extended-length path stays allowed
    expect(isPathAllowedAgainst('\\\\?\\D:\\photos\\a.svg', wbl, 'win32')).toBe(true);
  });

  it('win32: \\\\?\\UNC namespace canonicalizes to the plain UNC share', () => {
    const wbl = ['\\\\server\\share'];
    expect(isPathAllowedAgainst('\\\\?\\UNC\\server\\share\\secret.svg', wbl, 'win32')).toBe(false);
    expect(isPathAllowedAgainst('\\\\server\\share\\secret.svg', wbl, 'win32')).toBe(false);
    // a different share is not inside the blocked one
    expect(isPathAllowedAgainst('\\\\server\\other\\ok.svg', wbl, 'win32')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildSystemPathBlocklist — unchanged legacy behavior
// ---------------------------------------------------------------------------

describe('buildSystemPathBlocklist', () => {
  it('posix: temp-safe (no bare /var — macOS temp is /var/folders)', () => {
    const list = buildSystemPathBlocklist({ platform: 'linux' });
    expect(list).toContain('/var/log');
    expect(list).not.toContain('/var');
  });

  it('win32: derives from env, defaults to canonical C-drive paths', () => {
    const list = buildWin32SystemBlocklist({});
    expect(list).toContain('C:\\Windows');
    expect(list).toContain('C:\\Program Files');
    // de-dupes when ProgramFiles === ProgramFiles(x86) (32-bit Windows)
    const collapsed = buildWin32SystemBlocklist({
      SystemRoot: 'C:\\Windows',
      ProgramFiles: 'C:\\PF',
      'ProgramFiles(x86)': 'C:\\PF',
      ProgramData: 'C:\\PD',
    } as NodeJS.ProcessEnv);
    expect(collapsed.filter((p) => p === 'C:\\PF')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// buildSensitiveMediaBlocklist — credential dirs + firmlink double-coverage
// ---------------------------------------------------------------------------

describe('buildSensitiveMediaBlocklist (linux)', () => {
  const identity = (p: string) => p;
  const HOME = '/home/alice';
  const bl = buildSensitiveMediaBlocklist({
    platform: 'linux',
    homeDir: HOME,
    // Hermetic: pin env to {} so the ambient process.env (CI runs under pnpm and
    // sets XDG_CONFIG_HOME / npm_config_* etc.) can't leak in and repoint
    // configBase away from `${HOME}/.config`, breaking home-relative asserts.
    env: {} as NodeJS.ProcessEnv,
    realpathSync: identity,
  });

  it('blocks credential dot-dirs and OS internals; allows normal media', () => {
    for (const rel of ['.ssh', '.aws', '.gnupg', '.kube', '.docker', '.azure']) {
      expect(isPathAllowedAgainst(`${HOME}/${rel}/x.svg`, bl, 'linux')).toBe(false);
    }
    // single credential FILES directly in $HOME (exact match, not the whole $HOME)
    for (const f of ['.npmrc', '.netrc', '.git-credentials', '.pypirc']) {
      expect(isPathAllowedAgainst(`${HOME}/${f}`, bl, 'linux')).toBe(false);
    }
    // package-manager credential files nested under non-secret dirs (exact only)
    for (const f of ['.cargo/credentials.toml', '.cargo/credentials', '.m2/settings.xml', '.m2/settings-security.xml', '.config/containers/auth.json']) {
      expect(isPathAllowedAgainst(`${HOME}/${f}`, bl, 'linux')).toBe(false);
    }
    // but the rest of ~/.cargo (bin/cache) and ~/.m2 (repo) stay allowed
    expect(isPathAllowedAgainst(`${HOME}/.cargo/bin/rustc`, bl, 'linux')).toBe(true);
    expect(isPathAllowedAgainst(`${HOME}/.m2/repository/x/y.jar`, bl, 'linux')).toBe(true);
    // a same-named file nested elsewhere is NOT blocked (exact home entry only)
    expect(isPathAllowedAgainst(`${HOME}/projects/app/.npmrc`, bl, 'linux')).toBe(true);
    expect(isPathAllowedAgainst(`${HOME}/.config/gcloud/creds.png`, bl, 'linux')).toBe(false);
    expect(isPathAllowedAgainst('/etc/shadow.png', bl, 'linux')).toBe(false);
    // legitimate loads stay allowed
    expect(isPathAllowedAgainst(`${HOME}/Downloads/pic.png`, bl, 'linux')).toBe(true);
    expect(isPathAllowedAgainst(`${HOME}/projects/app/out.pdf`, bl, 'linux')).toBe(true);
    expect(isPathAllowedAgainst('/mnt/vol/repo/img.png', bl, 'linux')).toBe(true);
    // GNOME/libsecret keyrings (current + legacy locations)
    expect(isPathAllowedAgainst(`${HOME}/.local/share/keyrings/login.keyring`, bl, 'linux')).toBe(false);
    expect(isPathAllowedAgainst(`${HOME}/.gnome2/keyrings/default.keyring`, bl, 'linux')).toBe(false);
    // the rest of ~/.local/share (non-keyring app data) stays allowed
    expect(isPathAllowedAgainst(`${HOME}/.local/share/myapp/asset.png`, bl, 'linux')).toBe(true);
    // does NOT block the whole ~/.config (Linux userData lives there)
    expect(isPathAllowedAgainst(`${HOME}/.config/xdt-maker/cache/a.png`, bl, 'linux')).toBe(true);
    // does NOT block bare /var (temp lives at /var/folders on macOS)
    expect(isPathAllowedAgainst('/var/folders/xx/T/attach.png', bl, 'linux')).toBe(true);
    // browser profiles
    expect(isPathAllowedAgainst(`${HOME}/.config/google-chrome/Default/hist.png`, bl, 'linux')).toBe(false);
    expect(isPathAllowedAgainst(`${HOME}/.config/chromium/Default/hist.png`, bl, 'linux')).toBe(false);
    expect(isPathAllowedAgainst(`${HOME}/.config/google-chrome/Default/hist.png`, bl, 'linux')).toBe(false);
    expect(isPathAllowedAgainst(`${HOME}/.mozilla/firefox/profile/cookies.png`, bl, 'linux')).toBe(false);
  });

  it('derives config roots from $XDG_CONFIG_HOME and covers Chrome channel variants', () => {
    const XDG = '/home/alice/.custom-config';
    const xdgBl = buildSensitiveMediaBlocklist({
      platform: 'linux',
      homeDir: HOME,
      env: { XDG_CONFIG_HOME: XDG } as NodeJS.ProcessEnv,
      realpathSync: identity,
    });
    // redirected config home: real profile roots live under $XDG_CONFIG_HOME
    expect(isPathAllowedAgainst(`${XDG}/google-chrome/Default/hist.png`, xdgBl, 'linux')).toBe(false);
    expect(isPathAllowedAgainst(`${XDG}/chromium/Default/hist.png`, xdgBl, 'linux')).toBe(false);
    expect(isPathAllowedAgainst(`${XDG}/gcloud/creds.png`, xdgBl, 'linux')).toBe(false);
    // gcloud ignores $XDG_CONFIG_HOME (only $CLOUDSDK_CONFIG overrides it):
    // the home-anchored default must stay covered even with XDG redirected.
    expect(isPathAllowedAgainst(`${HOME}/.config/gcloud/creds.png`, xdgBl, 'linux')).toBe(false);
    // non-stable Chrome channels also blocked
    expect(isPathAllowedAgainst(`${XDG}/google-chrome-beta/Default/hist.png`, xdgBl, 'linux')).toBe(false);
    expect(isPathAllowedAgainst(`${XDG}/google-chrome-unstable/Default/hist.png`, xdgBl, 'linux')).toBe(false);
    expect(isPathAllowedAgainst(`${XDG}/google-chrome-canary/Default/hist.png`, xdgBl, 'linux')).toBe(false);
    expect(isPathAllowedAgainst(`${XDG}/google-chrome-for-testing/Default/hist.png`, xdgBl, 'linux')).toBe(false);
    // Edge Linux channels (stable/beta/dev) blocked under the same bases
    expect(isPathAllowedAgainst(`${XDG}/microsoft-edge/Default/hist.png`, xdgBl, 'linux')).toBe(false);
    expect(isPathAllowedAgainst(`${XDG}/microsoft-edge-beta/Default/hist.png`, xdgBl, 'linux')).toBe(false);
    expect(isPathAllowedAgainst(`${XDG}/microsoft-edge-dev/Default/hist.png`, xdgBl, 'linux')).toBe(false);
    expect(isPathAllowedAgainst(`${HOME}/.config/microsoft-edge/Default/hist.png`, bl, 'linux')).toBe(false);
    // other mainstream Chromium browsers (Brave / Vivaldi / Opera)
    expect(isPathAllowedAgainst(`${XDG}/BraveSoftware/Brave-Browser/Default/hist.png`, xdgBl, 'linux')).toBe(false);
    expect(isPathAllowedAgainst(`${XDG}/vivaldi/Default/hist.png`, xdgBl, 'linux')).toBe(false);
    expect(isPathAllowedAgainst(`${XDG}/opera/Default/hist.png`, xdgBl, 'linux')).toBe(false);
    expect(isPathAllowedAgainst(`${HOME}/.config/BraveSoftware/Brave-Browser/Default/hist.png`, bl, 'linux')).toBe(false);
  });

  it('blocks Flatpak / Snap sandboxed browser profile roots; other sandboxed apps stay allowed', () => {
    for (const rel of [
      '.var/app/org.mozilla.firefox/.mozilla/firefox/prof/cookies.png',
      '.var/app/org.chromium.Chromium/config/chromium/Default/hist.png',
      '.var/app/com.google.Chrome/config/google-chrome/Default/hist.png',
      '.var/app/com.microsoft.Edge/config/microsoft-edge/Default/hist.png',
      '.var/app/com.brave.Browser/config/BraveSoftware/Brave-Browser/Default/hist.png',
      'snap/firefox/common/.mozilla/firefox/prof/cookies.png',
      'snap/chromium/common/chromium/Default/hist.png',
      'snap/brave/current/.config/BraveSoftware/Brave-Browser/Default/hist.png',
    ]) {
      expect(isPathAllowedAgainst(`${HOME}/${rel}`, bl, 'linux')).toBe(false);
    }
    // non-browser sandboxed apps keep their media readable
    expect(isPathAllowedAgainst(`${HOME}/.var/app/org.gimp.GIMP/data/out.png`, bl, 'linux')).toBe(true);
    expect(isPathAllowedAgainst(`${HOME}/snap/vlc/common/thumb.png`, bl, 'linux')).toBe(true);
  });

  it('honors $CHROME_USER_DATA_DIR as a full profile root (no channel suffix)', () => {
    const UDD = '/home/alice/chrome-profiles/main';
    const uddBl = buildSensitiveMediaBlocklist({
      platform: 'linux',
      homeDir: HOME,
      env: { CHROME_USER_DATA_DIR: UDD } as NodeJS.ProcessEnv,
      realpathSync: identity,
    });
    expect(isPathAllowedAgainst(`${UDD}/Default/hist.png`, uddBl, 'linux')).toBe(false);
    // siblings outside the profile root stay allowed
    expect(isPathAllowedAgainst('/home/alice/chrome-profiles-archive/pic.png', uddBl, 'linux')).toBe(true);
  });

  it('honors $CHROME_CONFIG_HOME as an alternate Chrome/Chromium config prefix', () => {
    const CHROME = '/home/alice/.chrome-cfg';
    const XDG = '/home/alice/.custom-config';
    const chBl = buildSensitiveMediaBlocklist({
      platform: 'linux',
      homeDir: HOME,
      env: { CHROME_CONFIG_HOME: CHROME, XDG_CONFIG_HOME: XDG } as NodeJS.ProcessEnv,
      realpathSync: identity,
    });
    // profiles under $CHROME_CONFIG_HOME are blocked …
    expect(isPathAllowedAgainst(`${CHROME}/google-chrome/Default/hist.png`, chBl, 'linux')).toBe(false);
    expect(isPathAllowedAgainst(`${CHROME}/chromium/Default/hist.png`, chBl, 'linux')).toBe(false);
    // … and the $XDG_CONFIG_HOME base stays covered too (both prefixes denied).
    expect(isPathAllowedAgainst(`${XDG}/google-chrome/Default/hist.png`, chBl, 'linux')).toBe(false);
    // gcloud/gh still derive from XDG (not CHROME_CONFIG_HOME).
    expect(isPathAllowedAgainst(`${XDG}/gcloud/creds.png`, chBl, 'linux')).toBe(false);
  });
});

describe('buildSensitiveMediaBlocklist (darwin)', () => {
  const HOME = '/Users/alice';
  const bl = buildSensitiveMediaBlocklist({
    platform: 'darwin',
    homeDir: HOME,
    env: {} as NodeJS.ProcessEnv, // hermetic — see linux fixture note
    realpathSync: (p) => p,
  });

  it('blocks browser profiles including Edge on macOS', () => {
    expect(
      isPathAllowedAgainst(`${HOME}/Library/Application Support/Google/Chrome/Default/hist.png`, bl, 'darwin'),
    ).toBe(false);
    expect(
      isPathAllowedAgainst(`${HOME}/Library/Application Support/Firefox/Profiles/cookies.png`, bl, 'darwin'),
    ).toBe(false);
    expect(
      isPathAllowedAgainst(`${HOME}/Library/Application Support/Microsoft Edge/Default/hist.png`, bl, 'darwin'),
    ).toBe(false);
    // Safari (default macOS browser): profile + sandboxed container roots
    expect(isPathAllowedAgainst(`${HOME}/Library/Safari/History.png`, bl, 'darwin')).toBe(false);
    expect(
      isPathAllowedAgainst(`${HOME}/Library/Containers/com.apple.Safari/Data/hist.png`, bl, 'darwin'),
    ).toBe(false);
    // legitimate: user Downloads and Pictures stay allowed
    expect(isPathAllowedAgainst(`${HOME}/Downloads/photo.png`, bl, 'darwin')).toBe(true);
    // the rest of ~/Library/Containers (other apps) stays allowed
    expect(
      isPathAllowedAgainst(`${HOME}/Library/Containers/com.example.App/Data/pic.png`, bl, 'darwin'),
    ).toBe(true);
  });

  it('blocks Chromium + Chrome/Edge channel profile roots (siblings under Application Support)', () => {
    for (const rel of [
      'Google/Chrome Beta',
      'Google/Chrome Dev',
      'Google/Chrome Canary',
      'Google/Chrome for Testing',
      'Chromium',
      'Microsoft Edge Beta',
      'Microsoft Edge Dev',
      'Microsoft Edge Canary',
      'BraveSoftware/Brave-Browser',
      'com.operasoftware.Opera',
      'com.operasoftware.OperaGX',
      'Vivaldi',
    ]) {
      expect(
        isPathAllowedAgainst(`${HOME}/Library/Application Support/${rel}/Default/hist.png`, bl, 'darwin'),
      ).toBe(false);
    }
    // the rest of Application Support (e.g. our own userData) stays allowed
    expect(
      isPathAllowedAgainst(`${HOME}/Library/Application Support/xdt-maker/cache/a.png`, bl, 'darwin'),
    ).toBe(true);
  });
});

describe('buildSensitiveMediaBlocklist — firmlink / symlink double-coverage', () => {
  it('macOS: realpath-resolved /private/etc and firmlinked home both match', () => {
    const HOME = '/Users/alice';
    // Simulate macOS firmlinks: /etc→/private/etc, /Users/alice→data volume.
    const firmlink: Record<string, string> = {
      '/etc': '/private/etc',
      [`${HOME}/.ssh`]: '/System/Volumes/Data/Users/alice/.ssh',
    };
    const bl = buildSensitiveMediaBlocklist({
      platform: 'darwin',
      homeDir: HOME,
      realpathSync: (p) => firmlink[p] ?? p,
    });
    // A target that has been realpath'd (as the handler does) still matches.
    expect(isPathAllowedAgainst('/private/etc/x.pdf', bl, 'darwin')).toBe(false);
    expect(
      isPathAllowedAgainst('/System/Volumes/Data/Users/alice/.ssh/id_rsa.svg', bl, 'darwin'),
    ).toBe(false);
    // and the un-resolved forms too (double-coverage keeps both)
    expect(isPathAllowedAgainst('/etc/x.pdf', bl, 'darwin')).toBe(false);
    expect(isPathAllowedAgainst(`${HOME}/.ssh/id_rsa.svg`, bl, 'darwin')).toBe(false);
  });

  it('missing roots under a symlinked home map through the nearest existing ancestor', () => {
    const HOME = '/home/alice';
    const REAL_HOME = '/mnt/data/home/alice';
    // home exists (symlinked to the data volume); nothing under it exists yet,
    // so every home-derived root hits the ENOENT fallback at build time.
    const realpathSync = (target: string): string => {
      if (target === HOME) return REAL_HOME;
      if (target.startsWith(`${HOME}/`)) throw new Error('ENOENT');
      return target;
    };
    const bl = buildSensitiveMediaBlocklist({ platform: 'linux', homeDir: HOME, env: {} as NodeJS.ProcessEnv, realpathSync });
    // ~/.ssh created later: the handler realpath's the file to the data volume,
    // which must still be denied via the ancestor-mapped variant.
    expect(isPathAllowedAgainst(`${REAL_HOME}/.ssh/id_rsa.png`, bl, 'linux')).toBe(false);
    expect(isPathAllowedAgainst(`${REAL_HOME}/.config/google-chrome/Default/hist.png`, bl, 'linux')).toBe(false);
    // literal (un-resolved) forms stay covered
    expect(isPathAllowedAgainst(`${HOME}/.ssh/id_rsa.png`, bl, 'linux')).toBe(false);
    // normal media on the data volume stays allowed
    expect(isPathAllowedAgainst(`${REAL_HOME}/Downloads/pic.png`, bl, 'linux')).toBe(true);
  });
});

describe('buildSensitiveMediaBlocklist — env-redirected credential dirs', () => {
  it('honors CLOUDSDK_CONFIG / GH_CONFIG_DIR / GNUPGHOME / DOCKER_CONFIG / AZURE_CONFIG_DIR', () => {
    const HOME = '/home/alice';
    const bl = buildSensitiveMediaBlocklist({
      platform: 'linux',
      homeDir: HOME,
      env: {
        CLOUDSDK_CONFIG: '/srv/creds/gcloud',
        GH_CONFIG_DIR: '/srv/creds/gh',
        GNUPGHOME: '/srv/creds/gnupg',
        DOCKER_CONFIG: '/srv/creds/docker',
        AZURE_CONFIG_DIR: '/srv/creds/azure',
      } as NodeJS.ProcessEnv,
      realpathSync: (p) => p,
    });
    for (const dir of ['gcloud', 'gh', 'gnupg', 'docker', 'azure']) {
      expect(isPathAllowedAgainst(`/srv/creds/${dir}/token.png`, bl, 'linux')).toBe(false);
    }
    // siblings of the redirected roots stay allowed
    expect(isPathAllowedAgainst('/srv/creds-archive/pic.png', bl, 'linux')).toBe(true);
    // defaults remain covered alongside the redirects
    expect(isPathAllowedAgainst(`${HOME}/.config/gcloud/creds.png`, bl, 'linux')).toBe(false);
  });

  it('blocks file-valued credential env paths EXACTLY, without over-blocking their parent dir', () => {
    const HOME = '/home/alice';
    const bl = buildSensitiveMediaBlocklist({
      platform: 'linux',
      homeDir: HOME,
      env: {
        AWS_SHARED_CREDENTIALS_FILE: '/work/aws-creds',
        AWS_CONFIG_FILE: '/work/aws-config',
        AWS_WEB_IDENTITY_TOKEN_FILE: '/var/run/secrets/aws-token',
        GOOGLE_APPLICATION_CREDENTIALS: '/work/sa.json',
        AZURE_FEDERATED_TOKEN_FILE: '/var/run/secrets/azure/token',
        NPM_CONFIG_USERCONFIG: '/work/npmrc',
        REGISTRY_AUTH_FILE: '/work/auth.json',
        KUBECONFIG: '/tmp/kubeconfig:/tmp/kube2.yaml', // POSIX `:`-separated list
      } as NodeJS.ProcessEnv,
      realpathSync: (p) => p,
    });
    // exact credential files denied (device-link media:fetch has no ext whitelist)
    expect(isPathAllowedAgainst('/work/aws-creds', bl, 'linux')).toBe(false);
    expect(isPathAllowedAgainst('/work/aws-config', bl, 'linux')).toBe(false);
    expect(isPathAllowedAgainst('/work/sa.json', bl, 'linux')).toBe(false);
    // workload-identity token files (AWS OIDC / Azure federated) denied too
    expect(isPathAllowedAgainst('/var/run/secrets/aws-token', bl, 'linux')).toBe(false);
    expect(isPathAllowedAgainst('/var/run/secrets/azure/token', bl, 'linux')).toBe(false);
    // npm userconfig override (registry tokens) denied too
    expect(isPathAllowedAgainst('/work/npmrc', bl, 'linux')).toBe(false);
    // podman/skopeo registry auth override denied too
    expect(isPathAllowedAgainst('/work/auth.json', bl, 'linux')).toBe(false);
    // both entries of the KUBECONFIG list denied
    expect(isPathAllowedAgainst('/tmp/kubeconfig', bl, 'linux')).toBe(false);
    expect(isPathAllowedAgainst('/tmp/kube2.yaml', bl, 'linux')).toBe(false);
    // parent dirs NOT over-blocked — sibling media in the same folder stays allowed
    expect(isPathAllowedAgainst('/work/diagram.png', bl, 'linux')).toBe(true);
    expect(isPathAllowedAgainst('/tmp/screenshot.png', bl, 'linux')).toBe(true);
  });

  it('honors npm lowercase npm_config_userconfig (script-set, POSIX)', () => {
    const bl = buildSensitiveMediaBlocklist({
      platform: 'linux',
      homeDir: '/home/alice',
      env: { npm_config_userconfig: '/work/lower-npmrc' } as NodeJS.ProcessEnv,
      realpathSync: (p) => p,
    });
    expect(isPathAllowedAgainst('/work/lower-npmrc', bl, 'linux')).toBe(false);
    // parent dir not over-blocked
    expect(isPathAllowedAgainst('/work/diagram.png', bl, 'linux')).toBe(true);
  });

  it('blocks podman/containers auth.json under XDG_RUNTIME_DIR and redirected XDG_CONFIG_HOME', () => {
    const HOME = '/home/alice';
    const bl = buildSensitiveMediaBlocklist({
      platform: 'linux',
      homeDir: HOME,
      env: { XDG_RUNTIME_DIR: '/run/user/1000', XDG_CONFIG_HOME: '/home/alice/.cfg' } as NodeJS.ProcessEnv,
      realpathSync: (p) => p,
    });
    expect(isPathAllowedAgainst('/run/user/1000/containers/auth.json', bl, 'linux')).toBe(false);
    expect(isPathAllowedAgainst('/home/alice/.cfg/containers/auth.json', bl, 'linux')).toBe(false);
    // non-auth content under the runtime dir stays allowed
    expect(isPathAllowedAgainst('/run/user/1000/containers/thumb.png', bl, 'linux')).toBe(true);
  });

  it('blocks cargo credential files under a redirected $CARGO_HOME', () => {
    const HOME = '/home/alice';
    const bl = buildSensitiveMediaBlocklist({
      platform: 'linux',
      homeDir: HOME,
      env: { CARGO_HOME: '/opt/cargo' } as NodeJS.ProcessEnv,
      realpathSync: (p) => p,
    });
    expect(isPathAllowedAgainst('/opt/cargo/credentials.toml', bl, 'linux')).toBe(false);
    expect(isPathAllowedAgainst('/opt/cargo/credentials', bl, 'linux')).toBe(false);
    // non-secret cargo content under the redirected home stays allowed
    expect(isPathAllowedAgainst('/opt/cargo/registry/cache/x.crate', bl, 'linux')).toBe(true);
  });

  it('splits KUBECONFIG by the platform delimiter (`;` on win32)', () => {
    const bl = buildSensitiveMediaBlocklist({
      platform: 'win32',
      homeDir: 'C:\\Users\\alice',
      env: {
        SystemRoot: 'C:\\Windows',
        KUBECONFIG: 'C:\\work\\kubeconfig;C:\\work\\kube2.yaml',
      } as NodeJS.ProcessEnv,
      realpathSync: (p) => p,
    });
    expect(isPathAllowedAgainst('C:\\work\\kubeconfig', bl, 'win32')).toBe(false);
    expect(isPathAllowedAgainst('C:\\work\\kube2.yaml', bl, 'win32')).toBe(false);
    expect(isPathAllowedAgainst('C:\\work\\diagram.png', bl, 'win32')).toBe(true);
  });
});

describe('buildSensitiveMediaBlocklist (win32)', () => {
  const bl = buildSensitiveMediaBlocklist({
    platform: 'win32',
    homeDir: 'C:\\Users\\alice',
    env: {
      SystemRoot: 'C:\\Windows',
      ProgramFiles: 'C:\\Program Files',
      'ProgramFiles(x86)': 'C:\\Program Files (x86)',
      ProgramData: 'C:\\ProgramData',
    } as NodeJS.ProcessEnv,
    realpathSync: (p) => p,
  });

  it('blocks system dirs, credential dirs and browser profiles; allows user media', () => {
    expect(isPathAllowedAgainst('C:\\Windows\\System32\\a.png', bl, 'win32')).toBe(false);
    expect(isPathAllowedAgainst('C:\\Users\\alice\\.ssh\\key.svg', bl, 'win32')).toBe(false);
    expect(
      isPathAllowedAgainst(
        'C:\\Users\\alice\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\fav.png',
        bl,
        'win32',
      ),
    ).toBe(false);
    // gcloud / GitHub CLI credential roots under %APPDATA% (Windows defaults)
    expect(
      isPathAllowedAgainst('C:\\Users\\alice\\AppData\\Roaming\\gcloud\\creds.png', bl, 'win32'),
    ).toBe(false);
    expect(
      isPathAllowedAgainst('C:\\Users\\alice\\AppData\\Roaming\\GitHub CLI\\hosts.png', bl, 'win32'),
    ).toBe(false);
    // OS credential stores / DPAPI (Credential Locker, Protect, Vault) under both roots
    for (const root of ['Roaming', 'Local']) {
      for (const store of ['Credentials', 'Protect', 'Vault']) {
        expect(
          isPathAllowedAgainst(
            `C:\\Users\\alice\\AppData\\${root}\\Microsoft\\${store}\\blob.png`,
            bl,
            'win32',
          ),
        ).toBe(false);
      }
    }
    // legitimate: userData (AppData\Roaming\xdt-maker) and Downloads stay allowed
    expect(
      isPathAllowedAgainst('C:\\Users\\alice\\AppData\\Roaming\\xdt-maker\\cache\\a.png', bl, 'win32'),
    ).toBe(true);
    expect(isPathAllowedAgainst('C:\\Users\\alice\\Downloads\\pic.png', bl, 'win32')).toBe(true);
    expect(isPathAllowedAgainst('D:\\projects\\app\\out.pdf', bl, 'win32')).toBe(true);
  });

  it('blocks Chromium + Chrome/Edge channel profile roots under AppData\\Local', () => {
    for (const rel of [
      'Chromium\\User Data',
      'Google\\Chrome Beta\\User Data',
      'Google\\Chrome Dev\\User Data',
      'Google\\Chrome SxS\\User Data',
      'Google\\Chrome for Testing\\User Data',
      'Microsoft\\Edge Beta\\User Data',
      'Microsoft\\Edge Dev\\User Data',
      'Microsoft\\Edge SxS\\User Data',
      'BraveSoftware\\Brave-Browser\\User Data',
      'Vivaldi\\User Data',
    ]) {
      expect(
        isPathAllowedAgainst(`C:\\Users\\alice\\AppData\\Local\\${rel}\\Default\\fav.png`, bl, 'win32'),
      ).toBe(false);
    }
    // Opera lives under %APPDATA% (Roaming), not %LOCALAPPDATA%
    expect(
      isPathAllowedAgainst(
        'C:\\Users\\alice\\AppData\\Roaming\\Opera Software\\Opera Stable\\Default\\fav.png',
        bl,
        'win32',
      ),
    ).toBe(false);
  });

  it('derives browser-profile roots from %LOCALAPPDATA% / %APPDATA% when AppData is redirected', () => {
    const redirected = buildSensitiveMediaBlocklist({
      platform: 'win32',
      homeDir: 'C:\\Users\\alice',
      env: {
        SystemRoot: 'C:\\Windows',
        LOCALAPPDATA: 'D:\\Redirected\\Local',
        APPDATA: 'D:\\Redirected\\Roaming',
      } as NodeJS.ProcessEnv,
      realpathSync: (p) => p,
    });
    // real Chrome/Edge/Firefox profiles live under the redirected roots → blocked
    expect(
      isPathAllowedAgainst('D:\\Redirected\\Local\\Google\\Chrome\\User Data\\Default\\fav.png', redirected, 'win32'),
    ).toBe(false);
    expect(
      isPathAllowedAgainst('D:\\Redirected\\Local\\Microsoft\\Edge\\User Data\\Default\\fav.png', redirected, 'win32'),
    ).toBe(false);
    expect(
      isPathAllowedAgainst('D:\\Redirected\\Roaming\\Mozilla\\Firefox\\Profiles\\x\\a.png', redirected, 'win32'),
    ).toBe(false);
  });
});
