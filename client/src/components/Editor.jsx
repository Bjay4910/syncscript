import React, { useEffect, useRef, useState } from 'react';
import { EditorState } from '@codemirror/state';
import { EditorView, basicSetup } from 'codemirror';
import { yCollab } from 'y-codemirror.next';
import * as Y from 'yjs';
import { Activity } from 'lucide-react';

export default function Editor({ ydoc, provider }) {
  const editorContainerRef = useRef(null);
  const viewRef = useRef(null);
  const [stats, setStats] = useState({ chars: 0, words: 0, lines: 1 });

  useEffect(() => {
    if (!editorContainerRef.current || !ydoc || !provider) return;

    // Get the shared Y.Text type for the document
    const ytext = ydoc.getText('codemirror');
    const undoManager = new Y.UndoManager(ytext);

    // Initial document stats
    const initialText = ytext.toString();
    setStats({
      chars: initialText.length,
      words: initialText.trim() ? initialText.trim().split(/\s+/).length : 0,
      lines: initialText.split('\n').length,
    });

    // CodeMirror theme styling
    const customTheme = EditorView.theme({
      '&': {
        height: '100%',
        fontSize: '15px',
      },
      '.cm-content': {
        fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
        padding: '16px 20px',
      },
      '.cm-line': {
        padding: '0 4px',
        lineHeight: '1.7',
      },
      '&.cm-focused .cm-cursor': {
        borderLeftColor: '#818cf8',
        borderLeftWidth: '2px',
      },
      '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
        backgroundColor: 'rgba(99, 102, 241, 0.28) !important',
      },
      '.cm-gutters': {
        backgroundColor: 'transparent',
        borderRight: '1px solid rgba(255, 255, 255, 0.06)',
        color: '#475569',
      },
      '.cm-activeLine': {
        backgroundColor: 'rgba(255, 255, 255, 0.025)',
      },
      '.cm-activeLineGutter': {
        backgroundColor: 'transparent',
        color: '#94a3b8',
        fontWeight: 'bold',
      },
    }, { dark: true });

    // Update listener for stats (characters, words, lines)
    const statsUpdateListener = EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        const text = update.state.doc.toString();
        setStats({
          chars: text.length,
          words: text.trim() ? text.trim().split(/\s+/).length : 0,
          lines: update.state.doc.lines,
        });
      }
    });

    // Create the CodeMirror editor state with yCollab extension
    const state = EditorState.create({
      doc: ytext.toString(),
      extensions: [
        basicSetup,
        EditorView.lineWrapping,
        customTheme,
        statsUpdateListener,
        // Bind CodeMirror to Yjs Y.Text and Awareness with remote selection & cursor rendering
        yCollab(ytext, provider.awareness, { undoManager }),
      ],
    });

    // Instantiate CodeMirror 6 EditorView
    const view = new EditorView({
      state,
      parent: editorContainerRef.current,
    });

    viewRef.current = view;

    // Focus editor on load
    view.focus();

    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [ydoc, provider]);

  return (
    <div className="editor-workspace">
      <div className="editor-surface-card">
        <div ref={editorContainerRef} className="cm-container-wrapper" />

        {/* Editor Footer Status Bar */}
        <div className="editor-footer-bar">
          <div className="footer-stat-group">
            <span className="footer-stat-item">
              <span>Lines:</span>
              <strong>{stats.lines}</strong>
            </span>
            <span className="footer-stat-item">
              <span>Words:</span>
              <strong>{stats.words}</strong>
            </span>
            <span className="footer-stat-item">
              <span>Characters:</span>
              <strong>{stats.chars}</strong>
            </span>
          </div>

          <div className="footer-crdt-badge" title="Changes conflict-free synced via Yjs CRDT">
            <Activity size={12} color="#10b981" />
            <span>CRDT Synced</span>
          </div>
        </div>
      </div>
    </div>
  );
}
