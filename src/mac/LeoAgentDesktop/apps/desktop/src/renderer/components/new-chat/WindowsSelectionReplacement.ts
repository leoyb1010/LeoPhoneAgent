import { Extension } from '@tiptap/core';
import { Plugin } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';

/** Configuration for the Windows contenteditable selection workaround. */
interface WindowsSelectionReplacementOptions {
  enabled: boolean;
}

/**
 * Insert or replace text through ProseMirror instead of letting Chromium infer
 * the change from its mutated contenteditable DOM.
 *
 * Windows Chromium can report the DOM diff for a selection next to a trailing
 * line break with the caret on the wrong side of the inserted text. Dispatching
 * the equivalent transaction keeps both the document suffix and caret
 * deterministic. Composition input is deliberately excluded so ProseMirror
 * can keep ownership of the native IME lifecycle.
 */
export function handleWindowsSelectedTextInput(view: EditorView, event: InputEvent): boolean {
  const { selection } = view.state;
  const isSupportedInput =
    event.inputType === 'insertText' ||
    (event.inputType === 'insertReplacementText' && !selection.empty);
  if (
    view.composing ||
    event.isComposing ||
    !event.cancelable ||
    !isSupportedInput ||
    event.data == null ||
    event.data.length === 0
  ) {
    return false;
  }

  event.preventDefault();
  const text = event.data;
  const { from, to } = selection;
  const insertText = () => view.state.tr.insertText(text, from, to).scrollIntoView();
  if (!view.someProp('handleTextInput', (handler) => handler(view, from, to, text, insertText))) {
    view.dispatch(insertText());
  }
  return true;
}

/** Create the ProseMirror plugin used by the Windows-only Tiptap extension. */
export function createWindowsSelectionReplacementPlugin(): Plugin {
  return new Plugin({
    props: {
      handleDOMEvents: {
        beforeinput: (view, event) => handleWindowsSelectedTextInput(view, event as InputEvent),
      },
    },
  });
}

/**
 * Windows-only selection replacement guard for the plain-text chat composer.
 */
export const WindowsSelectionReplacement = Extension.create<WindowsSelectionReplacementOptions>({
  name: 'windowsSelectionReplacement',

  addOptions() {
    return { enabled: false };
  },

  addProseMirrorPlugins() {
    return this.options.enabled ? [createWindowsSelectionReplacementPlugin()] : [];
  },
});
