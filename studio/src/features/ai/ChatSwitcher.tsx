import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { selectChat, deleteChat, type ChatThread } from './chatState';
import { ChatIcon } from './ChatIcon';

// The chat list is the only switcher: a strip of tabs truncated to a few characters in the narrow
// sidebar and repeated the title above it. What the tabs showed at a glance, a chat working in the
// background, is kept as a dot on the title button.
export function ChatSwitcher({ chats, active }: { readonly chats: readonly ChatThread[]; readonly active: ChatThread }) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const background = chats.filter((chat) => chat.id !== active.id && chat.status !== 'idle').length;
  const close = () => {
    setOpen(false);
    button.current?.focus();
  };
  useInitialFocus(open, list);
  return (
    <div className="chat-switcher">
      <button
        ref={button}
        className="chat-switcher-button"
        aria-label="Chat history"
        aria-expanded={open}
        aria-controls="chat-history"
        title={background ? `${background} other chat${background === 1 ? '' : 's'} working` : undefined}
        onClick={() => setOpen(!open)}
      >
        <ChatIcon name="chat" />
        <span>{active.title}</span>
        {background > 0 && <span className="chat-running-dot" role="status" aria-label="Another chat is working" />}
        <ChatIcon name="chevron" />
      </button>
      {open && (
        <>
          <button className="chat-menu-backdrop" aria-label="Close chat history" tabIndex={-1} onClick={() => setOpen(false)} />
          <div id="chat-history" ref={list} className="chat-history" role="menu" aria-label="Your chats" onKeyDown={(event) => navigateList(event, close)}>
            <div className="chat-history-heading">
              Your chats <span>{chats.length}/20</span>
            </div>
            {[...chats].reverse().map((chat) => (
              <ChatRow key={chat.id} chat={chat} active={active.id} close={close} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
function ChatRow({ chat, active, close }: { readonly chat: ChatThread; readonly active: string; readonly close: () => void }) {
  const [deleting, setDeleting] = useState(false);
  return (
    <div className="chat-history-row">
      <button
        className="chat-history-select"
        role="menuitem"
        aria-current={chat.id === active ? 'page' : undefined}
        onClick={() => {
          selectChat(chat.id);
          close();
        }}
      >
        <span>{chat.title}</span>
        <small>{chat.status === 'idle' ? (chat.messages.length ? `${chat.messages.length} messages` : chat.draft || 'No messages yet') : 'Working…'}</small>
      </button>
      <button className="chat-icon-button" disabled={chat.status !== 'idle'} aria-label={`Delete ${chat.title}`} onClick={() => setDeleting(true)}>
        <ChatIcon name="trash" />
      </button>
      {deleting && (
        <div className="chat-delete-confirm">
          <span>Delete this chat?</span>
          <button
            onClick={() => {
              deleteChat(chat.id);
              setDeleting(false);
            }}
          >
            Delete
          </button>
          <button onClick={() => setDeleting(false)}>Cancel</button>
        </div>
      )}
    </div>
  );
}
// Opening the list moves focus to the current chat, so the arrow keys start from where the person is.
function useInitialFocus(open: boolean, list: RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    if (open) {
      const rows = rowsOf(list.current);
      (rows.find((row) => row.getAttribute('aria-current') === 'page') ?? rows[0])?.focus();
    }
  }, [open, list]);
}
// Up and Down move between chats, Home and End jump to the ends, Escape closes; Enter is the
// focused button's own click. Tab still reaches each row's delete button.
function navigateList(event: KeyboardEvent<HTMLDivElement>, close: () => void) {
  if (event.key === 'Escape') {
    event.preventDefault();
    close();
    return;
  }
  const rows = rowsOf(event.currentTarget);
  if (!rows.length) {
    return;
  }
  const current = rows.findIndex((row) => row === document.activeElement);
  const target = targetIndex(event.key, current, rows.length);
  if (target === undefined) {
    return;
  }
  event.preventDefault();
  rows[target]?.focus();
}
function rowsOf(list: HTMLElement | null): HTMLButtonElement[] {
  return list ? [...list.querySelectorAll<HTMLButtonElement>('.chat-history-select')] : [];
}
function targetIndex(key: string, current: number, count: number): number | undefined {
  if (count < 1) {
    throw new Error('Chat list: expected at least one row');
  }
  switch (key) {
    case 'ArrowDown':
      return current < 0 ? 0 : (current + 1) % count;
    case 'ArrowUp':
      return current < 0 ? count - 1 : (current - 1 + count) % count;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return undefined;
  }
}
