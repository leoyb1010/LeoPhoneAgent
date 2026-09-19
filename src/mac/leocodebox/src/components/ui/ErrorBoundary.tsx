import { Component, type ErrorInfo, type ReactNode } from 'react';

type Props = { children: ReactNode };
type State = { error: Error | null };

/** 顶层兜底:渲染树炸了也给一句人话和"重新加载",而不是白屏。 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[leocodebox] render crashed', error, info.componentStack);
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div style={{ padding: 32, fontFamily: '-apple-system, "PingFang SC", sans-serif', color: '#e8eaeb', background: '#151617', minHeight: '100vh' }}>
        <h1 style={{ fontSize: 17, fontWeight: 600, marginBottom: 8 }}>界面崩了</h1>
        <p style={{ color: '#a2a8ad', marginBottom: 16 }}>{this.state.error.message}</p>
        <button type="button" onClick={() => window.location.reload()} style={{ padding: '6px 14px', borderRadius: 8, background: '#e8eaeb', color: '#151617', border: 0, cursor: 'pointer' }}>重新加载</button>
      </div>
    );
  }
}
