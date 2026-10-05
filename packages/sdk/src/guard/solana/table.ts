// The shape of the table generated from idl/basket.json (generated/basket-program.ts). It is the IDL's
// own description of each instruction, with nothing the guard does not read.

/** A type as the IDL writes it, with `defined` flattened to the type's name. */
export type IdlType =
  | 'bool'
  | 'u8'
  | 'u16'
  | 'u32'
  | 'u64'
  | 'i64'
  | 'pubkey'
  | 'bytes'
  | { vec: IdlType }
  | { array: readonly [IdlType, number] }
  | { option: IdlType }
  | { defined: string };

export type IdlField = { readonly name: string; readonly type: IdlType };

export type IdlAccount = {
  readonly name: string;
  readonly signer: boolean;
  readonly writable: boolean;
  /** An optional account is passed as the program's own id when it is left out. */
  readonly optional: boolean;
};

export type IdlInstruction = {
  /** The first eight bytes of the instruction's data. */
  readonly discriminator: readonly number[];
  readonly accounts: readonly IdlAccount[];
  readonly args: readonly IdlField[];
};

export type ProgramTable = {
  readonly address: string;
  readonly instructions: Readonly<Record<string, IdlInstruction>>;
  /** The structs the arguments are made of, by name. */
  readonly types: Readonly<Record<string, readonly IdlField[]>>;
};
