import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  readonly children: ReactNode;
}

interface State {
  readonly error: Error | null;
}

/**
 * Last-resort fallback so a render error doesn't black-screen the
 * page. Any throw inside the tree is caught and displayed with the
 * stack — useful for browser-side issues vite doesn't surface in
 * the dev log.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[error-boundary]", error, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="fixed inset-0 z-50 overflow-auto bg-ink-950 p-8">
          <div className="mx-auto max-w-3xl rounded border border-signal-red/60 bg-ink-900 p-6">
            <h1 className="mb-3 font-display text-xl text-signal-red">
              boot error
            </h1>
            <pre className="whitespace-pre-wrap break-words font-mono text-xs text-chalk-200">
              {this.state.error.message}
              {"\n\n"}
              {this.state.error.stack}
            </pre>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
