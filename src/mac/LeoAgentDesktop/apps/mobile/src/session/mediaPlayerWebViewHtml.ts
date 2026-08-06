import { lightColors } from '@/theme/tokens';

export type MobileMediaPlayerKind = 'video' | 'audio';
export type MobileMediaPlayerCommand = 'pause' | 'reset';
export type MobileMediaPlayerState = 'ready' | 'playing' | 'paused' | 'waiting' | 'ended' | 'error';

export interface MobileMediaPlayerStatus {
  type: 'xdt-media-player/status';
  state: MobileMediaPlayerState;
  currentTime?: number;
  duration?: number;
  error?: string;
}

export function buildMediaPlayerWebViewCommand(command: MobileMediaPlayerCommand): string {
  return JSON.stringify({
    type: 'xdt-media-player/command',
    command,
  });
}

export function buildMediaPlayerWebViewHtml({
  kind,
  mimeType,
  title,
  url,
  surface,
  chip,
}: {
  kind: MobileMediaPlayerKind;
  mimeType?: string;
  title?: string;
  url: string;
  /** 页面底色(可选,缺省 light;调用方从 useTheme().colors.surface 注入)。 */
  surface?: string;
  /** video 元素底色(可选,缺省 light;来自 colors.surfaceChip)。 */
  chip?: string;
}): string {
  const bodyBg = surface ?? lightColors.surface;
  const videoBg = chip ?? lightColors.surfaceChip;
  const escapedUrl = escapeHtml(url);
  const escapedTitle = escapeHtml(title || mediaKindLabel(kind));
  const escapedType = mimeType ? ` type="${escapeHtml(mimeType)}"` : '';
  const media = kind === 'video'
    ? `<video controls playsinline preload="metadata" aria-label="${escapedTitle}"><source src="${escapedUrl}"${escapedType}></video>`
    : `<audio controls preload="metadata" aria-label="${escapedTitle}"><source src="${escapedUrl}"${escapedType}></audio>`;

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <style>
    html, body {
      background: ${bodyBg};
      height: 100%;
      margin: 0;
      width: 100%;
    }
    body {
      align-items: center;
      display: flex;
      justify-content: center;
      overflow: hidden;
    }
    video {
      background: ${videoBg};
      height: 100%;
      object-fit: contain;
      width: 100%;
    }
    audio {
      width: min(92vw, 680px);
    }
  </style>
</head>
<body>
  ${media}
  <script>
    (function () {
      var media = document.querySelector('${kind}');
      var lastTimeUpdate = 0;
      function finite(value) {
        return Number.isFinite(value) ? Math.max(0, value) : undefined;
      }
      function emit(state, error, force) {
        var now = Date.now();
        if (!force && state === 'playing' && now - lastTimeUpdate < 1000) return;
        if (state === 'playing') lastTimeUpdate = now;
        var payload = {
          type: 'xdt-media-player/status',
          state: state,
          currentTime: finite(media.currentTime),
          duration: finite(media.duration),
          error: error || undefined
        };
        if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
          window.ReactNativeWebView.postMessage(JSON.stringify(payload));
        }
      }
      function readCommand(data) {
        if (typeof data !== 'string') return null;
        try {
          var parsed = JSON.parse(data);
          if (!parsed || parsed.type !== 'xdt-media-player/command') return null;
          return parsed.command === 'pause' || parsed.command === 'reset' ? parsed.command : null;
        } catch (error) {
          return null;
        }
      }
      function handleCommand(event) {
        var command = readCommand(event && event.data);
        if (!command) return;
        if (command === 'pause') {
          if (!media.paused) media.pause();
          emit(media.ended ? 'ended' : 'paused', undefined, true);
          return;
        }
        if (command === 'reset') {
          media.pause();
          try {
            media.currentTime = 0;
          } catch (error) {}
          emit('paused', undefined, true);
        }
      }
      if (!media) return;
      window.addEventListener('message', handleCommand);
      document.addEventListener('message', handleCommand);
      media.addEventListener('loadedmetadata', function () { emit('ready', undefined, true); });
      media.addEventListener('play', function () { emit('playing', undefined, true); });
      media.addEventListener('timeupdate', function () { emit(media.paused ? 'paused' : 'playing', undefined, false); });
      media.addEventListener('pause', function () { emit(media.ended ? 'ended' : 'paused', undefined, true); });
      media.addEventListener('waiting', function () { emit('waiting', undefined, true); });
      media.addEventListener('ended', function () { emit('ended', undefined, true); });
      media.addEventListener('error', function () {
        var err = media.error ? String(media.error.code || media.error.message || 'media error') : 'media error';
        emit('error', err, true);
      });
    })();
  </script>
</body>
</html>`;
}

export function parseMediaPlayerWebViewMessage(data: string): MobileMediaPlayerStatus | null {
  try {
    const value = JSON.parse(data) as Partial<MobileMediaPlayerStatus> | null;
    if (!value || value.type !== 'xdt-media-player/status' || !isMediaPlayerState(value.state)) return null;
    return {
      type: 'xdt-media-player/status',
      state: value.state,
      currentTime: finiteNumber(value.currentTime),
      duration: finiteNumber(value.duration),
      error: typeof value.error === 'string' ? value.error : undefined,
    };
  } catch {
    return null;
  }
}

function mediaKindLabel(kind: MobileMediaPlayerKind): string {
  return kind === 'video' ? 'Video' : 'Audio';
}

function isMediaPlayerState(value: unknown): value is MobileMediaPlayerState {
  return value === 'ready'
    || value === 'playing'
    || value === 'paused'
    || value === 'waiting'
    || value === 'ended'
    || value === 'error';
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
