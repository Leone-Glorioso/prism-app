// Runs compile.yml in the data repo through GitHub Actions and fetches the published build.

import { GitHub, GitHubError, WorkflowRun } from './github';
import { buildBranch, sleep } from './util';

export const WORKFLOW = 'compile.yml';

export interface BuildResult {
  status: 'ok' | 'warning' | 'error' | 'timeout';
  exit_code: number;
  project: string;
  main_file: string;
  engine: string;
  first_error: string;
  duration_seconds: number;
  finished_at: string;
  sha: string;
  run_id: string;
}

export interface Build {
  result: BuildResult;
  log: string;
  pdf: Uint8Array | null;
  /** Downloads the SyncTeX data on first use (it can be large). Null when the build has none. */
  synctex: () => Promise<Uint8Array | null>;
}

const decoder = new TextDecoder(); // logs may contain broken UTF-8 (TeX wraps lines mid-character)

/** Latest published build of a project, or null if it was never built. */
export async function fetchBuild(gh: GitHub, project: string): Promise<Build | null> {
  const files = await gh.branchFiles(await buildBranch(project));
  if (!files || !files.has('result.json')) return null;
  const result = JSON.parse(decoder.decode(await gh.getBlob(files.get('result.json')!))) as BuildResult;
  const log = files.has('output.log') ? decoder.decode(await gh.getBlob(files.get('output.log')!)) : '';
  const pdf = files.has('output.pdf') ? await gh.getBlob(files.get('output.pdf')!) : null;
  const syncSha = files.get('output.synctex.gz');
  let sync: Promise<Uint8Array | null> | null = null;
  return { result, log, pdf, synctex: () => (sync ??= syncSha ? gh.getBlob(syncSha) : Promise.resolve(null)) };
}

export type Phase = 'starting' | 'queued' | 'in_progress' | 'fetching';

export class CompileCancelled extends Error {}

/**
 * Starts a compile of the committed state of `branch` and waits for it.
 * `isCurrent()` lets the caller abandon the wait when a newer compile was started.
 */
export async function compile(
  gh: GitHub, branch: string, project: string,
  onPhase: (p: Phase, run?: WorkflowRun) => void, isCurrent: () => boolean,
): Promise<Build> {
  const request = crypto.randomUUID();
  const since = new Date(Date.now() - 2 * 60_000).toISOString().replace(/\.\d+Z$/, 'Z'); // allow clock skew
  onPhase('starting');
  try {
    await gh.dispatch(WORKFLOW, branch, { project, request });
  } catch (e) {
    if (e instanceof GitHubError && e.status === 404) {
      throw new Error(`Workflow ${WORKFLOW} not found on branch "${branch}" of the data repository, or the token lacks Actions permission.`);
    }
    throw e;
  }

  // Dispatch does not return the run id: find the run by the request id in its title (see run-name).
  let run: WorkflowRun | undefined;
  for (const started = Date.now(); !run; ) {
    if (!isCurrent()) throw new CompileCancelled();
    if (Date.now() - started > 3 * 60_000) throw new Error('GitHub did not start the compile run within 3 minutes. Check the Actions tab of the data repository.');
    await sleep(2500);
    run = (await gh.listDispatchRuns(WORKFLOW, since)).find((r) => r.display_title.includes(`[${request}]`));
  }

  for (const started = Date.now(); run.status !== 'completed'; ) {
    if (!isCurrent()) throw new CompileCancelled();
    onPhase(run.status === 'queued' || run.status === 'waiting' || run.status === 'pending' ? 'queued' : 'in_progress', run);
    if (Date.now() - started > 70 * 60_000) throw new Error(`Compile run still not finished after 70 minutes: ${run.html_url}`);
    await sleep(4000);
    run = await gh.getRun(run.id);
  }
  if (run.conclusion === 'cancelled') throw new CompileCancelled(`Run cancelled (a newer compile of this project replaced it): ${run.html_url}`);

  onPhase('fetching', run);
  const build = await fetchBuild(gh, project);
  if (!build || build.result.run_id !== String(run.id)) {
    throw new Error(`The compile run ended (${run.conclusion}) without publishing a result. Details: ${run.html_url}`);
  }
  return build;
}
