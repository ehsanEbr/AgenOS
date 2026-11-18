import { Card, Flex, Typography } from 'antd';
import type { ReactNode } from 'react';

interface AuthCardProps {
  /** The page's single `<h1>`. */
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
}

/** The frame of the public authentication pages: a centered card, full width on a phone, with one `<h1>`. */
export function AuthCard({ title, description, children }: AuthCardProps) {
  return (
    <Card style={{ inlineSize: '100%', maxInlineSize: 420 }}>
      <Flex vertical gap="middle">
        <div>
          <Typography.Title level={1} style={{ marginBlock: 0, fontSize: 24 }}>
            {title}
          </Typography.Title>
          {description ? <Typography.Paragraph type="secondary">{description}</Typography.Paragraph> : null}
        </div>
        {children}
      </Flex>
    </Card>
  );
}
