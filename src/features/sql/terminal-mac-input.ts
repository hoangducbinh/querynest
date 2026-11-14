import type { Terminal } from "@xterm/xterm";

const segmenter = typeof Intl.Segmenter === "function"
  ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
  : undefined;

function graphemes(text: string) {
  return segmenter
    ? Array.from(segmenter.segment(text), ({ segment }) => segment)
    : text.match(/\P{M}\p{M}*|\p{M}+/gu) ?? [];
}

export function terminalTextEdit(before: string, after: string): string {
  const previous = graphemes(before);
  const next = graphemes(after);
  let prefix = 0;
  while (prefix < previous.length && previous[prefix] === next[prefix]) prefix++;
  return "\x7f".repeat(previous.length - prefix) + next.slice(prefix).join("");
}

/** Reconcile native macOS text edits with the text already sent to the PTY. */
export function bindMacTerminalInput(terminal: Terminal) {
  const input = terminal.textarea;
  const element = terminal.element;
  if (!input || !element || !/Mac/i.test(navigator.platform)) return () => {};

  let context = "";
  let composing = false;
  let forwarding = false;
  let deadKeyStart: number | undefined;
  let commitTimer: number | undefined;

  function commit() {
    if (!input || composing) return;
    let next = input.value.normalize("NFC");
    if (deadKeyStart !== undefined) {
      const accents: Record<string, string> = {
        "´": "\u0301", "`": "\u0300", "ˆ": "\u0302",
        "˜": "\u0303", "¨": "\u0308",
      };
      const [mark, letter] = graphemes(next.slice(deadKeyStart));
      if (mark && accents[mark] && !letter) return;
      if (mark && letter && letter.normalize("NFD").includes(accents[mark] ?? "\0")) {
        next = next.slice(0, deadKeyStart) + next.slice(deadKeyStart + mark.length);
        input.value = next;
      }
      deadKeyStart = undefined;
    }
    const edit = terminalTextEdit(context, next);
    // Keep enough native text for Telex to rewrite a word without growing the buffer.
    if (next.length > 256) {
      input.value = graphemes(next).slice(-128).join("");
      context = input.value;
    } else {
      context = next;
    }
    if (!edit) return;
    forwarding = true;
    try {
      terminal.input(edit, true);
    } finally {
      forwarding = false;
    }
  }

  function compositionStart(event: CompositionEvent) {
    if (event.target !== input) return;
    event.stopImmediatePropagation();
    window.clearTimeout(commitTimer);
    composing = true;
  }

  function compositionUpdate(event: CompositionEvent) {
    if (event.target !== input) return;
    event.stopImmediatePropagation();
  }

  function compositionEnd(event: CompositionEvent) {
    if (event.target !== input) return;
    event.stopImmediatePropagation();
    composing = false;
    // WebKit can update textarea.value after dispatching compositionend.
    commitTimer = window.setTimeout(() => {
      commitTimer = undefined;
      commit();
    }, 0);
  }

  function onInput(event: Event) {
    if (event.target !== input) return;
    event.stopImmediatePropagation();
    const edit = event as InputEvent;
    if (!edit.isComposing && edit.inputType !== "insertFromPaste") commit();
  }

  function isNativeTextKey(event: KeyboardEvent) {
    if (event.ctrlKey || event.metaKey || event.altKey) return false;
    if (Array.from(event.key).length === 1) return true;
    if (!context) return false;
    // Let the textarea apply native deletions and selection replacements.
    return event.key === "Backspace" || (event.shiftKey && event.key === "ArrowLeft");
  }

  terminal.attachCustomKeyEventHandler((event) => {
    // A native Unicode insertion can arrive with a multi-character or
    // unidentified key. Let WebKit insert it instead of xterm decoding the
    // legacy keypress as a single UTF-16 unit and canceling the DOM edit.
    if (event.type === "keypress") return false;
    if (event.key === "Dead") {
      if (event.type === "keydown") deadKeyStart = context.length;
      return false;
    }
    if (composing || event.isComposing || event.keyCode === 229) return false;
    if (isNativeTextKey(event)) return false;
    if (event.type === "keydown" && commitTimer !== undefined) {
      window.clearTimeout(commitTimer);
      commitTimer = undefined;
      commit();
    }
    return true;
  });

  const reset = terminal.onData(() => {
    if (forwarding || composing) return;
    context = "";
    deadKeyStart = undefined;
    input.value = "";
  });
  function onBlur() {
    if (commitTimer !== undefined) {
      window.clearTimeout(commitTimer);
      commitTimer = undefined;
      commit();
    }
    context = "";
    composing = false;
    deadKeyStart = undefined;
    if (input) input.value = "";
  }

  function onPaste(event: ClipboardEvent) {
    if (event.target !== input || !event.clipboardData) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    terminal.paste(event.clipboardData.getData("text/plain"));
  }

  element.addEventListener("paste", onPaste, true);
  input.addEventListener("blur", onBlur, true);
  element.addEventListener("compositionstart", compositionStart, true);
  element.addEventListener("compositionupdate", compositionUpdate, true);
  element.addEventListener("compositionend", compositionEnd, true);
  element.addEventListener("input", onInput, true);
  return () => {
    window.clearTimeout(commitTimer);
    element.removeEventListener("paste", onPaste, true);
    input.removeEventListener("blur", onBlur, true);
    element.removeEventListener("compositionstart", compositionStart, true);
    element.removeEventListener("compositionupdate", compositionUpdate, true);
    element.removeEventListener("compositionend", compositionEnd, true);
    element.removeEventListener("input", onInput, true);
    reset.dispose();
    terminal.attachCustomKeyEventHandler(() => true);
  };
}
