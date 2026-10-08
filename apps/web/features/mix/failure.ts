'use client';
import { useT } from '../../i18n/I18nProvider';
import { displayName } from '../order/plain';
import type { MixFailure } from './mix-api';

/** What a mix call's failure is said with; a 422 says each thing the server refused on a line of its own. */
export function useFailureText(): (failure: MixFailure) => string {
  const t = useT();
  const f = t.mix.failure;
  return (failure) => {
    switch (failure.kind) {
      case 'invalid': {
        const issues = failure.issues.map((issue) => {
          const [code = '', ...rest] = issue.split(':');
          const asset = rest.length ? displayName(rest.join(':'), t.plan) : '';
          return t.mix.issue(code, asset);
        });
        return [f.invalid, ...new Set(issues)].join('\n');
      }
      case 'signed-out':
        return f.signedOut;
      case 'no-wallet':
        return f.noWallet;
      case 'not-yours':
        return f.notYours;
      case 'read-only':
        return f.readOnly;
      case 'busy':
        return f.busy;
      case 'unreadable':
        return f.unreadable;
      case 'unchecked':
        return f.unchecked;
      case 'unreachable':
        return f.unreachable;
      case 'said':
        return f.said(failure.error);
    }
  };
}
