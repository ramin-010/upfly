import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { UpflyError } from './errors.js';
import { MANIFEST_PATH, MANIFEST_VOLATILE_FIELDS, withoutVolatileFields } from './manifest.js';
import {
  type FileStore,
  type PlannedOperation,
  type RunContext,
  commit,
  inspect,
  prepare,
  revert,
} from './transaction.js';

const RUN_DIR = '.upfly/runs/r1';

function sha(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

interface Harness {
  readonly store: FileStore;
  readonly files: Map<string, string>;
  mutations(): number;
  /** A crash ends a process; the next one starts with a disk that works again. */
  stopFailing(): void;
}

/**
 * An in-memory store that can be told to die partway through.
 *
 * `failAfter` counts the operations that change something: a write, a copy, a
 * removal. Injecting the failure here rather than calling revert directly is the
 * point of the whole exercise, because it interrupts commit on the same code path a
 * real crash would.
 */
function memoryStore(
  initial: Record<string, string>,
  failAfter = Number.POSITIVE_INFINITY,
): Harness {
  const files = new Map(Object.entries(initial));
  let mutations = 0;
  let limit = failAfter;

  const mutate = (): void => {
    mutations += 1;
    if (mutations > limit) throw new Error(`injected failure at mutation ${mutations}`);
  };

  return {
    files,
    mutations: () => mutations,
    stopFailing: () => {
      limit = Number.POSITIVE_INFINITY;
    },
    store: {
      async hash(path) {
        const text = files.get(path);
        return text === undefined ? null : sha(text);
      },
      async readText(path) {
        const text = files.get(path);
        if (text === undefined) throw new Error(`no such file: ${path}`);
        return text;
      },
      async writeText(path, text) {
        mutate();
        files.set(path, text);
      },
      async copy(from, to) {
        mutate();
        const text = files.get(from);
        if (text === undefined) throw new Error(`no such file: ${from}`);
        files.set(to, text);
      },
      async remove(path) {
        mutate();
        files.delete(path);
      },
    },
  };
}

/** A tree exercising all four operation kinds at once. */
function tree(runDir = RUN_DIR): Record<string, string> {
  return {
    'src/App.jsx': 'import logo from "./logo.png";\nexport const alt = "./logo.png";\n',
    'src/logo.png': 'PNG-BYTES',
    'public/hero.png': 'HERO-BYTES',
    'images/old.png': 'OLD-BYTES',
    [`${runDir}/staged/logo.webp`]: 'WEBP-BYTES',
    [`${runDir}/backup/old.png`]: 'OLD-BYTES',
  };
}

/**
 * The plan. The two edits inside `App.jsx` are deliberate: a single reference would
 * not exercise the offset shifting that inverting a multi-edit rewrite depends on.
 */
function plan(): PlannedOperation[] {
  const text = tree()['src/App.jsx'] as string;
  const first = text.indexOf('./logo.png');
  const second = text.indexOf('./logo.png', first + 1);
  const edits = [
    { start: first, end: first + './logo.png'.length, replacement: './logo.webp' },
    { start: second, end: second + './logo.png'.length, replacement: './logo.webp' },
  ];
  const after = `${text.slice(0, first)}./logo.webp${text.slice(first + 10, second)}./logo.webp${text.slice(second + 10)}`;

  return [
    {
      kind: 'create',
      path: 'src/logo.webp',
      staged: 'staged/logo.webp',
      afterHash: sha('WEBP-BYTES'),
    },
    { kind: 'edit', path: 'src/App.jsx', beforeHash: sha(text), afterHash: sha(after), edits },
    {
      kind: 'move',
      from: 'public/hero.png',
      to: 'public/images/hero.png',
      hash: sha('HERO-BYTES'),
    },
    {
      kind: 'delete',
      path: 'images/old.png',
      beforeHash: sha('OLD-BYTES'),
      backup: 'backup/old.png',
    },
  ];
}

function context(): RunContext {
  let tick = 0;
  return {
    runId: 'r1',
    runDir: RUN_DIR,
    now: () => `2026-01-01T00:00:0${tick++}.000Z`,
    declined: [{ path: 'src/dynamic.png', reason: 'referenced only by a runtime expression' }],
  };
}

/** The project's own files, with the run directory and the manifest left out. */
function projectFiles(files: ReadonlyMap<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [path, text] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    if (path.startsWith('.upfly/')) continue;
    out[path] = text;
  }
  return out;
}

describe('prepare', () => {
  it('accepts a plan whose operations each target a different path', async () => {
    const harness = memoryStore(tree());
    await expect(prepare(plan(), harness.store, RUN_DIR)).resolves.toBeUndefined();
  });

  it('refuses two operations that target the same path', async () => {
    const harness = memoryStore(tree());
    const clash: PlannedOperation[] = [
      ...plan(),
      { kind: 'delete', path: 'src/App.jsx', beforeHash: sha('x'), backup: 'backup/old.png' },
    ];
    await expect(prepare(clash, harness.store, RUN_DIR)).rejects.toThrow(
      /both target src\/App\.jsx/,
    );
  });

  it('refuses a delete whose backup was never written', async () => {
    const files = tree();
    delete files[`${RUN_DIR}/backup/old.png`];
    const harness = memoryStore(files);

    await expect(prepare(plan(), harness.store, RUN_DIR)).rejects.toThrow(
      /backup\/old\.png in the run directory, which was never written/,
    );
  });

  it('refuses a create whose destination already exists', async () => {
    const files = { ...tree(), 'src/logo.webp': 'SOMETHING-ELSE' };
    const harness = memoryStore(files);

    await expect(prepare(plan(), harness.store, RUN_DIR)).rejects.toThrow(/which already exists/);
  });

  it('refuses a plan built on content that has since changed', async () => {
    const files = { ...tree(), 'src/App.jsx': 'something a person edited after the audit\n' };
    const harness = memoryStore(files);

    await expect(prepare(plan(), harness.store, RUN_DIR)).rejects.toThrow(
      /changed between planning and now/,
    );
  });

  it('refuses a plan whose undo would not apply', async () => {
    // A deletion immediately followed by a replacement inverts into two edits that
    // share a start offset, which applyEdits rejects. Catching it here is the whole
    // reason prepare checks the inverse rather than trusting it.
    const harness = memoryStore({ 'a.css': 'abcdef', [`${RUN_DIR}/staged/x`]: 'x' });
    const bad: PlannedOperation[] = [
      {
        kind: 'edit',
        path: 'a.css',
        beforeHash: sha('abcdef'),
        afterHash: sha('Xcdef'),
        edits: [
          { start: 0, end: 1, replacement: '' },
          { start: 1, end: 2, replacement: 'X' },
        ],
      },
    ];
    await expect(prepare(bad, harness.store, RUN_DIR)).rejects.toThrow(/undo for a\.css/);
  });
});

describe('commit', () => {
  it('writes the manifest before it touches a single file', async () => {
    // Allow exactly one mutation, then die. Whichever mutation that was is the one
    // commit does first, and it has to be the manifest: a changed tree with no
    // manifest is the single state undo cannot get out of.
    //
    // Asserting the manifest is present matters more than asserting the tree is
    // clean. An earlier version of this test crashed at mutation zero and only
    // checked the tree, which passes whatever the order is, because nothing has
    // happened yet either way. It was named after a property it did not test.
    const harness = memoryStore(tree(), 1);
    await expect(commit(plan(), harness.store, context())).rejects.toThrow(/injected failure/);

    expect(harness.files.has(MANIFEST_PATH)).toBe(true);
    expect(projectFiles(harness.files)).toEqual(projectFiles(new Map(Object.entries(tree()))));
  });

  it('applies every operation and records them all', async () => {
    const harness = memoryStore(tree());
    const manifest = await commit(plan(), harness.store, context());

    expect(manifest.state).toBe('committed');
    expect(manifest.operations).toHaveLength(4);
    expect(harness.files.get('src/logo.webp')).toBe('WEBP-BYTES');
    expect(harness.files.get('src/App.jsx')).toContain('./logo.webp');
    expect(harness.files.get('src/App.jsx')).not.toContain('./logo.png');
    expect(harness.files.get('public/images/hero.png')).toBe('HERO-BYTES');
    expect(harness.files.has('public/hero.png')).toBe(false);
    expect(harness.files.has('images/old.png')).toBe(false);
  });

  it('carries every declined item into the manifest', async () => {
    const harness = memoryStore(tree());
    const manifest = await commit(plan(), harness.store, context());

    expect(manifest.declined).toEqual([
      { path: 'src/dynamic.png', reason: 'referenced only by a runtime expression' },
    ]);
  });
});

describe('revert', () => {
  it('restores a byte-identical tree after a complete run', async () => {
    const original = tree();
    const harness = memoryStore(original);
    const manifest = await commit(plan(), harness.store, context());

    expect(projectFiles(harness.files)).not.toEqual(
      projectFiles(new Map(Object.entries(original))),
    );

    await revert(manifest, harness.store);
    expect(projectFiles(harness.files)).toEqual(projectFiles(new Map(Object.entries(original))));
  });

  it('refuses to revert over a file somebody else changed', async () => {
    const harness = memoryStore(tree());
    const manifest = await commit(plan(), harness.store, context());
    harness.files.set('src/App.jsx', 'a person edited this after the run\n');

    await expect(revert(manifest, harness.store)).rejects.toBeInstanceOf(UpflyError);
    // Nothing else was rolled back either: a refusal must not leave a third state.
    expect(harness.files.get('src/logo.webp')).toBe('WEBP-BYTES');
  });

  it('is safe to run twice', async () => {
    const original = tree();
    const harness = memoryStore(original);
    const manifest = await commit(plan(), harness.store, context());

    await revert(manifest, harness.store);
    await revert(manifest, harness.store);
    expect(projectFiles(harness.files)).toEqual(projectFiles(new Map(Object.entries(original))));
  });
});

describe('the crash matrix', () => {
  it('restores a byte-identical tree after a failure at every step of commit', async () => {
    const original = projectFiles(new Map(Object.entries(tree())));

    const complete = memoryStore(tree());
    await commit(plan(), complete.store, context());
    const steps = complete.mutations();
    expect(steps).toBeGreaterThan(5);

    let treesActuallyChanged = 0;

    for (let failAfter = 0; failAfter < steps; failAfter++) {
      const harness = memoryStore(tree(), failAfter);
      await expect(commit(plan(), harness.store, context())).rejects.toThrow(/injected failure/);

      const interrupted = harness.files.get(MANIFEST_PATH);
      if (interrupted === undefined) {
        // Only possible when the crash beat the manifest write, in which case the
        // tree cannot have been touched.
        expect(projectFiles(harness.files)).toEqual(original);
        continue;
      }

      if (JSON.stringify(projectFiles(harness.files)) !== JSON.stringify(original)) {
        treesActuallyChanged += 1;
      }

      harness.stopFailing();
      await revert(JSON.parse(interrupted), harness.store);
      expect(projectFiles(harness.files), `failure after mutation ${failAfter}`).toEqual(original);
    }

    // Without this the matrix could pass by never having changed anything, which is
    // the vacuous version of the same test.
    expect(treesActuallyChanged).toBeGreaterThan(0);
  });
});

describe('the manifest is deterministic except where it says it is not', () => {
  it('produces byte-identical manifests across two runs over identical input', async () => {
    const other = '.upfly/runs/a-different-run';
    const first = await commit(plan(), memoryStore(tree()).store, context());
    const second = await commit(plan(), memoryStore(tree(other)).store, {
      ...context(),
      runId: 'a-different-run',
      runDir: other,
    });

    expect(withoutVolatileFields(first)).toEqual(withoutVolatileFields(second));
  });

  it('fails when a field outside the allow-list varies', async () => {
    const manifest = await commit(plan(), memoryStore(tree()).store, context());
    const drifted = { ...manifest, declined: [{ path: 'other.png', reason: 'different' }] };

    expect(withoutVolatileFields(manifest)).not.toEqual(withoutVolatileFields(drifted));
  });

  it('refuses an allow-list entry naming a field the manifest does not have', async () => {
    const manifest = await commit(plan(), memoryStore(tree()).store, context());
    const { startedAt: _renamedAway, ...renamed } = manifest;

    expect(() => withoutVolatileFields(renamed as never)).toThrow(/listed as volatile/);
  });

  it('names every volatile field', () => {
    expect([...MANIFEST_VOLATILE_FIELDS]).toEqual(['runId', 'startedAt', 'completedAt', 'runDir']);
  });
});

describe('inspect', () => {
  it('reports every operation as not-applied before a commit', async () => {
    const harness = memoryStore(tree());
    const manifest = await commit(plan(), memoryStore(tree()).store, context());

    const states = await inspect(manifest, harness.store);
    expect(states.map((state) => state.status)).toEqual([
      'not-applied',
      'not-applied',
      'not-applied',
      'not-applied',
    ]);
  });

  it('reports a move whose copy landed but whose source is still there as partial', async () => {
    const harness = memoryStore(tree());
    const manifest = await commit(plan(), memoryStore(tree()).store, context());
    await harness.store.copy('public/hero.png', 'public/images/hero.png');

    const states = await inspect(manifest, harness.store);
    const move = states.find((state) => state.operation.kind === 'move');
    expect(move?.status).toBe('partial');
  });
});
