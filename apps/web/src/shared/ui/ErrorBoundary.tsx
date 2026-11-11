import { Button, Result } from 'antd';
import { Component, type ErrorInfo, type ReactNode } from 'react';

interface State {
  error: Error | null;
}

/** Last line of defence: a render error shows a recoverable message instead of a blank page. */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Unhandled UI error', error, info.componentStack);
  }

  override render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <Result
        status="error"
        title="Something went wrong"
        subTitle="The page hit an unexpected error."
        extra={<Button onClick={() => this.setState({ error: null })}>Try again</Button>}
      />
    );
  }
}
