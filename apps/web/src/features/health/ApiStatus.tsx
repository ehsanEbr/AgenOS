import { Tag } from 'antd';
import { useApiHealth } from './useHealth';

/** Shows whether the web app can reach the API; proves the client + shared contract wiring. */
export function ApiStatus() {
  const { data, isPending, isError } = useApiHealth();

  if (isPending) return <Tag>API: checking</Tag>;
  if (isError) return <Tag color="error">API: unreachable</Tag>;
  return <Tag color="success">API: {data.status}</Tag>;
}
