import { Component, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  /** Optional reset key: when it changes, the boundary clears its error. */
  resetKey?: unknown;
}

interface State {
  error: Error | null;
}

/**
 * Catches render/effect errors so one bad file (e.g. a preview plugin throwing
 * on some markdown) shows an inline message instead of unmounting the whole
 * app into a white screen.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidUpdate(prev: Props) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
        <p className="text-sm font-medium" style={{ color: "var(--text)" }}>
          这个文件无法渲染
        </p>
        <pre
          className="max-h-48 max-w-full overflow-auto rounded-lg p-3 text-left text-xs"
          style={{ background: "var(--bg-elev)", border: "1px solid var(--border)", color: "var(--text-muted)" }}
        >
          {error.message}
        </pre>
      </div>
    );
  }
}
