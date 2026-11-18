import type { OrganizationWithRole } from '@agentos/contracts';
import { Button, Card, Flex, List, Tag, Typography } from 'antd';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

interface OrganizationChooserProps {
  /** The organizations loaded so far, in the API's order. */
  organizations: readonly OrganizationWithRole[];
  /** The server's total, so the page can say honestly how many are shown. */
  total: number;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  /** Where choosing an organization leads. The caller supplies it: this feature does not know the project routes. */
  pathFor: (organizationId: string) => string;
}

/**
 * The organization chooser (ADR-0012 D2): shown when there is no valid last-used organization. Every row is a real link to the
 * organization's page, so it can be opened in a new tab. The list is paged with the API's `limit`/`offset` ("load more"), and the
 * text says how many of the total are shown instead of implying the list is complete.
 */
export function OrganizationChooser({
  organizations,
  total,
  hasMore,
  loadingMore,
  onLoadMore,
  pathFor,
}: OrganizationChooserProps) {
  const { t } = useTranslation('organizations');

  return (
    <Card style={{ inlineSize: '100%', maxInlineSize: 560 }}>
      <Flex vertical gap="middle">
        <div>
          <Typography.Title level={1} style={{ marginBlock: 0, fontSize: 24 }}>
            {t('chooser.title')}
          </Typography.Title>
          <Typography.Paragraph type="secondary">{t('chooser.description')}</Typography.Paragraph>
        </div>
        <List
          bordered
          dataSource={[...organizations]}
          renderItem={(organization) => (
            <List.Item>
              <Flex justify="space-between" align="center" gap="small" wrap style={{ inlineSize: '100%' }}>
                <Link to={pathFor(organization.id)}>{organization.name}</Link>
                <Tag>{t(`roles.${organization.role}`)}</Tag>
              </Flex>
            </List.Item>
          )}
        />
        <Flex vertical gap="small" align="start">
          <Typography.Text type="secondary" role="status">
            {t('chooser.showing', { loaded: organizations.length, total })}
          </Typography.Text>
          {hasMore ? (
            <Button onClick={onLoadMore} loading={loadingMore}>
              {t('chooser.loadMore')}
            </Button>
          ) : null}
        </Flex>
      </Flex>
    </Card>
  );
}
