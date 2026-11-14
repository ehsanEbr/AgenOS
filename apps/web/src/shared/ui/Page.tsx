import { Flex, Typography, theme } from 'antd';
import { type ReactNode, useId } from 'react';

interface PageProps {
  /** The page's single `<h1>`. Also name the route's `handle.titleKey` so the document title matches. */
  title: ReactNode;
  description?: ReactNode;
  /** Page-level actions, rendered at the inline-end of the header (right in LTR, left in RTL). */
  extra?: ReactNode;
  children?: ReactNode;
}

/**
 * The frame every page uses: one `<h1>`, an optional description and actions, then the content. It gives all pages the
 * same heading size, spacing and landmark labelling so features do not each reinvent a page header.
 */
export function Page({ title, description, extra, children }: PageProps) {
  const headingId = useId();
  const { token } = theme.useToken();

  return (
    <Flex component="section" aria-labelledby={headingId} vertical gap="large">
      <Flex justify="space-between" align="flex-start" gap="middle" wrap>
        <Flex vertical gap="small">
          <Typography.Title level={1} id={headingId} style={{ margin: 0, fontSize: token.fontSizeHeading2 }}>
            {title}
          </Typography.Title>
          {description ? (
            <Typography.Paragraph type="secondary" style={{ margin: 0 }}>
              {description}
            </Typography.Paragraph>
          ) : null}
        </Flex>
        {extra}
      </Flex>
      {children}
    </Flex>
  );
}
