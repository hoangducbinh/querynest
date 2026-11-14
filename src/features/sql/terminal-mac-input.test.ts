import { describe, expect, it, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";
import { bindMacTerminalInput, terminalTextEdit } from "./terminal-mac-input";

describe("terminal Telex edits", () => {
  it("replaces the suffix when a tone moves within a word", () => {
    expect(terminalTextEdit("xin chao", "xin chào")).toBe("\x7f\x7fào");
  });

  it("counts a decomposed accented letter as one backspace", () => {
    expect(terminalTextEdit("a\u0302", "ấ")).toBe("\x7fấ");
  });

  it("appends native text and ignores repeated commits", () => {
    expect(terminalTextEdit("Tiếng", "Tiếng Việt")).toBe(" Việt");
    expect(terminalTextEdit("Tiếng Việt", "Tiếng Việt")).toBe("");
  });
});

it("forwards native deletes and replacement text once in order", () => {
  vi.stubGlobal("navigator", { platform: "MacIntel" });
  vi.stubGlobal("window", globalThis);
  const textarea = Object.assign(new EventTarget(), { value: "" });
  const element = new EventTarget();
  const input = vi.fn();
  const attachCustomKeyEventHandler = vi.fn();
  const dispose = bindMacTerminalInput({
    textarea,
    element,
    input,
    attachCustomKeyEventHandler,
    onData: () => ({ dispose() {} }),
  } as unknown as Terminal);

  function nativeEdit(value: string, inputType: string) {
    textarea.value = value;
    const event = new Event("input");
    Object.defineProperties(event, {
      target: { value: textarea },
      inputType: { value: inputType },
    });
    element.dispatchEvent(event);
  }

  try {
    nativeEdit("ban", "insertText");
    const keyHandler = attachCustomKeyEventHandler.mock.calls[0][0];
    expect(keyHandler({ key: "Backspace", type: "keydown" })).toBe(false);
    nativeEdit("ba", "deleteContentBackward");
    nativeEdit("b", "deleteContentBackward");
    expect(keyHandler({ key: "ạn", type: "keypress" })).toBe(false);
    expect(keyHandler({ key: "Unidentified", type: "keypress" })).toBe(false);
    nativeEdit("bạn", "insertText");

    expect(keyHandler({ key: "ArrowLeft", shiftKey: true, type: "keydown" })).toBe(false);
    nativeEdit("bạn ", "insertReplacementText");
    nativeEdit("bạn ", "insertText");

    textarea.dispatchEvent(new Event("blur"));
    expect(textarea.value).toBe("");
    nativeEdit("làm", "insertText");

    expect(input.mock.calls.map(([data]) => data)).toEqual([
      "ban", "\x7f", "\x7f", "ạn", " ", "làm",
    ]);
  } finally {
    dispose();
    vi.unstubAllGlobals();
  }
});
