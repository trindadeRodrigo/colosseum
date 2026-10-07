import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadCapture } from '../../scripts/risk/lib-split';

// PLAN-UNIVERSE RU.12 — the installer of the raw-arrays job (scripts/risk/raw-arrays/install-job.sh), run under a
// made-up HOME with a stand-in for launchctl first on the PATH: nothing here can reach this machine's
// ~/.colosseum, its ~/Library/LaunchAgents or its launchd. What is held: a rehearsal writes only under the folder it
// is given and loads nothing; the ways a rehearsal could land on the live paths are refused before anything is
// written; the real path writes one bundle and one plist, loads its own label and no other, and leaves the env file
// as it was. The script is zsh (as the collectors' installers are), so the tests run where zsh is.
const INSTALL = resolve('scripts/risk/raw-arrays/install-job.sh');
const hasZsh = spawnSync('zsh', ['-c', 'exit 0']).status === 0;
const c = loadCapture('fixtures/risk/raw-arrays/hoodx-strcx-20261007T0431.json.gz');

const root = mkdtempSync(join(tmpdir(), 'raw-arrays-install-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const stub = join(root, 'bin');
const calls = join(root, 'launchctl.log');
mkdirSync(stub);
writeFileSync(join(stub, 'launchctl'), `#!/bin/sh\necho "launchctl $*" >> "${calls}"\n`);
chmodSync(join(stub, 'launchctl'), 0o755);

// a made-up HOME; with `collectors`, one where the collectors are installed: an env file, a registry and a cache
const ENV_FILE = 'SOLANA_RPC_URL=http://127.0.0.1:9/made-up\nJUPITER_API_KEY=made-up\n';
const fakeHome = (name: string, collectors = false) => {
  const home = join(root, name);
  mkdirSync(join(home, 'Library', 'LaunchAgents'), { recursive: true });
  if (collectors) {
    const risk = join(home, '.colosseum', 'risk');
    mkdirSync(risk, { recursive: true });
    writeFileSync(join(risk, 'env'), ENV_FILE);
    writeFileSync(join(risk, 'registry.json'), JSON.stringify({ pools: c.direct }));
    writeFileSync(join(risk, 'cache.json'), JSON.stringify({ children: c.children }));
  }
  return home;
};
const install = (home: string, args: string[], env: Record<string, string> = {}) => {
  const base: Record<string, string | undefined> = { ...process.env };
  for (const k of Object.keys(base))
    if (k.startsWith('RISK_') || k === 'COLOSSEUM_HOME') delete base[k];
  const r = spawnSync('zsh', [INSTALL, ...args], {
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...base, HOME: home, PATH: `${stub}:${process.env.PATH}`, ...env },
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
};
const launchctlCalls = () =>
  existsSync(calls) ? readFileSync(calls, 'utf8').split('\n').filter(Boolean) : [];
const tree = (dir: string): string[] =>
  existsSync(dir)
    ? readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => join(e.parentPath, e.name).slice(dir.length + 1))
        .sort()
    : [];

describe.skipIf(!hasZsh)('raw arrays: the installer', { timeout: 120_000 }, () => {
  it('a rehearsal writes its bundle and its plist under the folder given, and loads nothing', () => {
    const home = fakeHome('home-rehearsal');
    const dir = join(root, 'rehearsal');
    const r = install(home, ['--no-load'], { COLOSSEUM_HOME: dir });
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain('nothing is loaded');
    expect(tree(dir)).toEqual([
      'LaunchAgents/com.colosseum.risk-raw-arrays.plist',
      'risk-raw-arrays.mjs',
    ]);
    expect(existsSync(join(dir, 'raw-arrays'))).toBe(true);
    // nothing under the made-up HOME, and no word to launchd
    expect(tree(home)).toEqual([]);
    expect(launchctlCalls()).toEqual([]);
    const plist = readFileSync(
      join(dir, 'LaunchAgents', 'com.colosseum.risk-raw-arrays.plist'),
      'utf8',
    );
    expect(plist).toContain('<string>com.colosseum.risk-raw-arrays</string>');
    expect(plist).toContain('<dict><key>Minute</key><integer>25</integer></dict>');
    expect(plist).toContain(`${dir}/risk-raw-arrays.mjs >> ${dir}/risk-raw-arrays.log`);
    expect(plist.match(/<key>Minute<\/key>/g)).toHaveLength(1);
    // the bundle knows its own folder, and only that: the source has no default
    const bundle = readFileSync(join(dir, 'risk-raw-arrays.mjs'), 'utf8');
    expect(bundle).toContain(
      `process.env.RISK_RAW_ARRAYS_DIR ??= ${JSON.stringify(join(dir, 'raw-arrays'))};`,
    );
    expect(bundle).not.toContain('process.env.RISK_RAW_ARRAYS_ALL ??=');
    // a rehearsal never loads, with or without the option
    const again = install(home, [], { COLOSSEUM_HOME: dir });
    expect(again.status, again.out).toBe(0);
    expect(again.out).toContain('not loaded');
    expect(launchctlCalls()).toEqual([]);
  });

  it('what could put a rehearsal on the live paths is refused before anything is written', () => {
    const home = fakeHome('home-refusals', true);
    const before = tree(home);
    for (const [args, env, says] of [
      // not loading at the live home leaves a plist that the next login loads
      [['--no-load'], {}, 'refusing --no-load'],
      // a variable that was never filled is not a request for the live home
      [['--no-load'], { COLOSSEUM_HOME: '' }, 'set and empty'],
      [[], { COLOSSEUM_HOME: '' }, 'set and empty'],
      // the live home under another spelling is the live home
      [['--no-load'], { COLOSSEUM_HOME: `${home}/.colosseum/risk/` }, 'refusing --no-load'],
      [['--no-load'], { COLOSSEUM_HOME: `${home}/.colosseum/../.colosseum/risk` }, 'refusing'],
      // a rehearsal folder inside the live folders
      [
        ['--no-load'],
        { COLOSSEUM_HOME: `${home}/.colosseum/rehearsal` },
        'a rehearsal folder inside',
      ],
      [['--no-load'], { COLOSSEUM_HOME: `${home}/Library/rehearsal` }, 'a rehearsal folder inside'],
      // a path the plist's one line of command cannot carry
      [['--no-load'], { COLOSSEUM_HOME: join(root, 'with space') }, 'which the plist cannot carry'],
      [['--no-load'], { COLOSSEUM_HOME: join(root, 'with#hash') }, 'which the plist cannot carry'],
      [['--dry-run'], {}, 'usage:'],
    ] as Array<[string[], Record<string, string>, string]>) {
      const r = install(home, args, env);
      expect(r.status, `${JSON.stringify([args, env])}: ${r.out}`).toBe(1);
      expect(r.out).toContain(says);
    }
    expect(tree(home)).toEqual(before);
    expect(launchctlCalls()).toEqual([]);
    for (const made of ['with space', 'with#hash'])
      expect(existsSync(join(root, made))).toBe(false);
  });

  it('a rehearsal folder named from where the command is run is taken whole: the bundle built there starts', () => {
    const home = fakeHome('home-relative', true);
    const r = spawnSync('zsh', [INSTALL, '--no-load'], {
      encoding: 'utf8',
      timeout: 60_000,
      cwd: root,
      env: {
        ...process.env,
        HOME: home,
        PATH: `${stub}:${process.env.PATH}`,
        COLOSSEUM_HOME: 'relative',
      },
    });
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
    // started once, from another folder, on the made-up home's registry and cache
    expect(r.stdout).toContain('the new bundle starts (--plan)');
    expect(tree(join(root, 'relative'))).toEqual([
      'LaunchAgents/com.colosseum.risk-raw-arrays.plist',
      'risk-raw-arrays.mjs',
    ]);
    expect(launchctlCalls()).toEqual([]);
  });

  it('the install writes one bundle and one plist, loads its own label only, and leaves the env file as it was', () => {
    const home = fakeHome('home-real', true);
    const risk = join(home, '.colosseum', 'risk');
    const plist = join(home, 'Library', 'LaunchAgents', 'com.colosseum.risk-raw-arrays.plist');
    const r = install(home, []);
    expect(r.status, r.out).toBe(0);
    // the new bundle was started once, on the registry and the cache, before it took its place
    expect(r.out).toContain('the new bundle starts (--plan)');
    expect(tree(home)).toEqual([
      '.colosseum/risk/cache.json',
      '.colosseum/risk/env',
      '.colosseum/risk/registry.json',
      '.colosseum/risk/risk-raw-arrays.mjs',
      'Library/LaunchAgents/com.colosseum.risk-raw-arrays.plist',
    ]);
    expect(existsSync(join(risk, 'raw-arrays'))).toBe(true);
    expect(readFileSync(join(risk, 'env'), 'utf8')).toBe(ENV_FILE);
    expect(r.out).not.toContain('made-up');
    expect(launchctlCalls()).toEqual([`launchctl unload ${plist}`, `launchctl load ${plist}`]);
    expect(readFileSync(join(risk, 'risk-raw-arrays.mjs'), 'utf8')).toContain(
      `process.env.RISK_RAW_ARRAYS_DIR ??= ${JSON.stringify(join(risk, 'raw-arrays'))};`,
    );

    // again, with the two settings: they go into the bundle, and the bundle that was there is kept beside it
    const again = install(home, [], { RISK_RAW_ARRAYS_ALL: '1', RISK_RAW_ARRAYS_SKIP: 'other' });
    expect(again.status, again.out).toBe(0);
    const bundle = readFileSync(join(risk, 'risk-raw-arrays.mjs'), 'utf8');
    expect(bundle).toContain('process.env.RISK_RAW_ARRAYS_ALL ??= "1";');
    expect(bundle).toContain('process.env.RISK_RAW_ARRAYS_SKIP ??= "other";');
    const kept = readdirSync(risk).filter((f) =>
      /^risk-raw-arrays\.before-\d{8}-\d{6}\.mjs$/.test(f),
    );
    expect(kept).toHaveLength(1);
    expect(readFileSync(join(risk, kept[0] as string), 'utf8')).not.toContain(
      'RISK_RAW_ARRAYS_ALL ??=',
    );
    expect(readFileSync(join(risk, 'env'), 'utf8')).toBe(ENV_FILE);
    expect(launchctlCalls()).toHaveLength(4);
    expect(new Set(launchctlCalls()).size).toBe(2);
    // no half-built bundle and no half-written plist is left behind
    expect(readdirSync(risk).some((f) => f.includes('.new.'))).toBe(false);
    expect(readdirSync(join(home, 'Library', 'LaunchAgents'))).toEqual([
      'com.colosseum.risk-raw-arrays.plist',
    ]);
  });

  it('stops where the collectors are not installed, and says which file is missing', () => {
    const home = fakeHome('home-bare');
    const r = install(home, []);
    expect(r.status).toBe(1);
    expect(r.out).toContain('.colosseum/risk/env missing');
    expect(tree(home)).toEqual([]);
    // an env file that names no RPC
    const half = fakeHome('home-no-rpc', true);
    writeFileSync(join(half, '.colosseum', 'risk', 'env'), 'JUPITER_API_KEY=made-up\n');
    const before = tree(half);
    const r2 = install(half, []);
    expect(r2.status).toBe(1);
    expect(r2.out).toContain('SOLANA_RPC_URL missing');
    expect(tree(half)).toEqual(before);
  });
});
