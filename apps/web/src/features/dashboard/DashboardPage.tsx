import { Alert, Button, Card, Descriptions, Form, Input, Space, Tag, Typography } from 'antd';
import { useState } from 'react';
import { ErrorAlert, PageLoading } from '../../shared/ui/PageStates';
import { useCreateSystemJob, useReadiness, useSystemJob } from './useDashboard';

const STATUS_COLOR = {
  QUEUED: 'default',
  RUNNING: 'processing',
  COMPLETED: 'success',
  FAILED: 'error',
} as const;

function SystemStatus() {
  const { data, error, isPending } = useReadiness();

  return (
    <Card title="System status">
      {isPending ? (
        <PageLoading label="Checking services" />
      ) : error ? (
        <ErrorAlert error={error} title="Cannot reach the API" />
      ) : (
        <Space direction="vertical" style={{ width: '100%' }}>
          <Alert
            type={data.status === 'ok' ? 'success' : 'warning'}
            showIcon
            message={data.status === 'ok' ? 'All systems operational' : 'Some services are unavailable'}
          />
          <Descriptions column={1} size="small" bordered>
            {Object.entries(data.checks).map(([name, check]) => (
              <Descriptions.Item key={name} label={name}>
                <Tag color={check.status === 'up' ? 'success' : 'error'}>{check.status}</Tag>
                {check.latencyMs !== undefined && (
                  <Typography.Text type="secondary">{check.latencyMs} ms</Typography.Text>
                )}
                {check.error && <Typography.Text type="danger">{check.error}</Typography.Text>}
              </Descriptions.Item>
            ))}
          </Descriptions>
        </Space>
      )}
    </Card>
  );
}

function BackgroundJobTest() {
  const [jobId, setJobId] = useState<string>();
  const create = useCreateSystemJob();
  const job = useSystemJob(jobId);

  return (
    <Card title="Background job test">
      <Typography.Paragraph type="secondary">
        Submits a job through the API and BullMQ; the worker processes it and stores the result in PostgreSQL.
      </Typography.Paragraph>
      <Form
        layout="inline"
        initialValues={{ message: 'hello' }}
        onFinish={({ message }: { message: string }) =>
          create.mutate({ message }, { onSuccess: (created) => setJobId(created.id) })
        }
      >
        <Form.Item name="message" rules={[{ required: true, whitespace: true, max: 200 }]}>
          <Input placeholder="Message" aria-label="Message" />
        </Form.Item>
        <Form.Item>
          <Button type="primary" htmlType="submit" loading={create.isPending}>
            Submit job
          </Button>
        </Form.Item>
      </Form>

      {create.error && <ErrorAlert error={create.error} title="Could not submit job" />}

      {job.data && (
        <Descriptions column={1} size="small" bordered style={{ marginTop: 16 }}>
          <Descriptions.Item label="Job">{job.data.id}</Descriptions.Item>
          <Descriptions.Item label="Status">
            <Tag color={STATUS_COLOR[job.data.status]}>{job.data.status}</Tag>
          </Descriptions.Item>
          {job.data.output && <Descriptions.Item label="Result">{job.data.output}</Descriptions.Item>}
          {job.data.error && <Descriptions.Item label="Error">{job.data.error}</Descriptions.Item>}
          <Descriptions.Item label="Attempts">{job.data.attempts}</Descriptions.Item>
        </Descriptions>
      )}
      {job.error && <ErrorAlert error={job.error} title="Could not load job" />}
    </Card>
  );
}

export function DashboardPage() {
  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Typography.Title level={3} style={{ margin: 0 }}>
        Overview
      </Typography.Title>
      <SystemStatus />
      <BackgroundJobTest />
    </Space>
  );
}
