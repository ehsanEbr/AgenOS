import { Alert, Spin } from 'antd';
import { ApiClientError } from '../api/client';

export function PageLoading({ label = 'Loading' }: { label?: string }) {
  return (
    <div style={{ display: 'grid', placeItems: 'center', padding: 48 }}>
      <Spin tip={label} size="large">
        <div style={{ padding: 32 }} />
      </Spin>
    </div>
  );
}

export function ErrorAlert({ error, title = 'Request failed' }: { error: unknown; title?: string }) {
  const description =
    error instanceof ApiClientError
      ? `${error.message}${error.correlationId ? ` (ref: ${error.correlationId})` : ''}`
      : 'An unexpected error occurred';
  return <Alert type="error" showIcon message={title} description={description} />;
}
