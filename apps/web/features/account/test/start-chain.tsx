import { useAccount } from '../AccountProvider';
import { SWITCHABLE } from '../chain-choice';

// For the tests: the chain the account gives the screens (where a new plan starts), and a way to
// choose another as /goal's chain choice does, from outside the screen under test. There is no such
// control in the product any more: the bar's chain switcher is gone (gate CHAIN-AT-THE-PLAN).

export function StartChain() {
  const { chain, choose } = useAccount();
  return (
    <div data-ui="start-chain" data-chain={chain ?? undefined}>
      {SWITCHABLE.map((id) => (
        <button
          key={id}
          type="button"
          data-start={id}
          onClick={() => {
            void choose(id).catch(() => {});
          }}
        >
          {id}
        </button>
      ))}
    </div>
  );
}
