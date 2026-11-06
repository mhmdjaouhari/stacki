import { useEffect, useRef } from 'react';
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView, lineNumbers } from '@codemirror/view';
import { MergeView, unifiedMergeView } from '@codemirror/merge';
import { appHighlight, appTheme, codeEditorLanguage } from '../../../vendor/stacki/src/ui/CodeEditor';
import { languageFor } from '../../../vendor/stacki/src/features/git/Code';

// A whole file's change in CodeMirror's merge view, read-only, with the code
// editor's own theme and highlighting. Unchanged stretches collapse to a bar that
// expands on click, so a long file reads as its changes with their context.
// `@codemirror/merge` is the one dependency the chat adds: it reuses the
// CodeMirror packages Studio already ships (studio/docs/architecture.md).

export type DiffLayout = 'unified' | 'split';

interface MergeDiffProps {
  readonly file: string;
  /** Empty when the change creates the file. */
  readonly previous: string;
  readonly next: string;
  readonly layout: DiffLayout;
}

const COLLAPSE = { margin: 3, minSize: 6 } as const;

export function MergeDiff({ file, previous, next, layout }: MergeDiffProps) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const parent = host.current;
    if (!parent) {
      return undefined;
    }
    const extensions = readOnly(file);
    if (layout === 'split') {
      const view = new MergeView({
        a: { doc: previous, extensions },
        b: { doc: next, extensions },
        parent,
        gutter: true,
        highlightChanges: true,
        collapseUnchanged: COLLAPSE,
      });
      return () => view.destroy();
    }
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: next,
        extensions: [
          ...extensions,
          unifiedMergeView({ original: previous, mergeControls: false, gutter: true, highlightChanges: true, collapseUnchanged: COLLAPSE }),
        ],
      }),
    });
    return () => view.destroy();
  }, [file, previous, next, layout]);
  return <div ref={host} className={`chat-merge-diff is-${layout}`} />;
}

function readOnly(file: string): Extension[] {
  return [
    // Read-only and not editable: readOnly alone still shows a caret that invites an edit.
    EditorState.readOnly.of(true),
    EditorView.editable.of(false),
    EditorView.lineWrapping,
    lineNumbers(),
    appTheme,
    appHighlight,
    codeEditorLanguage(file.endsWith('.astro') ? 'astro' : languageFor(file)),
  ];
}
