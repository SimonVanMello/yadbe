import { Collapsible } from 'radix-ui';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { flushSync } from 'react-dom';

import styles from './Disclosure.module.css';
import { Icon, type IconName } from './Icon';
import { REVEAL_FIELD_EVENT } from './reveal';

interface DisclosureProps {
  title: ReactNode;
  icon?: IconName;
  /** What the section holds, in its header: read without opening it. */
  summary?: ReactNode;
  /** The summary as plain text: the tooltip of a summary cut short by a narrow window. */
  summaryText?: string;
  /** The section holds something other than the defaults: its header is marked. */
  modified?: boolean;
  /** Tooltip of the mark; the summary says the same to a screen reader. */
  modifiedLabel?: string;
  defaultOpen?: boolean;
  /** Opens the section when it turns true (a field inside needs fixing); it then stays open. */
  forceOpen?: boolean;
  /** The `data-field` names inside: `focusField(name)` opens the section to reach one. */
  fields?: readonly string[];
  children: ReactNode;
  'data-testid'?: string;
}

/**
 * A titled section that opens and closes (progressive disclosure), closed by default. Its
 * header stays one line: the summary is cut with an ellipsis, never pushed out of the box.
 */
export function Disclosure({
  title,
  icon,
  summary,
  summaryText,
  modified = false,
  modifiedLabel,
  defaultOpen = false,
  forceOpen = false,
  fields,
  children,
  'data-testid': testId,
}: DisclosureProps) {
  const id = useId();
  const [open, setOpen] = useState(defaultOpen || forceOpen);
  const [forced, setForced] = useState(forceOpen);
  if (forced !== forceOpen) {
    setForced(forceOpen);
    if (forceOpen) setOpen(true);
  }

  const fieldsRef = useRef(fields);
  useEffect(() => {
    fieldsRef.current = fields;
  });
  useEffect(() => {
    const onReveal = (event: Event) => {
      const name = (event as CustomEvent<string>).detail;
      // Synchronous, so that the caller finds the field rendered right after.
      if (fieldsRef.current?.includes(name)) {
        flushSync(() => {
          setOpen(true);
        });
      }
    };
    document.addEventListener(REVEAL_FIELD_EVENT, onReveal);
    return () => {
      document.removeEventListener(REVEAL_FIELD_EVENT, onReveal);
    };
  }, []);

  return (
    <Collapsible.Root
      open={open}
      onOpenChange={setOpen}
      className={styles.section}
      data-testid={testId}
      aria-labelledby={`${id}-title`}
      role="group"
    >
      <Collapsible.Trigger className={styles.header}>
        <Icon name={open ? 'chevronDown' : 'chevronRight'} />
        {icon && <Icon name={icon} className={styles.icon} />}
        <span className={styles.title} id={`${id}-title`}>
          {title}
        </span>
        {modified && <span className={styles.mark} title={modifiedLabel} aria-hidden />}
        {summary !== undefined && (
          <span
            className={styles.summary}
            data-modified={modified || undefined}
            title={summaryText}
          >
            {summary}
          </span>
        )}
      </Collapsible.Trigger>
      <Collapsible.Content className={styles.body}>{children}</Collapsible.Content>
    </Collapsible.Root>
  );
}
