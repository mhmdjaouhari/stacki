import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ChatDiff, DiffCounts, diffTotals } from './ChatDiff';
import { MergeDiff, type DiffLayout } from './MergeDiff';
import { loadReviewSources, type ReviewOrigin, type ReviewSources } from './reviewSources';
import { ChatIcon } from './ChatIcon';
import type { FileDiff } from './lineDiff';

// The large view of a change, over the canvas: the changed files on the left
// with their counts, the selected file's whole diff on the right, unified or side
// by side, and the change's own actions (Apply and Discard, or Undo and Redo).
// The chat sidebar is too narrow for any of this, so the overlay sits beside it.

interface ReviewOverlayProps {
  readonly title: string;
  readonly diffs: readonly FileDiff[];
  /** Where whole files come from; undefined when there is no record, and only the hunks can be shown. */
  readonly origin: ReviewOrigin | undefined;
  readonly actions: ReactNode;
  readonly close: () => void;
}

type Loaded =
  { readonly kind: 'loading' } | { readonly kind: 'ready'; readonly sources: ReviewSources } | { readonly kind: 'failed'; readonly message: string };

// Side by side needs room for two columns of code; below this the toggle is hidden.
const SPLIT_WIDTH_MIN_PX = 900;

export function ReviewOverlay({ title, diffs, origin, actions, close }: ReviewOverlayProps) {
  const [selected, setSelected] = useState(() => diffs.find((diff) => diff.kind === 'changed')?.file ?? diffs[0]?.file ?? '');
  const [layout, setLayout] = useState<DiffLayout>('unified');
  const overlay = useRef<HTMLDivElement>(null);
  const left = useSidebarEdge();
  const wide = useWidthAtLeast(overlay, SPLIT_WIDTH_MIN_PX);
  useDialogFocus(overlay, close);
  const diff = diffs.find((candidate) => candidate.file === selected);
  return createPortal(
    <div ref={overlay} className="chat-review" role="dialog" aria-label={title} style={{ left }} tabIndex={-1}>
      <header className="chat-review-header">
        <h2>{title}</h2>
        <DiffCounts {...diffTotals(diffs)} />
        {wide && (
          <div className="chat-review-layout" role="group" aria-label="Diff layout">
            {(['unified', 'split'] as const).map((value) => (
              <button key={value} aria-pressed={layout === value} onClick={() => setLayout(value)}>
                {value === 'unified' ? 'Unified' : 'Side by side'}
              </button>
            ))}
          </div>
        )}
        <button className="chat-icon-button" aria-label="Close review" onClick={close}>
          <ChatIcon name="close" />
        </button>
      </header>
      <div className="chat-review-body">
        <nav className="chat-review-files" aria-label="Changed files">
          {diffs.map((candidate) => (
            <button
              key={candidate.file}
              aria-current={candidate.file === selected ? 'true' : undefined}
              title={candidate.file}
              onClick={() => setSelected(candidate.file)}
            >
              <span className="chat-diff-name">{candidate.file.replace(/^src\//, '')}</span>
              {candidate.kind === 'changed' ? (
                <DiffCounts added={candidate.added} removed={candidate.removed} />
              ) : (
                <span className="chat-diff-failure">Can't apply</span>
              )}
            </button>
          ))}
        </nav>
        <div className="chat-review-diff">{diff && <FileReview diff={diff} origin={origin} layout={wide ? layout : 'unified'} />}</div>
      </div>
      <footer className="chat-review-actions">{actions}</footer>
    </div>,
    document.body,
  );
}

function FileReview({ diff, origin, layout }: { readonly diff: FileDiff; readonly origin: ReviewOrigin | undefined; readonly layout: DiffLayout }) {
  const loaded = useSources(diff, origin);
  if (diff.kind === 'failed') {
    return <p className="chat-review-note">{diff.message}</p>;
  }
  switch (loaded.kind) {
    case 'loading':
      return <p className="chat-review-note">Loading {diff.file}…</p>;
    case 'ready':
      return <MergeDiff file={diff.file} previous={loaded.sources.previous ?? ''} next={loaded.sources.next} layout={layout} />;
    case 'failed':
      // Without the whole file, the hunks the chat already has still show the change.
      return (
        <>
          <p className="chat-review-note">{loaded.message}</p>
          <ChatDiff diffs={[diff]} numbers="file" />
        </>
      );
  }
}

// The file's sources, fetched again when the change is applied, undone or redone, so the
// review never shows a state the files have left.
function useSources(diff: FileDiff, origin: ReviewOrigin | undefined): Loaded {
  const [loaded, setLoaded] = useState<Loaded>({ kind: 'loading' });
  const key = origin ? (origin.kind === 'proposal' ? `proposal:${origin.id}` : `${origin.state}:${origin.changes.length}`) : 'none';
  const current = useRef(origin);
  current.current = origin;
  useEffect(() => {
    const source = current.current;
    if (!source || diff.kind === 'failed') {
      setLoaded({ kind: 'failed', message: 'Only the changed lines are available for this change.' });
      return undefined;
    }
    const controller = new AbortController();
    setLoaded({ kind: 'loading' });
    loadReviewSources(source, diff.file, controller.signal).then(
      (sources) => setLoaded({ kind: 'ready', sources }),
      (error: unknown) => {
        if (!controller.signal.aborted) {
          setLoaded({ kind: 'failed', message: error instanceof Error ? error.message : 'Could not load the file.' });
        }
      },
    );
    return () => controller.abort();
  }, [diff.file, diff.kind, key]);
  return loaded;
}

// The overlay covers the canvas and leaves the chat beside it usable.
function useSidebarEdge(): number {
  const [edge, setEdge] = useState(0);
  useLayoutEffect(() => {
    const measure = () => {
      const sidebar = document.querySelector('.studio-left');
      const right = sidebar ? sidebar.getBoundingClientRect().right : 0;
      // On a phone the sidebar fills the screen; the review takes all of it.
      setEdge(window.innerWidth - right < 360 ? 0 : Math.round(right));
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);
  return edge;
}

function useWidthAtLeast(element: React.RefObject<HTMLElement>, widthMinPx: number): boolean {
  const [wide, setWide] = useState(false);
  useLayoutEffect(() => {
    const target = element.current;
    if (!target) {
      return undefined;
    }
    const observer = new ResizeObserver(() => setWide(target.clientWidth >= widthMinPx));
    observer.observe(target);
    return () => observer.disconnect();
  }, [element, widthMinPx]);
  return wide;
}

// Focus moves into the review and back to what opened it; Escape closes it.
function useDialogFocus(overlay: React.RefObject<HTMLElement>, close: () => void) {
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    overlay.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeRef.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      if (opener?.isConnected) {
        opener.focus();
      }
    };
  }, [overlay]);
}
