import { request } from '../project/projectClient';
import { chatState, updateChat, parseProposal, parseApplied, type AppliedChange, type ChatThread, type ChatMessage } from './chatState';
import { record } from '../../shared/validation';
import type { Direction } from './reversible';
import type { ChatContext } from './chatContracts';

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
/** `effort` is the chat's effort when its model supports it, otherwise empty. */
export async function sendChat(id: string, file: string, effort: string) {
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
    const proposal = await generateReply(chat, file, effort, controller.signal);
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
          ...(proposal.changes.length ? { proposal } : {}),
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
    updateChat(id, (thread) => ({ ...thread, status: 'idle' }));
  }
}
export function stopChat(id: string) {
  running.get(id)?.abort();
}
export function discardProposal(id: string, messageId: string) {
  finishProposal(id, messageId, 'Discarded. No changes were applied.', 'nothing');
}
// A discarded proposal leaves only its outcome; an applied one keeps its diffs, so the change can still be read.
function finishProposal(id: string, messageId: string, outcome: string, kept: 'nothing' | 'diffs', applied?: AppliedChange) {
  updateChat(id, (thread) => ({
    ...thread,
    messages: thread.messages.map((message) => {
      if (message.id !== messageId) {
        return message;
      }
      const { proposal, ...rest } = message;
      const diffs = kept === 'diffs' ? proposal?.diffs : undefined;
      return { ...rest, outcome, ...(applied ? { applied } : {}), ...(diffs ? { diffs } : {}) };
    }),
  }));
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
  try {
    const result = record(
      await request('/studio/api/ai/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: proposal.id }),
      }),
    );
    // A change too large to send back is applied without an undo record.
    const changes = result['changes'];
    if (changes === undefined) {
      finishProposal(id, messageId, `${APPLIED} It is too large to undo from the chat.`, 'diffs');
    } else {
      finishProposal(id, messageId, APPLIED, 'diffs', parseApplied({ changes, state: 'applied' }));
    }
    refresh();
  } catch (error) {
    updateChat(id, (chat) => ({
      ...chat,
      error: error instanceof Error ? error.message : 'Could not apply changes.',
    }));
  } finally {
    updateChat(id, (chat) => ({ ...chat, status: 'idle' }));
  }
}

async function generateReply(chat: ChatThread, file: string, effort: string, signal: AbortSignal) {
  return parseProposal(
    await request('/studio/api/ai/propose', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Up to six completions of up to three minutes each (agent.ts), plus file reads.
      signal: AbortSignal.any([signal, AbortSignal.timeout(1_200_000)]),
      body: JSON.stringify({
        file,
        model: chat.model,
        ...(effort ? { effort } : {}),
        prompt: chat.draft.trim() || 'Describe these images and how they relate to this page.',
        images: chat.images.length
          ? chat.images
          : ([...chat.messages].reverse().find((message) => message.role === 'user' && message.images.length)?.images ?? []),
        history: context(chat),
      }),
    }),
  );
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
