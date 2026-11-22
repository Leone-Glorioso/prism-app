// Files a projects repository needs so the app can compile it. They are bundled into the app, so anyone
// (for example a friend) can initialise their own empty private repository from the app itself.

import compileWorkflow from '../data-repo/.github/workflows/compile.yml?raw';
import compileScript from '../data-repo/.github/scripts/compile.sh?raw';
import gitignore from '../data-repo/.gitignore?raw';
import { encodeText } from './util';

const lf = (s: string) => s.replace(/\r\n/g, '\n');

export const WORKFLOW_PATHS = ['.github/workflows/compile.yml', '.github/scripts/compile.sh'] as const;

export const SETUP_FILES: Record<string, string> = {
  '.github/workflows/compile.yml': lf(compileWorkflow),
  '.github/scripts/compile.sh': lf(compileScript),
  '.gitignore': lf(gitignore),
  'prism-projects.json': '[]\n',
};

/** Git blob id of a text: sha1("blob <bytes>\0" + bytes). Equal ids mean identical files. */
export async function gitBlobSha(text: string): Promise<string> {
  const body = encodeText(text);
  const head = encodeText(`blob ${body.length}\0`);
  const all = new Uint8Array(head.length + body.length);
  all.set(head);
  all.set(body, head.length);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-1', all));
  return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export interface SetupStatus {
  /** Files that must exist for compiling to work (workflow, script, manifest). */
  missing: string[];
  /** Workflow files that differ from the bundled version. */
  outdated: string[];
  needed: boolean;
}

export async function setupStatus(files: { get(path: string): { sha: string } | undefined }): Promise<SetupStatus> {
  const missing: string[] = [];
  const outdated: string[] = [];
  for (const path of [...WORKFLOW_PATHS, 'prism-projects.json']) {
    if (!files.get(path)) missing.push(path);
  }
  for (const path of WORKFLOW_PATHS) {
    const f = files.get(path);
    if (f && f.sha !== (await gitBlobSha(SETUP_FILES[path]))) outdated.push(path);
  }
  return { missing, outdated, needed: missing.length > 0 || outdated.length > 0 };
}
