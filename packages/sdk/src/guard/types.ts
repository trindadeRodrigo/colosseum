import type {
  Address,
  AssetId,
  BasketTx,
  ChainId,
  ConsentKind,
  RawAmount,
  Target,
} from '@colosseum/schemas';

// What the guard is given. None of it comes from the transaction it checks, and none of it should come
// from the server that built that transaction: the step is what the person saw on the review screen,
// and the deployment is read from a file committed in this package (deployment.ts).

/** One trade as the person approved it: what goes in, and the least that must come out. */
export type ApprovedTrade = {
  sell: AssetId;
  buy: AssetId;
  inRaw: RawAmount;
  minOutRaw: RawAmount;
};

/** The shared portfolio a vault follows, at the version the person reviewed. */
export type Follow = {
  /** Solana: the recipe account. EVM: the 32-byte id as 0x hex. */
  recipeOnchainId: string;
  version: number;
};

/** One token leaving the vault for the owner's wallet. `amountRaw` null means whatever the vault holds. */
export type Withdrawal = { asset: AssetId; amountRaw: RawAmount | null };

/**
 * A token the vault is known to hold that the deployment does not list: one sent in from outside. It
 * comes from the caller's own read of the chain, never from the server that builds the withdrawal. On
 * Solana it names the token program that owns the mint.
 */
export type HeldToken = { address: Address; tokenProgram?: 'token' | 'token-2022' };

type StepBase = {
  /** The leg this step is, so a transaction built for another leg is refused. */
  legId: string;
  chain: ChainId;
  /** The person's address on that chain. Every account and every contract is derived from it. */
  owner: Address;
  /** The plan's number. The vault is the one derived from the owner and this, and no other. */
  basketId: string;
};

/**
 * A step as the person approved it. Each kind carries exactly what its transaction may do; the guard
 * refuses bytes that do anything else. `publish` and the keeper's two kinds have no entry: this guard
 * signs none of them.
 */
export type ApprovedStep = StepBase &
  (
    | { kind: 'approve'; amountRaw: RawAmount }
    | {
        kind: 'create_vault';
        /** The vault's own targets. Empty when it follows a shared portfolio. */
        targets: Target[];
        follow: Follow | null;
        autoFollow: boolean;
        /** The cash that goes in with the create. '0' for none. */
        depositRaw: RawAmount;
        trades: ApprovedTrade[];
      }
    | { kind: 'deposit'; amountRaw: RawAmount; trades: ApprovedTrade[] }
    | { kind: 'swap'; trades: ApprovedTrade[] }
    | { kind: 'set_targets'; targets: Target[] }
    | { kind: 'accept_version'; follow: Follow }
    | { kind: 'set_auto_follow'; on: boolean }
    | {
        kind: 'withdraw';
        /**
         * `all`: everything the vault holds. The bytes may then take out any token the deployment lists
         * and any token in `held`, each once, and nothing else.
         */
        withdrawals: Withdrawal[] | 'all';
        held?: HeldToken[];
      }
  );
export type ApprovedKind = ApprovedStep['kind'];

/** The most a transaction may commit the wallet to in network fees. */
export type FeeLimit = {
  /**
   * Native units. Solana: the signature fee plus the priority fee the compute-budget instructions set.
   * EVM: the fee the transaction states, which the wallet takes as its guide.
   */
  maxFeeNativeRaw: RawAmount;
  /** EVM: the most gas a transaction may state. */
  maxGas?: number;
};

export type SolanaDeployment = {
  family: 'solana';
  chain: 'solana';
  /** The label a transaction for this network carries: `live` on mainnet, `sandbox` anywhere else. */
  provenance: 'live' | 'sandbox';
  /** `Config.router_program`: the only program a vault swaps through. */
  router: Address;
  cash: AssetId;
  /** Every asset a step may name, with its mint and the token program that owns the mint. */
  assets: Record<AssetId, { mint: Address; tokenProgram: 'token' | 'token-2022' }>;
  fee?: FeeLimit;
};

export type EvmDeployment = {
  family: 'evm';
  chain: Exclude<ChainId, 'solana'>;
  provenance: 'live' | 'sandbox';
  /** The network's own number: 4663, 46630, 8453, 84532. */
  evmChainId: number;
  factory: Address;
  /** What a vault's address is derived from, with the factory, the owner and the plan's number. */
  beacon: Address;
  /**
   * The creation code of the vault proxy, as the factory holds it: 0x hex. Left out, the code of the
   * committed build (generated/vault-proxy.ts).
   */
  proxyCreationCode?: string;
  /** The exchanges a vault may trade through. */
  routers: Address[];
  cash: AssetId;
  assets: Record<AssetId, { token: Address }>;
  fee?: FeeLimit;
};

/** A chain that runs on packages/chain-mock. Its transactions are the mock's own, and move nothing. */
export type MockDeployment = { family: 'mock'; chain: ChainId; cash: AssetId };

/**
 * The mark of a deployment that `loadDeployments` read from a deployment file. The class is never
 * constructed and has no value: it is here so that no object written by hand has the type, and neither
 * has a copy of a loaded deployment with a field changed. The guard checks the same thing when it runs.
 */
declare class FromDeploymentFile {
  protected readonly fromDeploymentFile: true;
}
export type Loaded<T> = T & FromDeploymentFile;

/** A deployment as the guard takes it: one of the three, and only as `loadDeployments` returned it. */
export type GuardDeployment = Loaded<SolanaDeployment | EvmDeployment | MockDeployment>;
export type GuardDeployments = Readonly<Partial<Record<ChainId, GuardDeployment>>>;

export type GuardInput = {
  step: ApprovedStep;
  tx: BasketTx;
  deployment: GuardDeployment;
  /** What the person agreed to on the review screen, for this order. */
  consents?: readonly ConsentKind[];
};

/** What the plan says beyond the order's legs. The order type does not carry it yet (see approved.ts). */
export type PlanTerms = {
  basketId: string;
  /** A vault's own targets: for a create that follows nothing, and for a `set_targets` step. */
  targets?: Target[];
  /** For a create that follows a shared portfolio, and for an `accept_version` step. */
  follow?: Follow;
  /** For a create (left out: off), and what a `set_auto_follow` step sets. */
  autoFollow?: boolean;
  /** For a `withdraw` step. Left out: everything the vault holds. */
  withdrawals?: Withdrawal[];
  /** For a `withdraw` of everything: what the vault holds beyond the deployment's list, by the caller's own read. */
  held?: HeldToken[];
};
