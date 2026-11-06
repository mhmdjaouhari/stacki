import { ErrorToast } from '../../../vendor/stacki/src/ui/ErrorToast';
import { ChatText } from './ChatText';
import { useEffect, useRef, useState } from 'react';
import { applyProposal, discardProposal, revertChange } from './chatActions';
import { type ChatThread, type ChatMessage } from './chatState';
import { ChatIcon } from './ChatIcon';
import { ChatDiff, DiffCounts, diffTotals, substringDiffs } from './ChatDiff';
import type { FileDiff } from './lineDiff';

export function ChatMessages({ chat, refresh }: { readonly chat: ChatThread; readonly refresh: () => void }) {
  const scroll = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const [unread, setUnread] = useState(false);
  useEffect(() => {
    if (follow.current) {
      scroll.current?.scrollTo({ top: scroll.current.scrollHeight });
    } else {
      setUnread(true);
    }
  }, [chat.messages, chat.status]);
  return (
    <div
      className="chat-transcript"
      ref={scroll}
      role="log"
      aria-label="Conversation"
      aria-live="polite"
      onScroll={(event) => {
        const element = event.currentTarget;
        follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
        if (follow.current) {
          setUnread(false);
        }
      }}
    >
      {chat.messages.map((message) => (
        <MessageItem key={message.id} chat={chat} message={message} refresh={refresh} />
      ))}
      {chat.status !== 'idle' && (
        <div className="chat-working" role="status">
          <span />
          {chat.status === 'working' ? 'Thinking through your request…' : 'Applying changes to the draft…'}
        </div>
      )}
      {chat.error && <ErrorToast message={chat.error} />}
      {unread && (
        <button
          className="chat-latest"
          onClick={() => {
            scroll.current?.scrollTo({ top: scroll.current.scrollHeight, behavior: 'smooth' });
            follow.current = true;
            setUnread(false);
          }}
        >
          ↓ Latest response
        </button>
      )}
    </div>
  );
}
function ProposalCard({ chat, message, refresh }: { readonly chat: ChatThread; readonly message: ChatMessage; readonly refresh: () => void }) {
  const proposal = message.proposal;
  if (!proposal) {
    return null;
  }
  const diffs = proposal.diffs ?? substringDiffs(proposal.changes);
  const blocked = diffs.some((diff) => diff.kind === 'failed');
  return (
    <div className="chat-proposal">
      <div className="chat-proposal-title">
        <ChatIcon name="file" />
        {proposal.changes.length} file{proposal.changes.length === 1 ? '' : 's'} changed
        <DiffCounts {...diffTotals(diffs)} />
      </div>
      <ChatDiff diffs={diffs} numbers={proposal.diffs ? 'file' : 'none'} />
      <div className="chat-proposal-actions">
        {/* Applying is all or nothing, so a file that can't apply blocks the rest. */}
        <button
          disabled={chat.status !== 'idle' || blocked}
          title={blocked ? 'A file in this proposal can no longer be applied. Ask for it again.' : undefined}
          onClick={() => void applyProposal(chat.id, message.id, refresh)}
        >
          Apply to draft
        </button>
        <button disabled={chat.status !== 'idle'} onClick={() => discardProposal(chat.id, message.id)}>
          Discard
        </button>
      </div>
    </div>
  );
}

function MessageItem({ chat, message, refresh }: { readonly chat: ChatThread; readonly message: ChatMessage; readonly refresh: () => void }) {
  return (
    <article className={`chat-message chat-message-${message.role}`} key={message.id}>
      <span className="chat-message-label">{message.role === 'user' ? 'You' : 'Assistant'}</span>
      {message.images.length > 0 && (
        <div className="chat-message-images">
          {message.images.map((image) => (
            <a key={image.id} href={image.url} download={image.name} title={`Download ${image.name}`}>
              <img src={image.url} alt={image.name} />
            </a>
          ))}
        </div>
      )}
      {message.content && (message.role === 'assistant' ? <ChatText text={message.content} /> : <div className="chat-message-text">{message.content}</div>)}
      {message.proposal && <ProposalCard chat={chat} message={message} refresh={refresh} />}
      {message.outcome && <p className="chat-outcome">{message.outcome}</p>}
      {message.diffs && <AppliedDiff diffs={message.diffs} />}
      {message.applied && <RevertAction chat={chat} message={message} applied={message.applied} refresh={refresh} />}
    </article>
  );
}

// What an applied change did, collapsed to one line until opened.
function AppliedDiff({ diffs }: { readonly diffs: readonly FileDiff[] }) {
  const files = diffs.filter((diff) => diff.kind === 'changed').length;
  return (
    <details className="chat-applied-diff">
      <summary>
        {files} file{files === 1 ? '' : 's'} <DiffCounts {...diffTotals(diffs)} />
      </summary>
      <ChatDiff diffs={diffs} numbers="file" />
    </details>
  );
}

interface RevertProps {
  readonly chat: ChatThread;
  readonly message: ChatMessage;
  readonly applied: NonNullable<ChatMessage['applied']>;
  readonly refresh: () => void;
}
// One button that flips between undo and redo; conflicts leave the files and this state unchanged.
function RevertAction({ chat, message, applied, refresh }: RevertProps) {
  const direction = applied.state === 'applied' ? 'undo' : 'redo';
  return (
    <div className="chat-proposal-actions chat-revert">
      <button disabled={chat.status !== 'idle'} onClick={() => void revertChange(chat.id, message.id, direction, refresh)}>
        {direction === 'undo' ? 'Undo change' : 'Redo change'}
      </button>
    </div>
  );
}
