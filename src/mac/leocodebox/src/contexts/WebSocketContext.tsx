import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

import { useAuth } from '../components/auth/context/AuthContext';
import { IS_PLATFORM } from '../constants/config';

/**
 * One frame received from the chat websocket. The server guarantees every
 * frame carries a `kind` (provider message kinds plus gateway kinds such as
 * `chat_subscribed`, `session_upserted`, `loading_progress`,
 * `protocol_error`). The synthetic `websocket_reconnected` kind is injected
 * client-side when the socket re-opens after a drop.
 */
export type ServerEvent = {
  kind?: string;
  type?: string;
  sessionId?: string;
  seq?: number;
  [key: string]: unknown;
};

type ServerEventListener = (event: ServerEvent) => void;

type WebSocketContextType = {
  ws: WebSocket | null;
  sendMessage: (message: unknown) => void;
  /**
   * Subscribes to every websocket frame. Returns an unsubscribe function.
   *
   * This is the primary consumption API: events are dispatched synchronously
   * to every listener, so rapid back-to-back frames can never be coalesced or
   * dropped the way a single "latest message" state slot could.
   */
  subscribe: (listener: ServerEventListener) => () => void;
  isConnected: boolean;
};

const WebSocketContext = createContext<WebSocketContextType | null>(null);

export const useWebSocket = () => {
  const context = useContext(WebSocketContext);
  if (!context) {
    throw new Error('useWebSocket must be used within a WebSocketProvider');
  }
  return context;
};

/** Send a heartbeat only after this much silence; live streams need none. */
const HEARTBEAT_IDLE_MS = 30_000;
/** A pong later than this means the socket is dead even if it says OPEN. */
const HEARTBEAT_TIMEOUT_MS = 10_000;

const buildWebSocketUrl = (token: string | null) => {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  if (IS_PLATFORM) return `${protocol}//${window.location.host}/ws`; // Platform mode: Use same domain as the page (goes through proxy)
  if (!token) return null;
  return `${protocol}//${window.location.host}/ws?token=${encodeURIComponent(token)}`; // OSS mode: Use same host:port that served the page
};

const useWebSocketProviderState = (): WebSocketContextType => {
  const wsRef = useRef<WebSocket | null>(null);
  const unmountedRef = useRef(false); // Track if component is unmounted
  const hasConnectedRef = useRef(false); // Track if we've ever connected (to detect reconnects)
  /**
   * Listener registry for the subscribe API. A ref (not state) because the
   * set must be readable synchronously inside `onmessage` and never trigger
   * re-renders of the provider tree.
   */
  const listenersRef = useRef(new Set<ServerEventListener>());
  const [isConnected, setIsConnected] = useState(false);
  const [socket, setSocket] = useState<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  /**
   * Monotonic id for the current connection "generation". Bumped on every
   * effect run and cleanup (token change / unmount), so async socket callbacks
   * (onopen/onclose) from a superseded run can detect they are stale and bail —
   * this is what prevents the token-refresh reconnect race from opening a
   * second socket or nulling the live `wsRef`.
   */
  const generationRef = useRef(0);
  /**
   * App-level heartbeat. A loopback socket left half-open after the Mac
   * slept, or a local server that died without a FIN, never fires `onclose`,
   * so the UI sat "connected" while no live event could ever arrive — the
   * long-running Claude Code session then looked like it stopped loading.
   * Ping when idle; if the pong misses its deadline, close the socket so the
   * normal reconnect path (and its history refresh) takes over.
   */
  const heartbeatTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pongDeadlineRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastFrameAtRef = useRef(0);
  const { token } = useAuth();

  const stopHeartbeat = useCallback(() => {
    if (heartbeatTimerRef.current) {
      clearInterval(heartbeatTimerRef.current);
      heartbeatTimerRef.current = null;
    }
    if (pongDeadlineRef.current) {
      clearTimeout(pongDeadlineRef.current);
      pongDeadlineRef.current = null;
    }
  }, []);

  /** Ping the socket if nothing arrived recently; close it if the pong is late. */
  const probeConnection = useCallback((websocket: WebSocket) => {
    if (websocket.readyState !== WebSocket.OPEN || pongDeadlineRef.current) return;
    if (Date.now() - lastFrameAtRef.current < HEARTBEAT_IDLE_MS) return;
    try {
      websocket.send(JSON.stringify({ type: 'ping' }));
    } catch {
      websocket.close();
      return;
    }
    pongDeadlineRef.current = setTimeout(() => {
      pongDeadlineRef.current = null;
      if (wsRef.current === websocket) websocket.close();
    }, HEARTBEAT_TIMEOUT_MS);
  }, []);

  const dispatch = useCallback((event: ServerEvent) => {
    // Synchronous fan-out to subscribers only. Intentionally holds NO React
    // state: a per-frame setState here would re-render every `useWebSocket`
    // consumer on every streamed delta. High-frequency consumers use
    // `subscribe`; there is no `latestMessage` slot to keep in sync.
    for (const listener of listenersRef.current) {
      try {
        listener(event);
      } catch (error) {
        console.error('WebSocket listener error:', error);
      }
    }
  }, []);

  const connect = useCallback((generation: number) => {
    if (unmountedRef.current) return; // Prevent connection if unmounted
    if (generation !== generationRef.current) return; // Superseded by a newer run
    try {
      // Construct WebSocket URL
      const wsUrl = buildWebSocketUrl(token);

      if (!wsUrl) return console.warn('No authentication token found for WebSocket connection');

      const websocket = new WebSocket(wsUrl);

      websocket.onopen = () => {
        if (generation !== generationRef.current) {
          // A newer effect run superseded us between connect() and open.
          // Close this orphan so it never becomes a second live socket.
          websocket.close();
          return;
        }
        setIsConnected(true);
        wsRef.current = websocket;
        setSocket(websocket);
        lastFrameAtRef.current = Date.now();
        stopHeartbeat();
        heartbeatTimerRef.current = setInterval(() => probeConnection(websocket), HEARTBEAT_IDLE_MS);
        if (hasConnectedRef.current) {
          // This is a reconnect — signal so components can catch up on missed messages
          dispatch({ kind: 'websocket_reconnected', timestamp: Date.now() });
        }
        hasConnectedRef.current = true;
      };

      websocket.onmessage = (event) => {
        lastFrameAtRef.current = Date.now();
        if (pongDeadlineRef.current) {
          clearTimeout(pongDeadlineRef.current);
          pongDeadlineRef.current = null;
        }
        try {
          const data = JSON.parse(event.data) as ServerEvent;
          // Heartbeat replies are transport-level; listeners never see them.
          if ((data as { kind?: string }).kind === 'pong') return;
          dispatch(data);
        } catch (error) {
          console.error('Error parsing WebSocket message:', error);
        }
      };

      websocket.onclose = () => {
        // Ignore closes from a superseded run: they must not touch shared state
        // (isConnected/wsRef) or schedule reconnects for the new generation.
        if (generation !== generationRef.current) return;
        // Only the socket currently referenced drives reconnection. If a newer
        // socket of the same generation already took over, leave it untouched.
        if (wsRef.current && wsRef.current !== websocket) return;

        stopHeartbeat();
        setIsConnected(false);
        wsRef.current = null;
        setSocket(null);

        // Attempt to reconnect after 3 seconds
        reconnectTimeoutRef.current = setTimeout(() => {
          if (unmountedRef.current) return; // Prevent reconnection if unmounted
          if (generation !== generationRef.current) return; // Superseded meanwhile
          connect(generation);
        }, 3000);
      };

      websocket.onerror = (error) => {
        console.error('WebSocket error:', error);
      };

    } catch (error) {
      console.error('Error creating WebSocket connection:', error);
    }
  }, [token, dispatch, probeConnection, stopHeartbeat]); // everytime token changes, we reconnect

  // Waking from sleep, regaining network or refocusing the window are the
  // moments a half-open socket is most likely — probe right away instead of
  // waiting for the next idle tick.
  useEffect(() => {
    const onWake = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      const websocket = wsRef.current;
      if (websocket) probeConnection(websocket);
    };
    document.addEventListener('visibilitychange', onWake);
    window.addEventListener('online', onWake);
    window.addEventListener('focus', onWake);
    return () => {
      document.removeEventListener('visibilitychange', onWake);
      window.removeEventListener('online', onWake);
      window.removeEventListener('focus', onWake);
    };
  }, [probeConnection]);


  useEffect(() => {
    // The cleanup below sets unmountedRef = true. Without this reset, every
    // re-run of the effect (e.g. on token refresh) would short-circuit connect()
    // at its unmounted guard and leave the socket permanently disconnected.
    unmountedRef.current = false;
    // New generation for this effect run. Any socket/timer from the previous
    // run now carries a stale generation and will self-cancel.
    const generation = ++generationRef.current;
    connect(generation);

    return () => {
      unmountedRef.current = true;
      // Invalidate this run's generation so an old socket's late onclose can't
      // schedule a reconnect or clobber a socket created by the next run.
      generationRef.current += 1;
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
      stopHeartbeat();
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
        setSocket(null);
      }
    };
  }, [connect, token, stopHeartbeat]); // every time token changes, reconnect
  const sendMessage = useCallback((message: unknown) => {
    const socket = wsRef.current;
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
    } else {
      console.warn('WebSocket not connected');
    }
  }, []);

  const subscribe = useCallback((listener: ServerEventListener) => {
    listenersRef.current.add(listener);
    return () => {
      listenersRef.current.delete(listener);
    };
  }, []);

  const value: WebSocketContextType = useMemo(() =>
  ({
    ws: socket,
    sendMessage,
    subscribe,
    isConnected
  }), [sendMessage, subscribe, isConnected, socket]);

  return value;
};

export const WebSocketProvider = ({ children }: { children: React.ReactNode }) => {
  const webSocketData = useWebSocketProviderState();

  return (
    <WebSocketContext.Provider value={webSocketData}>
      {children}
    </WebSocketContext.Provider>
  );
};

export default WebSocketContext;
