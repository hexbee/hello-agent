// Probe harness shared by all spikes.

export interface Check {
  name: string;
  pass: boolean;
  detail?: string;
}

export class Reporter {
  private checks: Check[] = [];

  check(name: string, pass: boolean, detail?: string): boolean {
    this.checks.push({ name, pass, detail });
    if (!pass) {
      console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
    } else if (process.env.PROBE_VERBOSE) {
      console.log(`  ✓ ${name}`);
    }
    return pass;
  }

  async run(name: string, fn: () => Promise<void> | void): Promise<void> {
    console.log(`\n[probe] ${name}`);
    try {
      await fn();
    } catch (e) {
      this.check("probe completed without throwing", false, e instanceof Error ? e.stack : String(e));
    }
  }

  summary(): boolean {
    const failed = this.checks.filter((c) => !c.pass);
    const pass = failed.length === 0;
    console.log(
      `\n${pass ? "PASS" : "FAIL"} — ${this.checks.length - failed.length}/${this.checks.length} checks`,
    );
    for (const f of failed) console.error(`  ✗ ${f.name}: ${f.detail ?? ""}`);
    return pass;
  }
}

export function exitOn(r: Reporter): void {
  process.exitCode = r.summary() ? 0 : 1;
}

/** Snapshot path metadata recursively for before/after tamper detection. */
export async function snapshotTree(
  root: string,
): Promise<Map<string, { size: number; mtimeMs: number }>> {
  const out = new Map<string, { size: number; mtimeMs: number }>();
  const { readdir, stat } = await import("node:fs/promises");
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = `${dir}/${e.name}`;
      if (e.isDirectory()) await walk(p);
      else {
        try {
          const st = await stat(p);
          out.set(p, { size: st.size, mtimeMs: st.mtimeMs });
        } catch {
          /* raced file */
        }
      }
    }
  }
  await walk(root);
  return out;
}
