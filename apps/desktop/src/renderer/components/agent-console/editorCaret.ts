/** Keep the selection visible inside the editor without scrolling the chat/page. */
export function revealEditorCaret(el: HTMLElement): void {
  const selection = window.getSelection();
  if (document.activeElement !== el || !selection?.rangeCount || !el.contains(selection.focusNode)) return;
  const caret = selection.getRangeAt(0).cloneRange();
  caret.collapse(false);
  const rect = caret.getBoundingClientRect();
  const box = el.getBoundingClientRect();
  if (!rect.height) { el.scrollTop = el.scrollHeight; return; }
  if (rect.bottom > box.bottom - 12) el.scrollTop += rect.bottom - box.bottom + 12;
  else if (rect.top < box.top + 12) el.scrollTop -= box.top + 12 - rect.top;
}
