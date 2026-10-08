'use client';
import { useT } from '../../i18n/I18nProvider';
import { displayName } from '../order/plain';
import type { MixFailure } from './mix-api';

/** The sentence a mix call's failure is said with; a 422 names each line the server refused. */
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
        return [f.invalid, ...new Set(issues)].join(' ');
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
      case 'unreachable':
        return f.unreachable;
      case 'said':
        return f.said(failure.error);
    }
  };
}
