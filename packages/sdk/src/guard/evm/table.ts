// The shape of the table generated from the EVM interface files (generated/evm-interface.ts): for each
// interface, every function's canonical signature and its four-byte selector.

/** `0x` and eight hex digits, lower-case. */
export type Selector = string;

/** A function's canonical signature, structs written out as tuples: `setTargets((address,uint16)[])`. */
export type Signature = string;

export type InterfaceTable = Readonly<Record<string, Readonly<Record<Signature, Selector>>>>;
