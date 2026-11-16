import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { Disclosure } from './Disclosure';
import { focusField } from './reveal';

describe('Disclosure', () => {
  it('starts closed with its summary in the header, and opens on click', async () => {
    render(
      <Disclosure title="SSH tunnel" summary="deploy@bastion:22" summaryText="deploy@bastion:22">
        <input aria-label="SSH host" />
      </Disclosure>,
    );
    const header = screen.getByRole('button', { name: /^SSH tunnel/ });
    expect(header).toHaveAttribute('aria-expanded', 'false');
    expect(header).toHaveTextContent('deploy@bastion:22');
    expect(screen.queryByLabelText('SSH host')).toBeNull();
    await userEvent.click(header);
    expect(header).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByLabelText('SSH host')).toBeVisible();
  });

  it('opens when a field inside needs fixing, and stays open after', () => {
    const { rerender } = render(
      <Disclosure title="Environment">
        <input aria-label="Environment name" />
      </Disclosure>,
    );
    expect(screen.queryByLabelText('Environment name')).toBeNull();
    rerender(
      <Disclosure title="Environment" forceOpen>
        <input aria-label="Environment name" />
      </Disclosure>,
    );
    expect(screen.getByLabelText('Environment name')).toBeVisible();
    rerender(
      <Disclosure title="Environment">
        <input aria-label="Environment name" />
      </Disclosure>,
    );
    expect(screen.getByLabelText('Environment name')).toBeVisible();
  });

  it('opens to let focusField reach one of its fields', () => {
    render(
      <>
        <Disclosure title="TLS" fields={['tls-cert']}>
          <input aria-label="Certificate file" data-field="tls-cert" />
        </Disclosure>
        <Disclosure title="Advanced" fields={['replicaSet']}>
          <input aria-label="Replica set" data-field="replicaSet" />
        </Disclosure>
      </>,
    );
    expect(focusField('tls-cert')).toBe(true);
    expect(screen.getByLabelText('Certificate file')).toHaveFocus();
    // Only the section that holds the field opens.
    expect(screen.queryByLabelText('Replica set')).toBeNull();
    expect(focusField('nowhere')).toBe(false);
  });
});
