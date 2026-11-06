import { request, requestEvents } from '../project/projectClient';
import {
  chatState,
  updateChat,
  parseProposal,
  parseApplied,
  parseReplyRecord,
  parseStep,
  parseApplyCheck,
  parseBrokenPages,
  type ApplyCheck,
  type AppliedChange,
  type ChatThread,
  type ChatMessage,
} from './chatState';
import { record, string } from '../../shared/validation';
import type { Direction } from './reversible';
import type { ChatContext } from './chatContracts';
import type { ChatRequestContext } from './chatRequestContext';
import { captureAfterChange, captureCanvas } from './canvasCapture';

const running = new Map<string, AbortController>();
function context(chat: ChatThread): readonly ChatContext[] {
  const history = chat.messages.slice(-12).map((message) => ({
    role: message.role,
    content: (message.content + (message.outcome ? `\n${message.outcome}` : '')).slice(0, 6000),
  }));
  while (JSON.stringify(history).length > 80_000) {
    history.shift();
  }
  return history;
}
/** `effort` is the chat's effort when its model supports it, otherwise empty; `context` is the editor's page and selection. */
export async function sendChat(id: string, file: string, effort: string, context: ChatRequestContext) {
  const chat = chatState().threads.find((thread) => thread.id === id);
  if (!chat || chat.status !== 'idle' || (!chat.draft.trim() && !chat.images.length) || !chat.model) {
    return;
  }
  if (running.size >= 3) {
    updateChat(id, (thread) => ({
      ...thread,
      error: 'Three chats are already working. Wait for one to finish.',
    }));
    return;
  }
  const controller = new AbortController();
  running.set(id, controller);
  const message: ChatMessage = {
    id: crypto.randomUUID(),
    role: 'user',
    content: chat.draft.trim(),
    images: chat.images,
  };
  updateChat(id, (thread) => ({
    ...thread,
    draft: '',
    images: [],
    status: 'working',
    error: '',
    title: thread.messages.length ? thread.title : (message.content || 'Image conversation').slice(0, 60),
    messages: [...thread.messages, message].slice(-39),
  }));
  try {
    const { proposal, record: replyRecord } = await generateReply(chat, { file, effort, context }, controller.signal, (label) =>
      updateChat(id, (thread) => ({ ...thread, progress: { label, startedAt: thread.progress?.startedAt ?? Date.now() } })),
    );
    if (controller.signal.aborted) {
      return;
    }
    updateChat(id, (thread) => ({
      ...thread,
      messages: [
        ...thread.messages,
        {
          id: crypto.randomUUID(),
          role: 'assistant' as const,
          content: proposal.summary,
          images: [],
          ...(proposal.changes.length ? { proposal: context.page ? { ...proposal, page: context.page } : proposal } : {}),
          ...replyRecord,
        },
      ].slice(-40),
    }));
  } catch (error) {
    updateChat(id, (thread) => ({
      ...thread,
      error: controller.signal.aborted ? 'Response stopped.' : error instanceof Error ? error.message : 'Could not send message.',
      draft: thread.draft || chat.draft,
      images: thread.images.length ? thread.images : chat.images,
    }));
  } finally {
    running.delete(id);
    updateChat(id, ({ progress: _progress, ...thread }) => ({ ...thread, status: 'idle' }));
  }
}
export function stopChat(id: string) {
  running.get(id)?.abort();
}
export function discardProposal(id: string, messageId: string) {
  finishProposal(id, messageId, 'Discarded. No changes were applied.', 'nothing');
}
// A discarded proposal leaves only its outcome; an applied one keeps its diffs, so the change can still be read.
function finishProposal(id: string, messageId: string, outcome: string, kept: 'nothing' | 'diffs', applied?: AppliedChange, check?: ApplyCheck) {
  updateChat(id, (thread) => ({
    ...thread,
    messages: thread.messages.map((message) => {
      if (message.id !== messageId) {
        return message;
      }
      const { proposal, ...rest } = message;
      const diffs = kept === 'diffs' ? proposal?.diffs : undefined;
      return { ...rest, outcome, ...(applied ? { applied } : {}), ...(diffs ? { diffs } : {}), ...(check ? { check } : {}) };
    }),
  }));
}
// The outcome line for an applied change: what was checked, or why it couldn't be put back.
function appliedOutcome(check: ApplyCheck | undefined, undoable: boolean): string {
  const undo = undoable ? '' : ' It is too large to undo from the chat.';
  if (check?.broken?.length) {
    return `Applied, but it broke ${check.broken.map((page) => page.path).join(', ')}, and the files changed again before it could be undone.${undo}`;
  }
  if (check?.pages.length) {
    return `Applied to the shared draft. Checked: ${check.pages.join(', ')} still render${check.pages.length === 1 ? 's' : ''}.${undo}`;
  }
  return `${APPLIED}${undo}`;
}
const APPLIED = 'Applied to the shared draft. Ready to preview.';
const OUTCOMES: Readonly<Record<Direction, string>> = {
  undo: 'Undone. The files are back to how they were before this change.',
  redo: 'Applied again to the shared draft.',
};
export async function applyProposal(id: string, messageId: string, refresh: () => void) {
  const thread = chatState().threads.find((thread) => thread.id === id);
  const proposal = thread?.messages.find((message) => message.id === messageId)?.proposal;
  if (!proposal || thread?.status !== 'idle') {
    return;
  }
  updateChat(id, (chat) => ({ ...chat, status: 'applying', error: '' }));
  // Taken before the request, while the canvas still shows the page without the change.
  const shotBefore = captureCanvas();
  try {
    const result = record(
      await request('/studio/api/ai/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: proposal.id, ...(proposal.page ? { page: proposal.page } : {}) }),
      }),
    );
    refresh();
    // The check found a page the change broke, and put the files back: the proposal stays, with the errors.
    if (result['applied'] === false) {
      const broken = parseBrokenPages(result['broken']);
      updateChat(id, (chat) => ({
        ...chat,
        messages: chat.messages.map((message) =>
          message.id === messageId && message.proposal ? { ...message, proposal: { ...message.proposal, broken } } : message,
        ),
      }));
      return;
    }
    // The server's pictures when it has a browser, otherwise the person's own (canvasCapture.ts).
    const after = shotBefore && result['thumbnails'] === undefined ? await captureAfterChange(shotBefore) : undefined;
    const thumbnails = result['thumbnails'] ?? (shotBefore && after ? { path: proposal.page ?? 'Canvas', before: shotBefore, after } : undefined);
    const check =
      result['checked'] === undefined && thumbnails === undefined
        ? undefined
        : parseApplyCheck({ pages: result['checked'] ?? [], rendered: result['rendered'] ?? [], broken: result['broken'], thumbnails });
    // A change too large to send back is applied without an undo record.
    const changes = result['changes'];
    const applied = changes === undefined ? undefined : parseApplied({ changes, state: 'applied' });
    finishProposal(id, messageId, appliedOutcome(check, applied !== undefined), 'diffs', applied, check);
  } catch (error) {
    updateChat(id, (chat) => ({
      ...chat,
      error: error instanceof Error ? error.message : 'Could not apply changes.',
    }));
  } finally {
    updateChat(id, (chat) => ({ ...chat, status: 'idle' }));
  }
}

interface ReplyRequest {
  readonly file: string;
  readonly effort: string;
  readonly context: ChatRequestContext;
}
// The reply streams as server-sent events: each step as it happens, then the reply (aiRoutes.ts).
async function generateReply(chat: ChatThread, { file, effort, context: editor }: ReplyRequest, signal: AbortSignal, onStep: (label: string) => void) {
  let reply: unknown;
  await requestEvents(
    '/studio/api/ai/propose',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Up to ten rounds of up to three minutes each (agentTools.ts), plus reads and checks.
      signal: AbortSignal.any([signal, AbortSignal.timeout(2_400_000)]),
      body: JSON.stringify({
        file,
        ...editor,
        model: chat.model,
        ...(effort ? { effort } : {}),
        prompt: chat.draft.trim() || 'Describe these images and how they relate to this page.',
        images: chat.images.length
          ? chat.images
          : ([...chat.messages].reverse().find((message) => message.role === 'user' && message.images.length)?.images ?? []),
        history: context(chat),
      }),
    },
    (event, data) => {
      switch (event) {
        case 'step':
          onStep(parseStep(data).label);
          break;
        case 'result':
          reply = data;
          break;
        case 'error':
          throw new Error(string(record(data)['error'], 2000));
        default:
          break; // Events a newer server adds are ignored.
      }
    },
  );
  if (reply === undefined) {
    throw new Error('The reply ended before it was complete. Try again.');
  }
  return { proposal: parseProposal(reply), record: parseReplyRecord(record(reply)) };
}

/** The applied changes of the replies after a message, newest first: what "edit from here" undoes. */
export function changesAfter(chat: ChatThread, messageId: string): readonly AppliedChange['changes'][] {
  const index = chat.messages.findIndex((message) => message.id === messageId);
  return chat.messages
    .slice(index + 1)
    .flatMap((message) => (message.applied?.state === 'applied' ? [message.applied.changes] : []))
    .reverse();
}

/**
 * Go back to a message to change it: undo the applied changes of every later reply (all or nothing),
 * remove the message and the replies after it, and put its text and images back in the composer.
 * A chat that is working refuses: the reply would land after the messages are gone.
 */
export async function editFromMessage(id: string, messageId: string, refresh: () => void) {
  const thread = chatState().threads.find((thread) => thread.id === id);
  const index = thread?.messages.findIndex((message) => message.id === messageId) ?? -1;
  const message = thread?.messages[index];
  if (!thread || !message || message.role !== 'user' || thread.status !== 'idle') {
    return;
  }
  const sets = changesAfter(thread, messageId);
  if (sets.length) {
    updateChat(id, (chat) => ({ ...chat, status: 'applying', error: '' }));
    try {
      const result = record(
        await request('/studio/api/ai/undo-series', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sets }) }),
      );
      if (result['reverted'] !== true) {
        updateChat(id, (chat) => ({ ...chat, error: conflictMessage('undo', result['conflicts']) }));
        return;
      }
      refresh();
    } catch (error) {
      updateChat(id, (chat) => ({ ...chat, error: error instanceof Error ? error.message : 'Could not undo the changes.' }));
      return;
    } finally {
      updateChat(id, (chat) => ({ ...chat, status: 'idle' }));
    }
  }
  updateChat(id, (chat) => ({ ...chat, messages: chat.messages.slice(0, index), draft: message.content, images: message.images, error: '' }));
}

/** Undo an applied change, or redo an undone one. A conflict in any file changes nothing. */
export async function revertChange(id: string, messageId: string, direction: Direction, refresh: () => void) {
  const thread = chatState().threads.find((thread) => thread.id === id);
  const applied = thread?.messages.find((message) => message.id === messageId)?.applied;
  if (!applied || thread?.status !== 'idle' || applied.state !== (direction === 'undo' ? 'applied' : 'undone')) {
    return;
  }
  updateChat(id, (chat) => ({ ...chat, status: 'applying', error: '' }));
  try {
    const result = record(
      await request('/studio/api/ai/revert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ direction, changes: applied.changes }),
      }),
    );
    if (result['reverted'] === true) {
      const state = direction === 'undo' ? 'undone' : 'applied';
      updateChat(id, (chat) => ({
        ...chat,
        messages: chat.messages.map((message) =>
          message.id === messageId ? { ...message, outcome: OUTCOMES[direction], applied: { ...applied, state } } : message,
        ),
      }));
      refresh();
    } else {
      updateChat(id, (chat) => ({ ...chat, error: conflictMessage(direction, result['conflicts']) }));
    }
  } catch (error) {
    updateChat(id, (chat) => ({ ...chat, error: error instanceof Error ? error.message : `Could not ${direction} the change.` }));
  } finally {
    updateChat(id, (chat) => ({ ...chat, status: 'idle' }));
  }
}
function conflictMessage(direction: Direction, conflicts: unknown): string {
  const files = Array.isArray(conflicts) ? conflicts.filter((file): file is string => typeof file === 'string').slice(0, 5) : [];
  const names = files.map((file) => file.replace(/^src\//, '')).join(', ');
  return `Can't ${direction}: ${names || 'a file'} changed since. Nothing was changed.`;
}
