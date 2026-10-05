'use client';
import { useEffect, useState } from 'react';
import { API } from '../../lib/api';
import type { WalletChains } from './chains';
import { type ApiCheck, checkApi } from './config-check';

/** A sleeping API takes about a minute to wake, so an unreachable one is asked again. */
const RETRY_MS = 5_000;

/**
 * Null while the first answer is on its way. The wallet provider is mounted only once this is `ok`:
 * nobody signs in, and nothing is signed, while the browser and the API may be on different networks.
 */
export function useApiCheck(chains: WalletChains | null): ApiCheck | null {
  const [check, setCheck] = useState<ApiCheck | null>(null);
  useEffect(() => {
    if (!chains) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ask = async () => {
      const answer = await checkApi(chains, API);
      if (!live) return;
      setCheck(answer);
      if (!answer.ok && answer.again) timer = setTimeout(ask, RETRY_MS);
    };
    void ask();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [chains]);
  return check;
}
