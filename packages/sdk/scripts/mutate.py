# Removes the guard's and the executor's comparisons one at a time, in a copy of this package, and runs
# the tests that should notice. Each must make a test fail: a comparison no test misses is one a
# change could lose unseen. Nothing in the repository is changed.
#
#   python3 packages/sdk/scripts/mutate.py            every mutation
#   python3 packages/sdk/scripts/mutate.py reg- wire  those whose id contains a word given
#   python3 packages/sdk/scripts/mutate.py --check    only that each one still applies to the code
#
# Each entry: an id, the file, the text removed or changed (it must be there exactly once), what it
# becomes, and the test files to run. Exits 1 when one survives or no longer applies.
import json, os, re, shutil, subprocess, sys, tempfile

MUT = [
 ('sol-recipient-withdraw', 'src/guard/solana/check.ts', "rule('destination', account(owner, t), 'recipient');", "rule('destination', at('destination') ?? '', 'recipient');", ['src/guard/solana/check.test.ts']),
 ('sol-source-deposit', 'src/guard/solana/check.ts', "rule('source', account(owner, cash), 'recipient');", "rule('source', call.accounts[call.spec.accounts.findIndex((a) => a.name === 'source')] ?? '', 'recipient');", ['src/guard/solana/check.test.ts']),
 ('sol-extra-not-signer', 'src/guard/solana/check.ts', 'extra.every((i) => i >= wire.signers)', 'true', ['src/guard/solana/check.test.ts']),
 ('sol-extra-none', 'src/guard/solana/check.ts', ': extra.length === 0),', ': true),', ['src/guard/solana/check.test.ts']),
 ('sol-ata-payer', 'src/guard/solana/check.ts', '        payer === owner &&\n', '', ['src/guard/solana/check.test.ts']),
 ('sol-ata-holder', 'src/guard/solana/check.ts', '        holder === allowed?.holder &&\n', '', ['src/guard/solana/check.test.ts']),
 ('sol-ata-created', 'src/guard/solana/check.ts', '        created === expected &&\n', '', ['src/guard/solana/check.test.ts']),
 ('sol-ata-data', 'src/guard/solana/check.ts', '        ix.data[0] === 1 &&\n', '', ['src/guard/solana/check.test.ts']),
 ('sol-ata-system', 'src/guard/solana/check.ts', '        system === SYSTEM_PROGRAM &&\n', '', ['src/guard/solana/check.test.ts']),
 ('sol-ata-six', 'src/guard/solana/check.ts', '        ix.accounts.length === 6 &&\n', '', ['src/guard/solana/check.test.ts']),
 ('sol-ata-mint-allowed', 'src/guard/solana/check.ts', 'holder && mint && tokenProgram && allowed?.program === tokenProgram', 'holder && mint && tokenProgram', ['src/guard/solana/check.test.ts']),
 ('sol-one-signer', 'src/guard/solana/check.ts', 'wire.signers === 1 && wire.keys[0] === owner', 'wire.keys[0] === owner', ['src/guard/solana/check.test.ts']),
 ('sol-payer-owner', 'src/guard/solana/check.ts', 'wire.signers === 1 && wire.keys[0] === owner', 'wire.signers === 1', ['src/guard/solana/check.test.ts']),
 ('sol-budget-once', 'src/guard/solana/check.ts', 'ix.accounts.length === 0 && price === null)', 'ix.accounts.length === 0)', ['src/guard/solana/check.test.ts']),
 ('sol-budget-len', 'src/guard/solana/check.ts', 'kind === 2 && ix.data.length === 5 && ', 'kind === 2 && ', ['src/guard/solana/check.test.ts']),
 ('sol-budget-accounts', 'src/guard/solana/check.ts', 'kind === 2 && ix.data.length === 5 && ix.accounts.length === 0 && limit === null', 'kind === 2 && ix.data.length === 5 && limit === null', ['src/guard/solana/check.test.ts']),
 ('sol-fee-default-units', 'src/guard/solana/check.ts', '(limit ?? MAX_COMPUTE_UNITS)', '(limit ?? 0n)', ['src/guard/solana/check.test.ts']),
 ('sol-router', 'src/guard/solana/check.ts', "rule('router_program', deployment.router, 'router');", "rule('router_program', call.accounts[call.spec.accounts.findIndex((a) => a.name === 'router_program')] ?? '', 'router');", ['src/guard/solana/check.test.ts']),
 ('sol-all-withdraw-known', 'src/guard/solana/check.ts', 'known !== undefined && !taken.has(known.mint),', "!taken.has(known?.mint ?? ''),", ['src/guard/solana/check.test.ts']),
 ('sol-all-withdraw-once', 'src/guard/solana/check.ts', 'known !== undefined && !taken.has(known.mint),', 'known !== undefined,', ['src/guard/solana/check.test.ts']),
 ('wire-dup-keys', 'src/guard/solana/wire.ts', "if (new Set(keys).size !== keys.length) throw new Error('an account is listed twice');", '', ['src/guard/solana/check.test.ts', 'src/guard/solana/wire.test.ts']),
 ('wire-sig-slots', 'src/guard/solana/wire.ts', "if (signers !== signatures.length)\n    throw new Error('the signature slots are not the signers the message asks for');", '', ['src/guard/solana/check.test.ts', 'src/guard/solana/wire.test.ts']),
 ('wire-trailing', 'src/guard/solana/wire.ts', "if (!r.done) throw new Error('bytes are left over after the transaction');", '', ['src/guard/solana/check.test.ts', 'src/guard/solana/wire.test.ts']),
 ('wire-long-compact', 'src/guard/solana/wire.ts', "if (i > 0 && b === 0) throw new Error('a length is written the long way');", '', ['src/guard/solana/check.test.ts', 'src/guard/solana/wire.test.ts']),
 ('wire-program-static', 'src/guard/solana/wire.ts', "if (ix.program >= keys.length)\n      throw new Error('an instruction names a program that is not there');", '', ['src/guard/solana/check.test.ts', 'src/guard/solana/wire.test.ts']),
 ('wire-version', 'src/guard/solana/wire.ts', "if ((first & 0x7f) !== 0) throw new Error('a transaction version this guard does not read');", '', ['src/guard/solana/check.test.ts', 'src/guard/solana/wire.test.ts']),
 ('borsh-trailing', 'src/guard/solana/borsh.ts', "if (c.at !== data.length) throw new Error('bytes are left over after the arguments');", '', ['src/guard/solana/check.test.ts']),
 ('b64-canonical', 'src/bytes.ts', "if (btoa(raw) !== text) throw new Error('not canonical base64');", '', ['src/guard/solana/check.test.ts', 'src/bytes.test.ts']),
 ('evm-spender', 'src/guard/evm/check.ts', '      spender === vault,\n', '      true,\n', ['src/guard/evm/check.test.ts']),
 ('evm-target-vault', 'src/guard/evm/check.ts', "need('target', call.to === vault,", "need('target', true,", ['src/guard/evm/check.test.ts']),
 ('evm-target-cash', 'src/guard/evm/check.ts', '      call.to === token(deployment.cash),\n', '      true,\n', ['src/guard/evm/check.test.ts']),
 ('evm-target-factory', 'src/guard/evm/check.ts', '      call.to === deployment.factory.toLowerCase(),\n', '      true,\n', ['src/guard/evm/check.test.ts']),
 ('evm-value', 'src/guard/evm/check.ts', "need('value', call.value === '0',", "need('value', true,", ['src/guard/evm/check.test.ts']),
 ('evm-chainid', 'src/guard/evm/check.ts', '    call.chainId === deployment.evmChainId,\n', '    true,\n', ['src/guard/evm/check.test.ts']),
 ('evm-depth', 'src/guard/evm/check.ts', 'if (depth >= MAX_DEPTH)', 'if (false as boolean)', ['src/guard/evm/check.test.ts']),
 ('evm-unlimited', 'src/guard/evm/check.ts', '!isUnlimited(amount) && !isUnlimited(BigInt(step.amountRaw)),', 'true,', ['src/guard/evm/check.test.ts']),
 ('evm-router', 'src/guard/evm/check.ts', "need('router', routers.includes(router),", "need('router', true,", ['src/guard/evm/check.test.ts']),
 ('evm-gas', 'src/guard/evm/check.ts', '(call.gas === undefined || call.gas <= maxGas) && ', '', ['src/guard/evm/check.test.ts']),
 ('evm-swap-nonempty', 'src/guard/evm/check.ts', "need('calls', swaps.length > 0, 'a swap call that makes no trade');", '', ['src/guard/evm/check.test.ts']),
 ('abi-canonical', 'src/guard/evm/abi.ts', "if (!sameBytes(encodeTuple(types, values), data))\n    throw new Error('the call data is not the canonical encoding of its values');", '', ['src/guard/evm/check.test.ts', 'src/guard/evm/abi.test.ts']),
 ('abi-address-dirty', 'src/guard/evm/abi.ts', "if (v >> 160n !== 0n) throw new Error('an address has bits set above it');", '', ['src/guard/evm/check.test.ts', 'src/guard/evm/abi.test.ts']),
 ('run-freeze-clone', 'src/guard/run.ts', 'tx = deepFreeze(rebuilt(structuredClone(input.tx), familyOf(step.chain)));', 'tx = rebuilt(input.tx, familyOf(step.chain));', ['src/guard/solana/check.test.ts', 'src/guard/evm/check.test.ts', 'src/guard/mock/check.test.ts', 'src/executor/execute.test.ts']),
 ('run-feepayer', 'src/guard/run.ts', 'tx.signer === step.owner && (tx.feePayer === undefined || tx.feePayer === step.owner),', 'tx.signer === step.owner,', ['src/guard/solana/check.test.ts', 'src/guard/mock/check.test.ts']),
 ('run-deployment-chain', 'src/guard/run.ts', 'if (deployment.chain !== step.chain)', 'if (false as boolean)', ['src/guard/solana/check.test.ts', 'src/guard/evm/check.test.ts', 'src/guard/mock/check.test.ts', 'src/executor/execute.test.ts']),
 ('exec-attempt-match', 'src/executor/execute.ts', '            attempt?.legId !== legId ||\n            tx?.attemptId !== attempt.id ||\n            attempt.messageHash !== tx.messageHash', '            false as boolean', ['src/executor/execute.test.ts']),
 ('exec-owner-is-wallet', 'src/executor/execute.ts', 'if (!owner || signer.active(family)?.address !== owner)', 'if (!owner)', ['src/executor/execute.test.ts']),
 ('exec-isguarded', 'src/executor/execute.ts', "if (!isGuarded(pass)) throw new Error('only what the guard passed is signed');", '', ['src/executor/execute.test.ts']),
 ('exec-seen-id', 'src/executor/execute.ts', 'if (seen.id !== order.id)', 'if (false as boolean)', ['src/executor/execute.test.ts']),
 ('exec-cancel-on-refusal', 'src/executor/execute.ts', "          if (!isGuardRefusal(e)) throw e;\n          await cancel(legId);\n          return { status: 'refused', order: seen, legId, refusal: e };", "          if (!isGuardRefusal(e)) throw e;\n          return { status: 'refused', order: seen, legId, refusal: e };", ['src/executor/execute.test.ts']),
 ('exec-reuse-proof', 'src/executor/execute.ts', "          before?.proof &&\n          before.messageHash === pass.tx.messageHash &&\n          (await fateOf(before)) !== 'gone'\n", '          false as boolean\n', ['src/executor/execute.test.ts']),
 ('exec-sign-once', 'src/executor/execute.ts', "if (record === 'unreadable' || (record && record.times > 0)) {", 'if (false as boolean) {', ['src/executor/execute.test.ts']),
 ('exec-rebuild-bound', 'src/executor/execute.ts', 'if (builds > patience.rebuilds)', 'if (builds > 1000)', ['src/executor/execute.test.ts']),
 ('approved-leg-chain', 'src/guard/approved.ts', 'if (leg.chain !== chain)', 'if (false as boolean)', ['src/guard/approved.test.ts', 'src/executor/execute.test.ts']),
 ('approved-cash-eq-deposit', 'src/guard/approved.ts', 'about ? leg.cashRaw !== depositRaw :', 'about ? false :', ['src/guard/approved.test.ts', 'src/executor/execute.test.ts']),
 ('approved-no-deposit-no-cash', 'src/guard/approved.ts', 'if (about ?? mover ?? approvals[0])', 'if (false as boolean)', ['src/guard/approved.test.ts', 'src/executor/execute.test.ts']),
 ('approved-keeper', 'src/guard/approved.ts', "if (leg.signer !== 'owner')", 'if (false as boolean)', ['src/guard/approved.test.ts', 'src/executor/execute.test.ts']),
 ('approved-orderid', 'src/guard/approved.ts', "if (leg.orderId !== order.id) throw refuse('a step belongs to another order', leg.id);", '', ['src/guard/approved.test.ts', 'src/executor/execute.test.ts']),
 ('mock-evm-target-tx', 'src/guard/mock/check.ts', 'evm?.to === target && message.to === target', 'message.to === target', ['src/guard/mock/check.test.ts']),
 ('mock-evm-target-message', 'src/guard/mock/check.ts', 'evm?.to === target && message.to === target', 'evm?.to === target', ['src/guard/mock/check.test.ts']),
 ('mock-extra-fields', 'src/guard/mock/check.ts', 'if (extra.length)', 'if (false as boolean)', ['src/guard/mock/check.test.ts']),
 ('sol-price-len', 'src/guard/solana/check.ts', 'kind === 3 && ix.data.length === 9 && ', 'kind === 3 && ', ['src/guard/solana/check.test.ts']),
 ('sol-price-accounts', 'src/guard/solana/check.ts', 'kind === 3 && ix.data.length === 9 && ix.accounts.length === 0 && price === null', 'kind === 3 && ix.data.length === 9 && price === null', ['src/guard/solana/check.test.ts']),
 ('sol-limit-once', 'src/guard/solana/check.ts', 'ix.accounts.length === 0 && limit === null)', 'ix.accounts.length === 0)', ['src/guard/solana/check.test.ts']),
 ('wire-signers-keys', 'src/guard/solana/wire.ts', "if (signers > keys.length) throw new Error('more signers than accounts');", '', ['src/guard/solana/check.test.ts', 'src/guard/solana/wire.test.ts']),
 ('wire-ro-signers', 'src/guard/solana/wire.ts', "if (readonlySigners >= signers) throw new Error('the account that pays the fee is read-only');", '', ['src/guard/solana/check.test.ts', 'src/guard/solana/wire.test.ts']),
 ('wire-ro-others', 'src/guard/solana/wire.ts', "if (readonlyOthers > keys.length - signers)\n    throw new Error('more read-only accounts than accounts');", '', ['src/guard/solana/check.test.ts', 'src/guard/solana/wire.test.ts']),
 ('wire-compact-range', 'src/guard/solana/wire.ts', "if (value > 0xffff) throw new Error('a length is out of range');", '', ['src/guard/solana/check.test.ts', 'src/guard/solana/wire.test.ts']),
 ('wire-account-index', 'src/guard/solana/wire.ts', 'if (ix.accounts.some((i) => i >= keys.length + loaded))', 'if (false as boolean)', ['src/guard/solana/check.test.ts', 'src/guard/solana/wire.test.ts']),
 ('mock-evm-value', 'src/guard/mock/check.ts', "need('value', evm?.value === '0',", "need('value', true,", ['src/guard/mock/check.test.ts']),
 ('mock-evm-chainid', 'src/guard/mock/check.ts', '      evm?.chainId === MOCK_EVM_CHAIN_ID,\n', '      true,\n', ['src/guard/mock/check.test.ts']),
 ('exec-fates', 'src/executor/execute.ts', "return FATES.includes(fate) ? fate : 'unknown';", 'return fate;', ['src/executor/execute.test.ts']),
 ('exec-send-open', 'src/executor/execute.ts', "          if (held && held.proof === null && held.times > 0 && !approvedFor(held.times))\n            return review('asked', held.times);\n", '', ['src/executor/execute.test.ts']),
 ('exec-moved-bound', 'src/executor/execute.ts', 'if (moved > patience.rebuilds + 1)', 'if (false as boolean)', ['src/executor/execute.test.ts']),
 ('read-sol-height', 'src/executor/chain-read.ts', "return finalized > before + SOLANA_VALID_BLOCKS + SOLANA_MARGIN_BLOCKS ? 'gone' : 'open';", "return 'gone';", ['src/executor/signed.test.ts', 'src/executor/real-bytes.test.ts']),
 ('read-sol-knows', 'src/executor/chain-read.ts', 'if (!(await node.knows(blockhash))) return null;', '', ['src/executor/signed.test.ts', 'src/executor/real-bytes.test.ts']),
 ('read-sol-null-height', 'src/executor/chain-read.ts', "if (before === null) return 'unknown';", '', ['src/executor/signed.test.ts', 'src/executor/real-bytes.test.ts']),
 ('exec-height-null', 'src/executor/execute.ts', 'if (height === null) return { unknownBlockhash: true };', '', ['src/executor/real-bytes.test.ts', 'src/executor/execute.test.ts']),
 ('deploy-mark-only-files', 'src/guard/deployment.ts', 'if (mark) LOADED.add(loaded);', 'LOADED.add(loaded);', ['src/guard/deployment.test.ts']),
 ('exec-held-report-fate', 'src/executor/execute.ts', " && (await fateOf(held)) !== 'gone') {", ') {', ['src/executor/execute.test.ts']),
 ('exec-held-reuse-fate', 'src/executor/execute.ts', "before.messageHash === pass.tx.messageHash &&\n          (await fateOf(before)) !== 'gone'", 'before.messageHash === pass.tx.messageHash', ['src/executor/execute.test.ts']),
 ('exec-mock-no-height', 'src/executor/execute.ts', "deployment.family === 'mock' ? 'none' : await heightBefore(tx)", 'await heightBefore(tx)', ['src/executor/execute.test.ts']),
 ('exec-height-catch-zero', 'src/executor/execute.ts', '        } catch {\n          // Not knowing is asked again, like a no.\n        }', '        } catch {\n          return 0;\n        }', ['src/executor/real-bytes.test.ts', 'src/executor/execute.test.ts', 'src/executor/signed.test.ts']),
 ('reg-slot', 'src/guard/solana/check.ts', 'return [{ name: REGISTRY[step.action] }];', "return [{ name: 'publish_recipe' }];", ['src/guard/solana/registry.test.ts']),
 ('reg-owner', 'src/guard/solana/check.ts', "rule(call.name === 'cancel_pending' ? 'signer' : 'creator', owner, 'owner');", "rule(call.name === 'cancel_pending' ? 'signer' : 'creator', call.accounts[0] ?? '', 'owner');", ['src/guard/solana/registry.test.ts']),
 ('reg-recipe', 'src/guard/solana/check.ts', "rule('recipe', recipe, 'recipe');", "rule('recipe', call.accounts[1] ?? '', 'recipe');", ['src/guard/solana/registry.test.ts']),
 ('reg-components', 'src/guard/solana/check.ts', 'sameWeights(targetsOf(step.components), componentsIn(v))', 'true', ['src/guard/solana/registry.test.ts']),
 ('reg-meta', 'src/guard/solana/check.ts', 'v instanceof Uint8Array && hexEncode(v) === textHash', 'true', ['src/guard/solana/registry.test.ts', 'src/executor/real-bytes.test.ts']),
 ('reg-family', 'src/guard/solana/check.ts', 'v instanceof Uint8Array && hexEncode(v) === step.familyId', 'true', ['src/guard/solana/registry.test.ts']),
 ('reg-fee', 'src/guard/solana/check.ts', "need('limits', v === 0, `the bytes set a fee cap", "need('limits', true, `the bytes set a fee cap", ['src/guard/solana/registry.test.ts']),
 ('reg-flags', 'src/guard/solana/check.ts', "need('limits', v === 0, `the bytes set the flags", "need('limits', true, `the bytes set the flags", ['src/guard/solana/registry.test.ts']),
 ('reg-consent', 'src/guard/run.ts', "  if (step.kind === 'publish') return 'publish';\n", '', ['src/guard/solana/registry.test.ts', 'src/executor/real-bytes.test.ts']),
 ('reg-step-hex', 'src/guard/run.ts', "if (!hex32(step.familyId)) return 'the family id is not 32 bytes of hex';", '', ['src/guard/solana/registry.test.ts']),
 ('reg-step-sum', 'src/guard/run.ts', 'step.components.reduce((n, c) => n + c.weightBps, 0) === 10_000', 'true', ['src/guard/solana/registry.test.ts']),
 ('reg-approved-none', 'src/guard/approved.ts', 'if (!plan.publish)', 'if (false as boolean)', ['src/guard/solana/registry.test.ts']),
 ('reg-evm-seam', 'src/guard/evm/check.ts', "  if (step.kind === 'publish')\n    throw unsupported(", '  if (false as boolean)\n    throw unsupported(', ['src/guard/solana/registry.test.ts']),
 ('reg-mock-seam', 'src/guard/mock/check.ts', "  if (step.kind === 'publish')\n    throw new GuardRefusal('unsupported'", "  if (false as boolean)\n    throw new GuardRefusal('unsupported'", ['src/guard/solana/registry.test.ts']),
 ('reg-required', 'src/guard/solana/check.ts', "REGISTRY_CALLS.has(call.name) ? [] : ['owner', 'vault']", '[]', ['src/guard/solana/check.test.ts', 'src/guard/solana/registry.test.ts']),
 ('reg-hash-from-text', 'src/guard/solana/check.ts', "const textHash = step.text ? familyTextHash({ familyId: step.familyId, ...step.text }) : '';", "const textHash = step.metaHash ?? '';", ['src/guard/solana/registry.test.ts', 'src/executor/real-bytes.test.ts']),
 ('reg-handed-hash', 'src/guard/run.ts', 'if (step.metaHash !== undefined && step.metaHash !== hash)', 'if (false as boolean)', ['src/guard/solana/registry.test.ts']),
 ('reg-text-slug', 'src/guard/run.ts', '!/^[a-z0-9][a-z0-9-]*$/.test(t.slug) || ', '', ['src/guard/solana/registry.test.ts']),
 ('reg-text-name', 'src/guard/run.ts', ' || !text(t.name))', ')', ['src/guard/solana/registry.test.ts']),
 ('reg-text-kind', 'src/guard/run.ts', "if (t.kind !== 'index' && t.kind !== 'single') return 'the text shown is of no kind';", '', ['src/guard/solana/registry.test.ts']),
 ('reg-cancel-no-text', 'src/guard/run.ts', 'return step.text === null &&', 'return true &&', ['src/guard/solana/registry.test.ts']),
 ('reg-publish-only', 'src/guard/approved.ts', "if (plan.publish && leg.kind !== 'publish')", 'if (false as boolean)', ['src/guard/solana/registry.test.ts']),
 ('reg-publish-one', 'src/guard/approved.ts', 'if (plan.publish && legs.length !== 1)', 'if (false as boolean)', ['src/guard/solana/registry.test.ts']),
 ('meta-nfc', 'src/guard/meta.ts', "JSON.stringify(value.normalize('NFC'))", 'JSON.stringify(value)', ['src/guard/meta.test.ts']),
 ('meta-surrogate', 'src/guard/meta.ts', 'if (loneSurrogate(value)) throw new Error(`${key} holds half of a surrogate pair`);', '', ['src/guard/meta.test.ts']),
 ('meta-order', 'src/guard/meta.ts', "const FIELDS = ['copy', 'familyId', 'kind', 'name', 'slug'] as const;", "const FIELDS = ['familyId', 'copy', 'kind', 'name', 'slug'] as const;", ['src/guard/meta.test.ts']),
 ('meta-string', 'src/guard/meta.ts', "if (typeof value !== 'string') throw new Error(`${key} is not text`);", '', ['src/guard/meta.test.ts']),
 ('evm-route-read', 'src/guard/evm/check.ts', '    checkRoute(router, tokenIn, tokenOut, amountIn, data, deadline);\n', '', ['src/guard/evm/route.test.ts']),
 ('evm-route-currency0', 'src/guard/evm/check.ts', 'route.currency0 === currency0 && ', '', ['src/guard/evm/route.test.ts']),
 ('evm-route-currency1', 'src/guard/evm/check.ts', ' && route.currency1 === currency1', '', ['src/guard/evm/route.test.ts']),
 ('evm-route-settle-token', 'src/guard/evm/check.ts', 'route.settle.currency === tokenIn && ', '', ['src/guard/evm/route.test.ts']),
 ('evm-route-take-token', 'src/guard/evm/check.ts', ' && route.take.currency === tokenOut', '', ['src/guard/evm/route.test.ts']),
 ('evm-route-fee', 'src/guard/evm/check.ts', 'route.fee === BigInt(rule.fee) && ', '', ['src/guard/evm/route.test.ts']),
 ('evm-route-spacing', 'src/guard/evm/check.ts', ' && route.tickSpacing === BigInt(rule.tickSpacing)', '', ['src/guard/evm/route.test.ts']),
 ('evm-route-hooks', 'src/guard/evm/check.ts', 'route.hooks === rule.hooks && ', '', ['src/guard/evm/route.test.ts']),
 ('evm-route-hook-data', 'src/guard/evm/check.ts', ' && route.hookData.length === 0', '', ['src/guard/evm/route.test.ts']),
 ('evm-route-direction', 'src/guard/evm/check.ts', 'route.zeroForOne === (tokenIn === currency0),', 'true,', ['src/guard/evm/route.test.ts']),
 ('evm-route-amount', 'src/guard/evm/check.ts', 'route.amountIn === amountIn && ', '', ['src/guard/evm/route.test.ts']),
 ('evm-route-settle-max', 'src/guard/evm/check.ts', ' && route.settle.maxAmount === amountIn', '', ['src/guard/evm/route.test.ts']),
 ('evm-route-min-out', 'src/guard/evm/check.ts', 'route.amountOutMinimum === 0n && ', '', ['src/guard/evm/route.test.ts']),
 ('evm-route-min-hop', 'src/guard/evm/check.ts', 'route.minHopPriceX36 === 0n && ', '', ['src/guard/evm/route.test.ts']),
 ('evm-route-min-take', 'src/guard/evm/check.ts', ' && route.take.minAmount === 0n', '', ['src/guard/evm/route.test.ts']),
 ('evm-route-deadline', 'src/guard/evm/check.ts', '      route.deadline === deadline,\n', '      true,\n', ['src/guard/evm/route.test.ts']),
 ('route-selector', 'src/guard/evm/route.ts', 'data.length < 4 || selector !== UNIVERSAL_ROUTER_EXECUTE_SELECTOR', 'data.length < 4', ['src/guard/evm/route.test.ts']),
 ('route-commands', 'src/guard/evm/route.ts', 'if (!sameList(commands, [V4_SWAP]))', 'if (false as boolean)', ['src/guard/evm/route.test.ts']),
 ('route-one-input', 'src/guard/evm/route.ts', 'if (inputs.length !== 1 || !input)', 'if (!input)', ['src/guard/evm/route.test.ts']),
 ('route-actions', 'src/guard/evm/route.ts', 'if (!sameList(actions, [SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL]))', 'if (false as boolean)', ['src/guard/evm/route.test.ts']),
 ('route-three-params', 'src/guard/evm/route.ts', 'params.length !== 3 || ', '', ['src/guard/evm/route.test.ts']),
 ('deploy-route-every-router', 'src/guard/deployment.ts', '      Object.hasOwn(routes, router),\n', '      true,\n', ['src/guard/deployment.test.ts', 'src/guard/evm/route.test.ts']),
 ('deploy-route-unread-mainnet', 'src/guard/deployment.ts', "        network !== 'mainnet',\n", '        true,\n', ['src/guard/deployment.test.ts', 'src/guard/evm/route.test.ts']),
 ('deploy-route-hooks', 'src/guard/deployment.ts', '      route.hooks === ZERO_ADDRESS,\n', '      true,\n', ['src/guard/deployment.test.ts', 'src/guard/evm/route.test.ts']),
 ('deploy-route-kind', 'src/guard/deployment.ts', "must(route.kind === 'universal-router-v4', `${what} is of no kind the guard reads`);", '', ['src/guard/deployment.test.ts', 'src/guard/evm/route.test.ts']),
 ('deploy-placeholder', 'src/guard/deployment.ts', 'file.placeholder === undefined && file.todo === undefined,', 'true,', ['src/guard/deployment.test.ts', 'src/guard/evm/route.test.ts']),
]

HERE = os.path.dirname(os.path.abspath(__file__))
SDK = os.path.dirname(HERE)
REPO = os.path.dirname(os.path.dirname(SDK))


def setup():
    """A copy of the package to mutate, beside the repo's own dependencies. Nothing in the repo is changed."""
    work = os.environ.get('SDK_MUTATE_DIR') or tempfile.mkdtemp(prefix='sdk-mutate-')
    copy = os.path.join(work, 'm', 'packages', 'sdk')
    if os.path.exists(os.path.join(work, 'm')):
        shutil.rmtree(os.path.join(work, 'm'))
    shutil.copytree(SDK, copy, ignore=shutil.ignore_patterns('node_modules', 'dist'))
    os.symlink(os.path.join(SDK, 'node_modules'), os.path.join(copy, 'node_modules'))
    shutil.copy(os.path.join(REPO, 'tsconfig.base.json'), os.path.join(work, 'm'))
    shutil.copytree(os.path.join(REPO, 'fixtures', 'creator-limits'), os.path.join(work, 'm', 'fixtures', 'creator-limits'))
    with open(os.path.join(work, 'vitest.config.ts'), 'w') as f:
        f.write("import { defineConfig } from 'vitest/config';\n"
                "export default defineConfig({ test: { include: ['**/*.test.ts'], exclude: ['**/node_modules/**'], root: %r }, server: { fs: { strict: false } } });\n" % work)
    return work


def main():
    check = '--check' in sys.argv
    only = [a for a in sys.argv[1:] if a != '--check']
    work = setup()
    results = []
    for mid, f, old, new, tests in MUT:
        if only and not any(o in mid for o in only):
            continue
        path = os.path.join(work, 'm', 'packages', 'sdk', f)
        src = open(path).read()
        if src.count(old) != 1:
            results.append((mid, 'DID NOT APPLY (%d matches)' % src.count(old), []))
            print(results[-1], flush=True)
            continue
        if check:
            results.append((mid, 'killed? not run: it applies', []))
            continue
        open(path, 'w').write(src.replace(old, new))
        try:
            failed, names = 0, []
            for t in tests:
                out = subprocess.run(
                    ['pnpm', 'vitest', 'run', '--config', os.path.join(work, 'vitest.config.ts'), '--root', work,
                     'm/packages/sdk/' + t], cwd=REPO, capture_output=True, text=True).stdout
                m = re.search(r'Tests\s+(?:(\d+) failed)?', out)
                n = int(m.group(1)) if m and m.group(1) else 0
                if not re.search(r'Tests\s+.*\d+ passed', out) and not n:
                    raise SystemExit('no test ran for %s in %s:\n%s' % (mid, t, out[-600:]))
                failed += n
                names += re.findall(r'^\s+×\s+(.*?)\s+\d+ms', out, re.M)[:3]
            results.append((mid, 'killed by %d test(s)' % failed if failed else 'SURVIVED', names[:3]))
        finally:
            open(path, 'w').write(src)
        print(results[-1], flush=True)
    if check:
        bad = [r for r in results if r[1].startswith('DID NOT')]
        print('%d mutations, %d apply' % (len(results), len(results) - len(bad)))
        sys.exit(1 if bad else 0)
    bad = [r for r in results if not r[1].startswith('killed')]
    print('%d mutations, %d killed, %d not' % (len(results), len(results) - len(bad), len(bad)))
    sys.exit(1 if bad else 0)


if __name__ == '__main__':
    main()
