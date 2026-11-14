import { Component, type ErrorInfo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ErrorState } from './states';

function Fallback({ onReset }: { onReset: () => void }) {
  const { t } = useTranslation('common');
  return <ErrorState description={t('boundary.description')} onRetry={onReset} />;
}

interface Props {
  children: ReactNode;
}
interface State {
  failed: boolean;
}

/**
 * Last line of defence for errors thrown while rendering outside the router (providers, the shell itself). Errors inside
 * routes are handled by the route `errorElement`s instead, which keep the navigation visible.
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Unhandled UI error', error, info.componentStack);
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return <Fallback onReset={() => this.setState({ failed: false })} />;
  }
}
