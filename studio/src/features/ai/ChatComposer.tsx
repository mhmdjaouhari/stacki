import { ErrorToast } from '../../../vendor/stacki/src/ui/ErrorToast';
import { useRef, useState } from 'react';
import { ChatIcon } from './ChatIcon';
import { useChatAttachments } from './useChatAttachments';
import { updateChat, type ChatThread } from './chatState';
import { useDictation } from './useDictation';
import { sendChat, stopChat } from './chatActions';
import { effortLevels, type ModelConfiguration } from './chatContracts';
import type { ChatRequestContext } from './chatRequestContext';
import { insertMention, mentionOptions, mentionQuery } from './mentions';
import { startCanvasCapture, stopCanvasCapture, useCanvasCapture } from './canvasCapture';

interface ComposerProps {
  readonly chat: ChatThread;
  readonly file: string;
  readonly context: ChatRequestContext;
  readonly config: ModelConfiguration;
  readonly mentionable: readonly string[];
}
export function ChatComposer({ chat, file, context, config, mentionable }: ComposerProps) {
  const sharing = useCanvasCapture();
  const { loading, attach } = useChatAttachments(chat.id);
  const [dragging, setDragging] = useState(false);
  const voice = useDictation((text) =>
    updateChat(chat.id, (thread) => ({
      ...thread,
      draft: `${thread.draft}${thread.draft ? ' ' : ''}${text}`.slice(0, 12_000),
    })),
  );
  return (
    <div className="chat-compose-area">
      <div className="chat-context" title={file}>
        <ChatIcon name="file" />
        <span>{file.replace(/^src\//, '')}</span>
        {context.selection && (
          <span className="chat-selection-label" title="The selected element is sent with your message">
            {context.selection.label}
          </span>
        )}
        <span className="chat-draft-label">Draft</span>
      </div>
      <form
        className={`chat-composer ${dragging ? 'is-dragging' : ''}`}
        onSubmit={(event) => {
          event.preventDefault();
          if (!loading && !voice.listening && config.models.includes(chat.model)) {
            void sendChat(chat.id, file, supportedEffort(config, chat), context, { canvasPicture: sharing && config.vision.includes(chat.model) });
          }
        }}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          void attach([...event.dataTransfer.files]);
        }}
        onPaste={(event) => {
          const files = [...event.clipboardData.files];
          if (files.length) {
            event.preventDefault();
            void attach(files);
          }
        }}
      >
        <AttachmentStrip chat={chat} />
        <PromptInput chat={chat} dragging={dragging} mentionable={mentionable} />
        <ComposerTools chat={chat} config={config} voice={voice} loading={loading} attach={attach} />
      </form>
      <ErrorToast message={voice.error} />
      <div className="chat-composer-hint" role="status">
        {voice.listening
          ? voice.interim || 'Listening… click the microphone to finish'
          : loading
            ? 'Preparing images…'
            : 'Enter to send · Shift + Enter for a new line'}
      </div>
    </div>
  );
}
function AttachmentStrip({ chat }: { readonly chat: ChatThread }) {
  return (
    <div className="chat-attachments">
      {chat.images.map((image) => (
        <div className="chat-attachment" key={image.id}>
          <img src={image.url} alt={image.name} />
          <button
            type="button"
            aria-label={`Remove ${image.name}`}
            onClick={() =>
              updateChat(chat.id, (thread) => ({
                ...thread,
                images: thread.images.filter((item) => item.id !== image.id),
              }))
            }
          >
            <ChatIcon name="close" />
          </button>
        </div>
      ))}
    </div>
  );
}

interface PromptProps {
  readonly chat: ChatThread;
  readonly dragging: boolean;
  /** Project files `@` can attach. */
  readonly mentionable: readonly string[];
}

function PromptInput({ chat, dragging, mentionable }: PromptProps) {
  const field = useRef<HTMLTextAreaElement>(null);
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  // Escape closes the list for the mention it was open on; typing another `@` opens it again.
  const [dismissed, setDismissed] = useState(-1);
  const patch = (draft: string) => updateChat(chat.id, (thread) => ({ ...thread, draft }));
  const query = mentionQuery(chat.draft, caret);
  const options = query && query.start !== dismissed ? mentionOptions(mentionable, query.text) : [];
  const choose = (file: string) => {
    if (!query) {
      return;
    }
    const next = insertMention(chat.draft, query, file);
    patch(next.draft);
    setCaret(next.caret);
    requestAnimationFrame(() => field.current?.setSelectionRange(next.caret, next.caret));
  };
  return (
    <div className="chat-prompt">
      {options.length > 0 && (
        <ul className="chat-mentions" role="listbox" aria-label="Attach a file">
          {options.map((file, index) => (
            <li
              key={file}
              role="option"
              aria-selected={index === Math.min(active, options.length - 1)}
              onMouseDown={(event) => {
                event.preventDefault(); // Keeps the focus, and the caret, in the prompt.
                choose(file);
              }}
            >
              {file.replace(/^src\//, '')}
            </li>
          ))}
        </ul>
      )}
      <textarea
        ref={field}
        autoFocus
        aria-label="AI prompt"
        placeholder={dragging ? 'Drop images here' : 'Ask anything, describe a change, or @ a file…'}
        rows={3}
        maxLength={12_000}
        value={chat.draft}
        onChange={(event) => {
          patch(event.target.value);
          setCaret(event.target.selectionStart);
          setActive(0);
        }}
        onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
        onKeyDown={(event) =>
          promptKey(event, {
            chat,
            options,
            active: Math.min(active, options.length - 1),
            setActive,
            choose,
            dismiss: () => setDismissed(query?.start ?? -1),
            patch,
          })
        }
      />
    </div>
  );
}

interface KeyContext {
  readonly chat: ChatThread;
  readonly options: readonly string[];
  readonly active: number;
  readonly setActive: (index: number) => void;
  readonly choose: (file: string) => void;
  readonly dismiss: () => void;
  readonly patch: (draft: string) => void;
}

// With the mention list open, the arrows move through it, Enter or Tab attaches, Escape closes.
// Otherwise Enter sends, and the up arrow in an empty prompt recalls your last message.
function promptKey(event: React.KeyboardEvent<HTMLTextAreaElement>, context: KeyContext) {
  const { chat, options, active } = context;
  if (event.nativeEvent.isComposing) {
    return;
  }
  if (options.length) {
    const moves: Readonly<Record<string, number>> = { ArrowDown: 1, ArrowUp: -1 };
    const move = moves[event.key];
    if (move !== undefined) {
      event.preventDefault();
      context.setActive((active + move + options.length) % options.length);
    } else if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault();
      context.choose(options[active] ?? options[0] ?? '');
    } else if (event.key === 'Escape') {
      event.preventDefault();
      context.dismiss();
    }
    return;
  }
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  } else if (event.key === 'ArrowUp' && !chat.draft) {
    const last = [...chat.messages].reverse().find((message) => message.role === 'user')?.content;
    if (last) {
      event.preventDefault();
      context.patch(last);
    }
  }
}

interface ToolsProps {
  readonly chat: ChatThread;
  readonly config: ModelConfiguration;
  readonly voice: ReturnType<typeof useDictation>;
  readonly loading: boolean;
  readonly attach: (files: readonly File[]) => Promise<void>;
}
function ComposerTools({ chat, config, voice, loading, attach }: ToolsProps) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className="chat-composer-tools">
      <input
        ref={input}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        multiple
        hidden
        aria-label="Attach image files"
        onChange={(event) => {
          void attach([...(event.target.files ?? [])]);
          event.target.value = '';
        }}
      />
      <button
        type="button"
        className="chat-icon-button"
        aria-label="Attach images"
        title="Attach images, or paste / drop them here"
        disabled={loading || chat.images.length >= 4}
        onClick={() => input.current?.click()}
      >
        <ChatIcon name="plus" />
      </button>
      <ModelPicker chat={chat} config={config} />
      <EffortPicker chat={chat} config={config} />
      <button
        type="button"
        className={`chat-icon-button ${voice.listening ? 'is-listening' : ''}`}
        aria-label={voice.listening ? 'Stop dictation' : 'Voice input'}
        aria-pressed={voice.listening}
        title={voice.supported ? 'Dictate a message' : 'Voice input is unavailable in this browser'}
        onClick={voice.toggle}
      >
        <ChatIcon name="mic" />
      </button>
      <CaptureToggle chat={chat} vision={config.vision.includes(chat.model)} />
      <SendButton chat={chat} disabled={loading || voice.listening || !config.models.includes(chat.model)} />
    </div>
  );
}

// Before/after pictures on Apply, from this tab shared with itself (canvasCapture.ts). Turning it on
// asks the browser for permission; its own "Stop sharing" turns it off too.
// With a vision model, the same stream also sends the canvas to the model with each message.
function CaptureToggle({ chat, vision }: { readonly chat: ChatThread; readonly vision: boolean }) {
  const active = useCanvasCapture();
  const purpose = vision ? 'the model sees the canvas with each message, and Apply shows it before and after' : 'Apply shows the canvas before and after';
  return (
    <button
      type="button"
      className={`chat-icon-button ${active ? 'is-capturing' : ''}`}
      aria-label={active ? 'Stop before and after pictures' : 'Take before and after pictures'}
      aria-pressed={active}
      title={active ? `Sharing this tab: ${purpose}. Click to stop.` : `Share this tab with Studio: ${purpose}.`}
      onClick={() => {
        if (active) {
          stopCanvasCapture();
          return;
        }
        startCanvasCapture().catch((error: unknown) => {
          // Dismissing the browser's prompt is a choice, not an error.
          if (!(error instanceof DOMException && error.name === 'NotAllowedError')) {
            updateChat(chat.id, (thread) => ({ ...thread, error: error instanceof Error ? error.message : 'Could not share this tab.' }));
          }
        });
      }}
    >
      <ChatIcon name="camera" />
    </button>
  );
}

function ModelPicker({ chat, config }: Pick<ToolsProps, 'chat' | 'config'>) {
  return (
    <label className="chat-model">
      <select
        aria-label="Choose model"
        value={chat.model}
        disabled={chat.status !== 'idle' || !config.models.length}
        onChange={(event) => {
          const model = event.target.value;
          // An effort the new model doesn't list would be rejected, so it falls back to the default.
          updateChat(chat.id, (thread) => ({ ...thread, model, effort: effortLevels(config, model).includes(thread.effort) ? thread.effort : '' }));
        }}
      >
        {!config.models.includes(chat.model) && <option value={chat.model}>{chat.model || 'No model connected'}</option>}
        {config.models.map((model) => (
          <option key={model} value={model}>
            {model}
          </option>
        ))}
      </select>
      <ChatIcon name="chevron" />
    </label>
  );
}

function supportedEffort(config: ModelConfiguration, chat: ChatThread): string {
  return effortLevels(config, chat.model).includes(chat.effort) ? chat.effort : '';
}

// Shown only for models with configured levels; "Default" sends no effort, so the provider decides.
function EffortPicker({ chat, config }: Pick<ToolsProps, 'chat' | 'config'>) {
  const levels = effortLevels(config, chat.model);
  if (!levels.length) {
    return null;
  }
  return (
    <label className="chat-model chat-effort" title="Reasoning effort">
      <select
        aria-label="Choose effort"
        value={supportedEffort(config, chat)}
        disabled={chat.status !== 'idle'}
        onChange={(event) => updateChat(chat.id, (thread) => ({ ...thread, effort: event.target.value }))}
      >
        <option value="">Default effort</option>
        {levels.map((level) => (
          <option key={level} value={level}>
            {level} effort
          </option>
        ))}
      </select>
      <ChatIcon name="chevron" />
    </label>
  );
}

function SendButton({ chat, disabled }: { readonly chat: ChatThread; readonly disabled: boolean }) {
  return chat.status === 'working' ? (
    <button type="button" className="chat-send" aria-label="Stop response" onClick={() => stopChat(chat.id)}>
      <ChatIcon name="stop" />
    </button>
  ) : (
    <button
      type="submit"
      className="chat-send"
      aria-label="Send message"
      disabled={disabled || chat.status !== 'idle' || (!chat.draft.trim() && !chat.images.length)}
    >
      <ChatIcon name="send" />
    </button>
  );
}
