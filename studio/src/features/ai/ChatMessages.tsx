import { ErrorToast } from '../../../vendor/stacki/src/ui/ErrorToast';
import { ChatText } from './ChatText';
import { useEffect, useRef, useState } from 'react';
import { applyProposal, discardProposal, revertChange } from './chatActions';
import { type ChatThread, type ChatMessage } from './chatState';
import { ChatIcon } from './ChatIcon';
import { ChatDiff, DiffCounts, diffTotals, substringDiffs } from './ChatDiff';
import type { FileDiff } from './lineDiff';
import { ReviewOverlay } from './ReviewOverlay';
import type { ReviewOrigin } from './reviewSources';

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

interface ItemProps {
  readonly chat: ChatThread;
  readonly message: ChatMessage;
  readonly refresh: () => void;
}

function MessageItem({ chat, message, refresh }: ItemProps) {
  const [reviewing, setReviewing] = useState(false);
  const review = reviewOf(message);
  const openReview = () => setReviewing(true);
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
      {message.proposal && review && <ProposalCard chat={chat} message={message} diffs={review.diffs} refresh={refresh} review={openReview} />}
      {message.outcome && <p className="chat-outcome">{message.outcome}</p>}
      {message.diffs && <AppliedDiff diffs={message.diffs} review={openReview} />}
      {message.applied && <RevertAction chat={chat} message={message} applied={message.applied} refresh={refresh} />}
      {/* A discarded proposal leaves nothing to review, which closes the overlay. */}
      {reviewing && review && (
        <ReviewOverlay
          title={review.title}
          diffs={review.diffs}
          origin={review.origin}
          close={() => setReviewing(false)}
          actions={
            message.proposal ? (
              <ProposalActions chat={chat} message={message} diffs={review.diffs} refresh={refresh} />
            ) : (
              message.applied && <RevertAction chat={chat} message={message} applied={message.applied} refresh={refresh} />
            )
          }
        />
      )}
    </article>
  );
}

interface Review {
  readonly title: string;
  readonly diffs: readonly FileDiff[];
  readonly origin: ReviewOrigin | undefined;
}

// What a message's change review shows: a live proposal, or what an applied change did.
function reviewOf(message: ChatMessage): Review | undefined {
  if (message.proposal) {
    return {
      title: 'Proposed changes',
      diffs: message.proposal.diffs ?? substringDiffs(message.proposal.changes),
      origin: { kind: 'proposal', id: message.proposal.id },
    };
  }
  if (message.diffs) {
    const applied = message.applied;
    return {
      title: applied?.state === 'undone' ? 'Undone change' : 'Applied change',
      diffs: message.diffs,
      // A change too large to undo has no record, so only its hunks can be shown.
      origin: applied ? { kind: 'applied', changes: applied.changes, state: applied.state } : undefined,
    };
  }
  return undefined;
}

interface ProposalProps extends ItemProps {
  readonly diffs: readonly FileDiff[];
}

function ProposalCard({ chat, message, diffs, refresh, review }: ProposalProps & { readonly review: () => void }) {
  const proposal = message.proposal;
  if (!proposal) {
    return null;
  }
  return (
    <div className="chat-proposal">
      <div className="chat-proposal-title">
        <ChatIcon name="file" />
        {proposal.changes.length} file{proposal.changes.length === 1 ? '' : 's'} changed
        <DiffCounts {...diffTotals(diffs)} />
      </div>
      <ChatDiff diffs={diffs} numbers={proposal.diffs ? 'file' : 'none'} />
      <div className="chat-proposal-actions">
        <ProposalActions chat={chat} message={message} diffs={diffs} refresh={refresh} />
        <button className="chat-review-open" onClick={review}>
          Review changes
        </button>
      </div>
    </div>
  );
}

function ProposalActions({ chat, message, diffs, refresh }: ProposalProps) {
  // Applying is all or nothing, so a file that can't apply blocks the rest.
  const blocked = diffs.some((diff) => diff.kind === 'failed');
  return (
    <>
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
    </>
  );
}

// What an applied change did, collapsed to one line until opened.
function AppliedDiff({ diffs, review }: { readonly diffs: readonly FileDiff[]; readonly review: () => void }) {
  const files = diffs.filter((diff) => diff.kind === 'changed').length;
  return (
    <div className="chat-applied-change">
      <details className="chat-applied-diff">
        <summary>
          {files} file{files === 1 ? '' : 's'} <DiffCounts {...diffTotals(diffs)} />
        </summary>
        <ChatDiff diffs={diffs} numbers="file" />
      </details>
      <button className="chat-review-open" onClick={review}>
        Review
      </button>
    </div>
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
