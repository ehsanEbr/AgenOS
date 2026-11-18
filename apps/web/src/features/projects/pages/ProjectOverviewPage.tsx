import { Descriptions, Tag, Typography } from 'antd';
import { useTranslation } from 'react-i18next';
import { useOutletContext } from 'react-router';
import { formatDate } from '../format';
import type { ProjectOutletContext } from './ProjectLayout';

/** The first tab of a project: its fields, read-only. Editing, archiving and restoring arrive with the write side of the projects UI. */
export function ProjectOverviewPage() {
  const { t, i18n } = useTranslation('projects');
  const project = useOutletContext<ProjectOutletContext>();

  const items = [
    { key: 'slug', label: t('details.fields.slug'), children: project.slug },
    {
      key: 'status',
      label: t('details.fields.status'),
      children: (
        <Tag color={project.status === 'archived' ? undefined : 'green'}>{t(`status.${project.status}`)}</Tag>
      ),
    },
    {
      key: 'description',
      label: t('details.fields.description'),
      children: project.description ?? (
        <Typography.Text type="secondary">{t('details.fields.noDescription')}</Typography.Text>
      ),
    },
    {
      key: 'access',
      label: t('details.fields.yourAccess'),
      children: project.projectRole ? t(`roles.${project.projectRole}`) : t('roles.viaOrganization'),
    },
    {
      key: 'created',
      label: t('details.fields.created'),
      children: formatDate(project.createdAt, i18n.language),
    },
    {
      key: 'updated',
      label: t('details.fields.updated'),
      children: formatDate(project.updatedAt, i18n.language),
    },
    ...(project.archivedAt
      ? [
          {
            key: 'archived',
            label: t('details.fields.archived'),
            children: formatDate(project.archivedAt, i18n.language),
          },
        ]
      : []),
  ];

  return <Descriptions bordered column={1} items={items} />;
}
