import { useSyncExternalStore } from 'react';
import { record, string } from '../../shared/validation';
import { parseImages, type ChatImage } from './chatContracts';
import type { ProposedChange } from './agent';
import { parseReversibleChanges, type ReversibleChange } from './reversible';
import { parseFileDiffs, type FileDiff } from './lineDiff';

export interface ChatProposal {
  readonly id: string;
  readonly summary: string;
  readonly changes: readonly ProposedChange[];
  /** Line diffs from the server; proposals saved before diffs existed have none. */
  readonly diffs?: readonly FileDiff[];
  /** What the server's check still found after the model's fix rounds. */
  readonly problems?: readonly ProposalProblem[];
  /** The canvas page when it was asked for: Apply renders it to check the change. */
  readonly page?: string;
  /** Pages the change broke when it was applied, after which it was undone. */
  readonly broken?: readonly BrokenPage[];
}
export interface BrokenPage {
  readonly path: string;
  readonly error: string;
}
/** What the check after applying found: the pages rendered, and how their text changed. */
export interface ApplyCheck {
  readonly pages: readonly string[];
  readonly rendered: readonly { readonly path: string; readonly added: number; readonly removed: number; readonly lines: readonly string[] }[];
  /** Pages that broke but couldn't be put back, because they were edited meanwhile. */
  readonly broken?: readonly BrokenPage[];
  /** Pictures of the canvas page before and after, when the server takes screenshots. */
  readonly thumbnails?: { readonly path: string; readonly before: string; readonly after: string };
}
// A 640×400 PNG thumbnail is at most 200 kB, so about 270,000 characters of base64.
const THUMBNAIL_CHARS_MAX = 280_000;
function thumbnail(value: unknown): string {
  const url = string(value, THUMBNAIL_CHARS_MAX);
  if (!/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(url)) {
    throw new Error('Invalid thumbnail');
  }
  return url;
}
export interface ProposalProblem {
  readonly file: string;
  readonly line?: number;
  readonly message: string;
}
export interface ChatMessage {
  readonly id: string;
  readonly role: 'user' | 'assistant';
  readonly content: string;
  readonly images: readonly ChatImage[];
  readonly proposal?: ChatProposal | undefined;
  readonly outcome?: string;
  /** An applied proposal that the chat can undo, or redo once undone. */
  readonly applied?: AppliedChange;
  /** The applied proposal's diffs, kept so the change can still be read after applying. */
  readonly diffs?: readonly FileDiff[];
  /** How an assistant reply was made: its steps, and the model, effort and time it took. */
  readonly steps?: readonly ReplyStep[];
  readonly meta?: ReplyMeta;
  readonly check?: ApplyCheck;
}
export interface ReplyStep {
  readonly label: string;
  readonly atMs: number;
}
export interface ReplyMeta {
  readonly model: string;
  readonly effort?: string;
  readonly durationMs: number;
}
export interface AppliedChange {
  readonly changes: readonly ReversibleChange[];
  readonly state: 'applied' | 'undone';
}
export interface ChatThread {
  readonly id: string;
  readonly title: string;
  readonly draft: string;
  readonly images: readonly ChatImage[];
  readonly model: string;
  /** Reasoning effort for this chat's model; empty leaves the provider's default. */
  readonly effort: string;
  readonly messages: readonly ChatMessage[];
  readonly status: 'idle' | 'working' | 'applying';
  readonly error: string;
  /** The latest step of the reply in progress; not kept across reloads. */
  readonly progress?: { readonly label: string; readonly startedAt: number };
}
interface ChatState {
  readonly threads: readonly ChatThread[];
  readonly active: string;
  readonly notice: string;
  readonly ready: boolean;
}
export function newThread(model = ''): ChatThread {
  return {
    id: crypto.randomUUID(),
    title: 'New chat',
    draft: '',
    images: [],
    model,
    effort: '',
    messages: [],
    status: 'idle',
    error: '',
  };
}
const first = newThread();
let state: ChatState = { threads: [first], active: first.id, notice: '', ready: false };
const listeners = new Set<() => void>();
let database: IDBDatabase | undefined;
let initialized = false;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
function emit() {
  listeners.forEach((listener) => listener());
}
export function chatState() {
  return state;
}
export function useChats() {
  return useSyncExternalStore((listener) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, chatState);
}
export function updateChat(id: string, update: (chat: ChatThread) => ChatThread) {
  commit({
    ...state,
    threads: state.threads.map((chat) => (chat.id === id ? update(chat) : chat)),
  });
}
export function selectChat(id: string) {
  commit({ ...state, active: id });
}
export function createChat(model: string) {
  if (state.threads.length >= 20) {
    return;
  }
  const chat = newThread(model);
  commit({ ...state, threads: [...state.threads, chat], active: chat.id });
}
export function deleteChat(id: string) {
  const remaining = state.threads.filter((chat) => chat.id !== id);
  const threads = remaining.length ? remaining : [newThread()];
  commit({
    ...state,
    threads,
    active: state.active === id ? (threads[0]?.id ?? '') : state.active,
  });
}
function commit(next: ChatState) {
  state = next;
  emit();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 150);
}
function save() {
  if (!database) {
    return;
  }
  try {
    const transaction = database.transaction('chats', 'readwrite');
    transaction.objectStore('chats').put({ threads: state.threads, active: state.active }, 'session');
    transaction.onerror = storageError;
  } catch {
    storageError();
  }
}
function storageError() {
  state = {
    ...state,
    ready: true,
    notice: 'Chat history could not be saved on this device. Keep this tab open.',
  };
  emit();
}
export function initializeChats() {
  if (initialized) {
    return;
  }
  initialized = true;
  try {
    const open = indexedDB.open('studio-ai-chats', 1);
    open.onupgradeneeded = () => {
      open.result.createObjectStore('chats');
    };
    open.onerror = storageError;
    open.onsuccess = () => {
      database = open.result;
      const read = database.transaction('chats').objectStore('chats').get('session');
      read.onerror = storageError;
      read.onsuccess = () => {
        try {
          const value: unknown = read.result;
          if (value) {
            restore(value);
          }
          state = { ...state, ready: true };
          emit();
        } catch {
          storageError();
        }
      };
    };
  } catch {
    storageError();
  }
}
function restore(value: unknown) {
  const input = record(value);
  const raw = input['threads'];
  if (!Array.isArray(raw) || !raw.length || raw.length > 20) {
    throw new Error('Invalid chats');
  }
  const threads = raw.map(parseThread);
  const active = string(input['active'], 100);
  state = {
    ...state,
    threads,
    active: threads.some((chat) => chat.id === active) ? active : (threads[0]?.id ?? ''),
  };
}
function parseThread(value: unknown): ChatThread {
  const chat = record(value);
  const messages = chat['messages'];
  if (!Array.isArray(messages) || messages.length > 40) {
    throw new Error('Invalid messages');
  }
  return {
    id: string(chat['id'], 100),
    title: string(chat['title'], 100),
    draft: string(chat['draft'], 12_000),
    images: parseImages(chat['images']),
    model: string(chat['model'], 160),
    // Chats saved before efforts existed have none.
    effort: chat['effort'] === undefined ? '' : string(chat['effort'], 16),
    messages: messages.map(parseMessage),
    status: 'idle',
    error: chat['status'] === 'idle' ? '' : 'This request was interrupted by a reload. Check the draft before retrying.',
  };
}
function parseMessage(value: unknown): ChatMessage {
  const message = record(value);
  const role = message['role'];
  if (role !== 'user' && role !== 'assistant') {
    throw new Error('Invalid role');
  }
  return {
    id: string(message['id'], 100),
    role,
    content: string(message['content'], 12_000),
    images: parseImages(message['images']),
    ...(message['proposal'] ? { proposal: parseProposal(message['proposal']) } : {}),
    ...(message['outcome'] ? { outcome: string(message['outcome'], 300) } : {}),
    ...(message['applied'] ? { applied: parseApplied(message['applied']) } : {}),
    ...(message['diffs'] ? { diffs: parseFileDiffs(message['diffs']) } : {}),
    ...parseReplyRecord(message),
    ...(message['check'] === undefined ? {} : { check: parseApplyCheck(message['check']) }),
  };
}
export function parseBrokenPages(value: unknown): readonly BrokenPage[] {
  if (!Array.isArray(value) || value.length > 5) {
    throw new Error('Invalid check');
  }
  return value.map((item: unknown) => {
    const page = record(item);
    return { path: string(page['path'], 2000), error: string(page['error'], 700) };
  });
}
export function parseApplyCheck(value: unknown): ApplyCheck {
  const input = record(value);
  const pages = input['pages'];
  const rendered = input['rendered'];
  if (!Array.isArray(pages) || pages.length > 5 || !Array.isArray(rendered) || rendered.length > 5) {
    throw new Error('Invalid check');
  }
  return {
    pages: pages.map((page) => string(page, 2000)),
    rendered: rendered.map((item: unknown) => {
      const change = record(item);
      const lines = change['lines'];
      const added = change['added'];
      const removed = change['removed'];
      if (!Array.isArray(lines) || lines.length > 60 || typeof added !== 'number' || typeof removed !== 'number') {
        throw new Error('Invalid check');
      }
      return { path: string(change['path'], 2000), added, removed, lines: lines.map((line) => string(line, 400)) };
    }),
    ...(input['broken'] === undefined ? {} : { broken: parseBrokenPages(input['broken']) }),
    ...(input['thumbnails'] === undefined ? {} : { thumbnails: parseThumbnails(input['thumbnails']) }),
  };
}
function parseThumbnails(value: unknown): NonNullable<ApplyCheck['thumbnails']> {
  const input = record(value);
  return { path: string(input['path'], 2000), before: thumbnail(input['before']), after: thumbnail(input['after']) };
}
/** The steps and metadata a reply carries, when it carries them (older servers and chats don't). */
export function parseReplyRecord(input: Record<string, unknown>): Pick<ChatMessage, 'steps' | 'meta'> {
  const steps = input['steps'];
  const meta = input['meta'];
  if (steps !== undefined && (!Array.isArray(steps) || steps.length > 60)) {
    throw new Error('Invalid reply steps');
  }
  return {
    ...(Array.isArray(steps) ? { steps: steps.map(parseStep) } : {}),
    ...(meta === undefined ? {} : { meta: parseMeta(meta) }),
  };
}
export function parseStep(value: unknown): ReplyStep {
  const step = record(value);
  const atMs = step['atMs'];
  if (typeof atMs !== 'number' || !Number.isSafeInteger(atMs) || atMs < 0) {
    throw new Error('Invalid reply step');
  }
  return { label: string(step['label'], 200), atMs };
}
function parseMeta(value: unknown): ReplyMeta {
  const meta = record(value);
  const durationMs = meta['durationMs'];
  if (typeof durationMs !== 'number' || !Number.isSafeInteger(durationMs) || durationMs < 0) {
    throw new Error('Invalid reply metadata');
  }
  return { model: string(meta['model'], 160), ...(meta['effort'] === undefined ? {} : { effort: string(meta['effort'], 16) }), durationMs };
}
export function parseApplied(value: unknown): AppliedChange {
  const input = record(value);
  const state = input['state'];
  if (state !== 'applied' && state !== 'undone') {
    throw new Error('Invalid applied change');
  }
  return { changes: parseReversibleChanges(input['changes']), state };
}
export function parseProposal(value: unknown): ChatProposal {
  const input = record(value);
  const changes = input['changes'];
  if (!Array.isArray(changes) || changes.length > 20) {
    throw new Error('Invalid proposal');
  }
  return {
    id: string(input['id'], 100),
    summary: string(input['summary'], 4000),
    changes: changes.map((value) => {
      const change = record(value);
      return {
        file: string(change['file'], 500),
        before: string(change['before']),
        after: string(change['after']),
      };
    }),
    ...(input['diffs'] === undefined ? {} : { diffs: parseFileDiffs(input['diffs']) }),
    ...(input['problems'] === undefined ? {} : { problems: parseProblems(input['problems']) }),
    ...(input['page'] === undefined ? {} : { page: string(input['page'], 2000) }),
    ...(input['broken'] === undefined ? {} : { broken: parseBrokenPages(input['broken']) }),
  };
}
function parseProblems(value: unknown): readonly ProposalProblem[] {
  if (!Array.isArray(value) || value.length > 20) {
    throw new Error('Invalid proposal');
  }
  return value.map((item: unknown) => {
    const problem = record(item);
    const line = problem['line'];
    if (line !== undefined && (typeof line !== 'number' || !Number.isSafeInteger(line) || line < 1)) {
      throw new Error('Invalid proposal');
    }
    return { file: string(problem['file'], 500), ...(line === undefined ? {} : { line }), message: string(problem['message'], 300) };
  });
}
