import type { ReactNode } from 'react';

import { useT } from '../../i18n/useT';
import { Disclosure } from '../../ui/Disclosure';
import styles from './ConnectionForm.module.css';
import {
  ADVANCED_FIELDS,
  TLS_FIELDS,
  advancedSummary,
  hasTlsSection,
  tlsSummary,
} from './connectionSections';
import type { ConnectionDraft, EngineInfo } from './model';

/** What the connection form puts around the fields of every engine family. */
export interface FormFrame {
  /** Name and group: visible at once, under the family's essentials. */
  identity: ReactNode;
  /** The environment section, first of the closed sections. */
  environment: ReactNode;
  /** The timeout fields, at the end of the advanced section. */
  timeouts: ReactNode;
}

interface FamilyLayoutProps {
  frame: FormFrame;
  draft: ConnectionDraft;
  info: EngineInfo;
  /** What connecting needs in the common case: address, database, login. */
  essentials: ReactNode;
  /** The fields of the TLS section, when the connection has one (`hasTlsSection`). */
  tls?: ReactNode;
  /** The SSH tunnel section, already a section of its own. */
  ssh?: ReactNode;
  /** The family's own options, before the timeouts in the advanced section. */
  advanced?: ReactNode;
}

/**
 * The layout every engine family shares (progressive disclosure): the essentials and the name
 * open, then the sections closed by default, each with a summary of what it holds.
 */
export function FamilyLayout({
  frame,
  draft,
  info,
  essentials,
  tls,
  ssh,
  advanced,
}: FamilyLayoutProps) {
  const t = useT();
  const tlsShown = tls !== undefined && hasTlsSection(draft, info);
  const tlsState = tlsShown ? tlsSummary(draft, info, t) : null;
  const advancedState = advancedSummary(draft, info, t);
  return (
    <>
      {essentials}
      {frame.identity}
      <div className={styles.sections}>
        {frame.environment}
        {tlsState && (
          <Disclosure
            title={t('connection.section.tls')}
            icon="lock"
            summary={tlsState.text}
            summaryText={tlsState.text}
            modified={tlsState.modified}
            modifiedLabel={t('connection.section.modified')}
            fields={TLS_FIELDS}
            data-testid="tls-section"
          >
            {tls}
          </Disclosure>
        )}
        {ssh}
        <Disclosure
          title={t('connection.section.advanced')}
          icon="settings"
          summary={advancedState.text}
          summaryText={advancedState.text}
          modified={advancedState.modified}
          modifiedLabel={t('connection.section.modified')}
          fields={ADVANCED_FIELDS}
          data-testid="advanced-section"
        >
          {advanced}
          {frame.timeouts}
        </Disclosure>
      </div>
    </>
  );
}
