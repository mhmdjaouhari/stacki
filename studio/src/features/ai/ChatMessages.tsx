import { ErrorToast } from '../../../vendor/stacki/src/ui/ErrorToast';
import { ChatText } from './ChatText';
import { useEffect, useRef, useState } from 'react';
import { applyProposal, changesAfter, discardProposal, editFromMessage, revertChange } from './chatActions';
import { updateChat, type ApplyCheck, type BrokenPage, type ChatThread, type ChatMessage, type ProposalProblem } from './chatState';
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
      {chat.status !== 'idle' && <WorkingStatus chat={chat} />}
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

// The step the reply is on, and how long it has run: a reasoning model can think for minutes,
// and a moving label and clock say it is still working.
function WorkingStatus({ chat }: { readonly chat: ChatThread }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  if (chat.status === 'applying') {
    return (
      <div className="chat-working" role="status">
        <span />
        Applying changes to the draft…
      </div>
    );
  }
  const progress = chat.progress;
  return (
    <div className="chat-working" role="status">
      <span />
      <span className="chat-working-label">{progress ? `${progress.label}…` : 'Thinking through your request…'}</span>
      {progress && <span className="chat-working-time">{formatDuration(now - progress.startedAt)}</span>}
    </div>
  );
}

function formatDuration(durationMs: number): string {
  const seconds = Math.max(0, Math.round(durationMs / 1000));
  return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}

// Under a reply: the model, effort and time it took, and the steps it went through, collapsed.
function ReplyDetails({ message }: { readonly message: ChatMessage }) {
  const { meta, steps } = message;
  if (!meta && !steps?.length) {
    return null;
  }
  const summary = meta ? [meta.model, meta.effort, formatDuration(meta.durationMs)].filter(Boolean).join(' · ') : '';
  return (
    <details className="chat-reply-details">
      <summary>
        {summary}
        {steps?.length ? `${summary ? ' · ' : ''}${steps.length} step${steps.length === 1 ? '' : 's'}` : ''}
      </summary>
      {steps?.length ? (
        <ol>
          {steps.map((step, index) => (
            <li key={index}>
              <span>{formatDuration(step.atMs)}</span>
              {step.label}
            </li>
          ))}
        </ol>
      ) : null}
    </details>
  );
}

// "Edit" on a message of yours: it goes back into the composer, and the replies after it are removed,
// with the changes they applied undone. It asks first, saying how many changes that undoes.
function EditFromHere({ chat, message, refresh }: ItemProps) {
  const [confirming, setConfirming] = useState(false);
  const isLast = chat.messages.at(-1)?.id === message.id;
  if (isLast && chat.status === 'idle') {
    return null; // Nothing follows it: the up arrow in the composer recalls it instead.
  }
  const changes = changesAfter(chat, message.id).length;
  const idle = chat.status === 'idle';
  if (!confirming) {
    return (
      <button
        className="chat-edit-message"
        disabled={!idle}
        title={idle ? 'Edit this message and send it again' : 'Wait for the reply, or stop it, before going back'}
        onClick={() => setConfirming(true)}
      >
        Edit
      </button>
    );
  }
  return (
    <div className="chat-edit-confirm" role="alertdialog" aria-label="Edit from here">
      <span>
        {changes
          ? `Undo ${changes} applied change${changes === 1 ? '' : 's'} and edit this message? The replies after it are removed.`
          : 'Edit this message? The replies after it are removed.'}
      </span>
      <button
        disabled={!idle}
        onClick={() => {
          setConfirming(false);
          void editFromMessage(chat.id, message.id, refresh);
        }}
      >
        {changes ? 'Undo and edit' : 'Edit'}
      </button>
      <button onClick={() => setConfirming(false)}>Cancel</button>
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
      {message.role === 'assistant' && <ReplyDetails message={message} />}
      {message.role === 'user' && <EditFromHere chat={chat} message={message} refresh={refresh} />}
      {message.proposal && review && <ProposalCard chat={chat} message={message} diffs={review.diffs} refresh={refresh} review={openReview} />}
      {message.outcome && <p className="chat-outcome">{message.outcome}</p>}
      {message.diffs && <AppliedDiff diffs={message.diffs} review={openReview} />}
      {message.check?.thumbnails && <BeforeAfter thumbnails={message.check.thumbnails} />}
      {message.check?.rendered.length ? <RenderedChanges check={message.check} /> : null}
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
      {proposal.broken && <BrokenPages chat={chat} broken={proposal.broken} />}
      {proposal.problems && <ProposalProblems problems={proposal.problems} />}
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

// Applying rendered the affected pages, one broke, and the change was put back. The error is the
// model's best clue, so "Ask to fix" writes it into the prompt for the person to send.
function BrokenPages({ chat, broken }: { readonly chat: ChatThread; readonly broken: readonly BrokenPage[] }) {
  return (
    <div className="chat-proposal-problems is-broken" role="alert">
      <strong>Applying this broke the page, so it was undone.</strong>
      <ul>
        {broken.map((page) => (
          <li key={page.path}>
            <code>{page.path}</code> {page.error}
          </li>
        ))}
      </ul>
      <button
        disabled={chat.status !== 'idle'}
        onClick={() => {
          const errors = broken.map((page) => `${page.path}: ${page.error}`).join('\n');
          updateChat(chat.id, (thread) => ({ ...thread, draft: `Applying your change broke the page, so it was undone:\n${errors}\nFix the proposal.` }));
          document.querySelector<HTMLTextAreaElement>('.chat-composer textarea')?.focus();
        }}
      >
        Ask to fix
      </button>
    </div>
  );
}

// The check runs before a proposal reaches the person, and the model gets two rounds to fix
// what it finds; what remains is shown, not hidden. Applying is still allowed: the check reads
// syntax only, and the person may want the change anyway, then fix it or undo it.
function ProposalProblems({ problems }: { readonly problems: readonly ProposalProblem[] }) {
  return (
    <div className="chat-proposal-problems" role="note">
      <strong>The check found problems the model couldn't fix. Applying may break the page.</strong>
      <ul>
        {problems.map((problem, index) => (
          <li key={index}>
            <code>
              {problem.file.replace(/^src\//, '')}
              {problem.line === undefined ? '' : `:${problem.line}`}
            </code>{' '}
            {problem.message}
          </li>
        ))}
      </ul>
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

// The canvas page before and after the change, side by side.
function BeforeAfter({ thumbnails }: { readonly thumbnails: NonNullable<ApplyCheck['thumbnails']> }) {
  return (
    <div className="chat-before-after" aria-label={`${thumbnails.path} before and after the change`}>
      {(['before', 'after'] as const).map((side) => (
        <figure key={side}>
          <img src={thumbnails[side]} alt={`${thumbnails.path} ${side} the change`} />
          <figcaption>{side === 'before' ? 'Before' : 'After'}</figcaption>
        </figure>
      ))}
    </div>
  );
}

// How the rendered pages' text changed: the evidence that the change did what it says.
function RenderedChanges({ check }: { readonly check: ApplyCheck }) {
  return (
    <details className="chat-applied-diff chat-rendered">
      <summary>
        Rendered text{' '}
        <DiffCounts
          {...check.rendered.reduce((total, page) => ({ added: total.added + page.added, removed: total.removed + page.removed }), { added: 0, removed: 0 })}
        />
      </summary>
      {check.rendered.map((page) => (
        <div key={page.path} className="chat-rendered-page">
          <code>{page.path}</code>
          {page.lines.map((line, index) => (
            <div key={index} className={`chat-diff-line ${line.startsWith('+') ? 'is-added' : 'is-removed'}`}>
              <span className="chat-diff-number" data-marker={line.charAt(0)} />
              <code>{line.slice(1)}</code>
            </div>
          ))}
        </div>
      ))}
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
