import { availableModels } from './configuration';
import { effortLevels, parseChatInput } from './chatContracts';
import { randomUUID } from 'node:crypto';
import { aiConfiguration, creatable, optionalSource, propose, proposedSource, validatedSource, type Proposal, type ProposedChange } from './agent';
import { proposalDiffs, type DiffSource } from './lineDiff';
import { gatherContext, ownerInstructions, parseContextRequest, type ContextSources, type PromptContext } from './aiContext';
import { stepRecorder, type Step } from './progress';
import { affectedPages, brokenPages, renderedChanges, renderPages } from './applyCheck';
import { renderPath } from '../preview/renderPushServer';
import { parseDirection, parseReversibleChanges, reversibleChange, reversibleChanges, revertStep } from './reversible';
import type { FileChange } from '../project/changeFiles';
import type { createRooms } from '../collaboration/rooms';
import { changeFiles } from '../project/changeFiles';
import { record, sourcePath, string } from '../../shared/validation';

// A chat keeps 40 messages, so at most 20 replies follow any message.
const MAX_UNDO_SERIES = 20;

/** A file's whole source before and after a change; `previous` is null when the change creates it. */
export interface ReviewSources {
  readonly file: string;
  readonly previous: string | null;
  readonly next: string;
}

export class ProposalStore {
  private readonly proposals = new Map<string, { proposal: Proposal; expires: number }>();
  constructor(
    readonly root: string,
    readonly rooms: ReturnType<typeof createRooms>,
  ) {}
  private active = 0;
  /**
   * `sources` render and sample through the dev server; without them the model gets source code only.
   * `onStep` receives each step as it happens, for a client that streams them.
   */
  async create(value: unknown, signal?: AbortSignal, sources?: ContextSources, onStep?: (step: Step) => void) {
    if (this.active >= 3) {
      throw new Error('Three chats are already working. Wait for one to finish.');
    }
    this.active++;
    try {
      return await this.generate(value, signal, sources, stepRecorder(Date.now(), onStep));
    } finally {
      this.active--;
    }
  }
  private async generate(value: unknown, signal: AbortSignal | undefined, sources: ContextSources | undefined, recorder: ReturnType<typeof stepRecorder>) {
    const startedAtMs = Date.now();
    const config = aiConfiguration();
    if (!config) {
      throw new Error('Set AI_BASE_URL and AI_MODEL on the server to connect an AI provider. AI_API_KEY is optional for local providers.');
    }
    const input = record(value);
    const models = await availableModels();
    const model = string(input['model'] ?? models.defaultModel, 160);
    if (!models.models.includes(model)) {
      throw new Error('Choose a configured AI model');
    }
    const effort = input['effort'] === undefined ? '' : string(input['effort'], 16);
    if (effort && !effortLevels(models, model).includes(effort)) {
      throw new Error('Choose an effort level this model supports');
    }
    for (const [id, entry] of this.proposals) {
      if (entry.expires < Date.now()) {
        this.proposals.delete(id);
      }
    }
    if (this.proposals.size + this.active > 30) {
      throw new Error('Too many pending AI proposals');
    }
    const file = sourcePath(input['file']);
    const chat = parseChatInput(input);
    const contextRequest = parseContextRequest(input);
    if (sources) {
      recorder.progress(contextRequest.page ? `Rendering ${contextRequest.page}` : 'Gathering context');
    }
    const [context, guidance] = await Promise.all([gatherContext(this.root, file, contextRequest, sources, signal), ownerInstructions(this.root)]);
    const gathered = contextLabel(context, guidance);
    if (gathered) {
      recorder.progress(gathered);
    }
    const tools = models.tools.includes(model);
    const vision = models.vision.includes(model);
    const proposal = await propose(
      this.root,
      file,
      string(input['prompt'], 12_000),
      { ...config, model, ...(effort ? { effort } : {}), ...(tools ? { tools } : {}), ...(vision ? { vision } : {}) },
      { ...chat, context, ...(guidance ? { guidance } : {}), ...(sources ? { sources } : {}) },
      signal,
      recorder.progress,
    );
    signal?.throwIfAborted();
    const id = randomUUID();
    if (proposal.changes.length) {
      this.proposals.set(id, { proposal, expires: Date.now() + 900_000 });
    }
    return {
      id,
      summary: proposal.summary,
      files: proposal.changes.map((change) => change.file),
      changes: proposal.changes,
      diffs: proposalDiffs(await Promise.all(proposal.changes.map((change) => diffSource(this.root, change)))),
      ...(proposal.problems ? { problems: proposal.problems } : {}),
      steps: recorder.steps(),
      meta: { model, ...(effort ? { effort } : {}), durationMs: Date.now() - startedAtMs },
    };
  }
  async apply(value: unknown, sources?: ContextSources) {
    const input = record(value);
    const id = string(input['id'], 100);
    const entry = this.proposals.get(id);
    if (!entry || entry.expires < Date.now()) {
      throw new Error('Proposal expired. Generate it again.');
    }
    const canvas = input['page'] === undefined ? undefined : renderPath({ path: input['page'] });
    if (input['page'] !== undefined && canvas === undefined) {
      throw new Error('Invalid page path');
    }
    // Apply and check (applyCheck.ts): render the affected pages before and after writing.
    const fetchPage = sources?.fetchPage;
    const pages = fetchPage
      ? affectedPages(
          entry.proposal.changes.map((change) => change.file),
          canvas,
        )
      : [];
    const shoot = canvas && sources?.screenshot ? (size: 'thumbnail') => sources.screenshot?.(canvas, size).catch(() => undefined) : undefined;
    const [before, shotBefore] = await Promise.all([fetchPage && pages.length ? renderPages(pages, fetchPage) : undefined, shoot?.('thumbnail')]);
    const files = await this.rooms.coordinator.run(async () => {
      const files = await Promise.all(
        entry.proposal.changes.map(async (change) => ({
          file: change.file,
          previous: await optionalSource(this.root, change.file),
          source: await proposedSource(this.root, change),
        })),
      );
      if (new Set(files.map((file) => file.file)).size !== files.length) {
        throw new Error('AI must return one change per file');
      }
      await changeFiles(this.root, this.rooms, files);
      return files;
    });
    // Without a record (too large to send back), the change is applied but can't be undone from the chat.
    const changes = reversibleChanges(files.map((file) => reversibleChange(file.file, file.previous, file.source)));
    const recorded = changes ? { changes } : {};
    if (!fetchPage || !before) {
      this.proposals.delete(id);
      return { applied: true, ...recorded };
    }
    const after = await renderPages(pages, fetchPage);
    const broken = brokenPages(before, after);
    if (!broken.length) {
      this.proposals.delete(id);
      // Before and after pictures of the canvas page, when a browser is configured (screenshots.ts).
      const shotAfter = shotBefore && canvas ? await shoot?.('thumbnail') : undefined;
      const thumbnails = shotBefore && shotAfter && canvas ? { thumbnails: { path: canvas, before: shotBefore, after: shotAfter } } : {};
      return { applied: true, ...recorded, checked: pages, rendered: renderedChanges(before, after), ...thumbnails };
    }
    // The change broke a page: put the files back, unless someone edited them in the meantime. The
    // proposal stays, so the person can ask the model to fix it with the error.
    if (await this.restore(files)) {
      return { applied: false, broken };
    }
    this.proposals.delete(id);
    return { applied: true, ...recorded, broken, restored: false };
  }
  /** Puts each file back to `previous`, only when every file is still exactly what the change wrote. */
  private async restore(files: readonly { readonly file: string; readonly previous: string | undefined; readonly source: string }[]): Promise<boolean> {
    return this.rooms.coordinator.run(async () => {
      for (const file of files) {
        if ((await optionalSource(this.root, file.file)) !== file.source) {
          return false;
        }
      }
      await changeFiles(
        this.root,
        this.rooms,
        files.map((file) => (file.previous === undefined ? { file: file.file, remove: true } : { file: file.file, source: file.previous })),
      );
      return true;
    });
  }
  /** One file of a live proposal, whole, before and after: for the review, which diffs more than the chat's hunks show. */
  async proposalFile(id: string, value: unknown): Promise<ReviewSources> {
    const file = sourcePath(value);
    const entry = this.proposals.get(string(id, 100));
    if (!entry || entry.expires < Date.now()) {
      throw new Error('Proposal expired. Generate it again.');
    }
    const change = entry.proposal.changes.find((candidate) => candidate.file === file);
    if (!change) {
      throw new Error('This file is not part of the proposal');
    }
    return { file, previous: (await optionalSource(this.root, file)) ?? null, next: await proposedSource(this.root, change) };
  }
  /**
   * One file of an applied change, whole, as it was before the change and after it. The current
   * file is one side; the record undone or redone on it gives the other, so edits made since the
   * change show on both sides and only the change itself differs.
   */
  async changeFile(value: unknown): Promise<ReviewSources> {
    const input = record(value);
    const [change] = parseReversibleChanges([input['change']]);
    const state = input['state'];
    if (!change || (state !== 'applied' && state !== 'undone')) {
      throw new Error('Invalid change record');
    }
    const current = await optionalSource(this.root, change.file);
    const step = revertStep(current, change, state === 'applied' ? 'undo' : 'redo');
    if (step.kind === 'conflict') {
      throw new Error(`${change.file} changed since, so this change can't be shown in the whole file.`);
    }
    const [previous, next] = state === 'applied' ? [step.source, current] : [current, step.source];
    if (next === undefined) {
      throw new Error('Invalid change record');
    }
    return { file: change.file, previous: previous ?? null, next };
  }
  /**
   * Undo several applied changes, newest first, as one step: "edit from here" in the chat undoes every
   * change after a message. Each record is undone on the sources the previous ones left, in memory, so
   * a file changed by two replies goes back through both; a conflict anywhere writes nothing.
   */
  async undoSeries(value: unknown) {
    const input = record(value)['sets'];
    if (!Array.isArray(input) || !input.length || input.length > MAX_UNDO_SERIES) {
      throw new Error('Invalid change records');
    }
    const sets = input.map(parseReversibleChanges);
    return this.rooms.coordinator.run(async () => {
      const sources = new Map<string, string | undefined>();
      for (const set of sets) {
        for (const change of set) {
          const current = sources.has(change.file) ? sources.get(change.file) : await optionalSource(this.root, change.file);
          const step = revertStep(current, change, 'undo');
          if (step.kind === 'conflict') {
            return { reverted: false, conflicts: [change.file] };
          }
          sources.set(change.file, step.source);
        }
      }
      const planned: FileChange[] = [];
      for (const [file, source] of sources) {
        if (source === undefined ? !creatable(file) : !(await isValid(file, source))) {
          return { reverted: false, conflicts: [file] };
        }
        planned.push(source === undefined ? { file, remove: true } : { file, source });
      }
      await changeFiles(this.root, this.rooms, planned);
      return { reverted: true, files: planned.length };
    });
  }
  /** Undo or redo an applied change: every file, or none when any file conflicts. */
  async revert(value: unknown) {
    const input = record(value);
    const direction = parseDirection(input['direction']);
    const changes = parseReversibleChanges(input['changes']);
    return this.rooms.coordinator.run(async () => {
      const planned: FileChange[] = [];
      const conflicts: string[] = [];
      for (const change of changes) {
        const step = revertStep(await optionalSource(this.root, change.file), change, direction);
        if (step.kind === 'conflict' || (step.source === undefined ? !creatable(change.file) : !(await isValid(change.file, step.source)))) {
          conflicts.push(change.file);
        } else {
          planned.push(step.source === undefined ? { file: change.file, remove: true } : { file: change.file, source: step.source });
        }
      }
      if (conflicts.length) {
        return { reverted: false, conflicts };
      }
      await changeFiles(this.root, this.rooms, planned);
      return { reverted: true };
    });
  }
}

// The file's source now and with the change applied, for the diff the chat shows. A change that
// can't apply (its `before` is gone or ambiguous, or the result doesn't parse) is shown with its
// reason, rather than failing the whole reply: the summary and the other files are still useful.
async function diffSource(root: string, change: ProposedChange): Promise<DiffSource | { readonly file: string; readonly failure: string }> {
  try {
    return { file: change.file, previous: await optionalSource(root, change.file), next: await proposedSource(root, change) };
  } catch (error) {
    return { file: change.file, failure: error instanceof Error ? error.message : 'This change cannot be applied.' };
  }
}

// One step for what the request carries besides the source: "Context: the rendered page, 2 data calls, ...".
function contextLabel(context: PromptContext, guidance: string | undefined): string | undefined {
  const parts = [
    context.page
      ? 'outline' in context.page
        ? `the rendered page ${context.page.path}`
        : `no render of ${context.page.path} (${context.page.unavailable})`
      : '',
    context.selection ? `the selected ${context.selection.label}` : '',
    context.data?.length ? `${context.data.length} data call${context.data.length === 1 ? '' : 's'}` : '',
    context.host?.length ? context.host.map((section) => section.title).join(', ') : '',
    guidance ? 'the owner guidance' : '',
  ].filter(Boolean);
  return parts.length ? `Context: ${parts.join(', ')}` : undefined;
}

async function isValid(file: string, source: string): Promise<boolean> {
  try {
    await validatedSource(file, source);
    return true;
  } catch {
    return false;
  }
}
