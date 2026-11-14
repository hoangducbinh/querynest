import { afterEach, expect, it, vi } from "vitest";
import { installRunShortcut } from "./run-shortcut";
const disposers: (() => void)[] = [];
afterEach(() => disposers.splice(0).forEach((dispose) => dispose()));
function setup({
  disabled = false,
  modal = false,
  focused = true,
  titlebarTabId,
  terminal = false,
}: {
  disabled?: boolean;
  modal?: boolean;
  focused?: boolean;
  titlebarTabId?: string;
  terminal?: boolean;
} = {}) {
  const target = new EventTarget();
  const button = { disabled, click: vi.fn() };
  const pane = {
    dataset: { sqlTabId: "focused-tab" },
    querySelector: vi.fn(() => (titlebarTabId ? null : button)),
  };
  const doc = {
    activeElement: {
      closest: vi.fn((selector: string) =>
        selector === ".system-terminal"
          ? (terminal ? {} : null)
          : (focused ? pane : null),
      ),
    },
    querySelector: vi.fn(() => pane),
    getElementById: vi.fn(() =>
      titlebarTabId
        ? {
            firstElementChild: {
              getAttribute: () => titlebarTabId,
              querySelector: () => button,
            },
          }
        : null,
    ),
    querySelectorAll: vi.fn(() =>
      modal ? [{ getClientRects: () => [1] }] : [],
    ),
  };
  const dispose = installRunShortcut(
    target as Window,
    doc as unknown as Document,
  );
  disposers.push(dispose);
  const key = (properties: Record<string, unknown>) => {
    const event = Object.assign(
      new Event("keydown", { cancelable: true }),
      properties,
    );
    target.dispatchEvent(event);
    return event;
  };
  return { button, pane, doc, key, dispose };
}
it.each([
  { key: "F5" },
  { key: "Unidentified", code: "F5" },
  { keyCode: 116 },
  { key: "Enter", ctrlKey: true },
  { key: "Enter", metaKey: true },
])(
  "runs through the actual pane button for %j and suppresses reload",
  (properties) => {
    const { key, button } = setup();
    expect(key(properties).defaultPrevented).toBe(true);
    expect(button.click).toHaveBeenCalledOnce();
  },
);
it("uses the active pane when focus is outside the editor", () => {
  const { key, button, doc } = setup({ focused: false });
  key({ key: "F5" });
  expect(doc.querySelector).toHaveBeenCalledWith(
    ".sql-pane-container.is-active .sql-workspace",
  );
  expect(button.click).toHaveBeenCalledOnce();
});
it.each([{ key: "F5" }, { key: "Enter", ctrlKey: true }])(
  "guards %j against disabled queries, modals, and key repeat",
  (shortcut) => {
    for (const options of [{ disabled: true }, { modal: true }]) {
      const { key, button } = setup(options);
      expect(key(shortcut).defaultPrevented).toBe(true);
      expect(button.click).not.toHaveBeenCalled();
    }
    const { key, button } = setup();
    key({ ...shortcut, repeat: true });
    expect(button.click).not.toHaveBeenCalled();
  },
);
it("leaves other keys alone and cleans up its listener", () => {
  const { key, button, dispose } = setup();
  expect(key({ key: "Enter" }).defaultPrevented).toBe(false);
  dispose();
  expect(key({ key: "F5" }).defaultPrevented).toBe(false);
  expect(button.click).not.toHaveBeenCalled();
});

it("does not turn F5 into cancellation when Run has become Stop", () => {
  const { key, button } = setup();
  Object.assign(button, { dataset: { action: "stop" } });
  expect(key({ key: "F5" }).defaultPrevented).toBe(true);
  expect(button.click).not.toHaveBeenCalled();
});

it("runs the title bar action only when it belongs to the focused SQL tab", () => {
  const matching = setup({ titlebarTabId: "focused-tab" });
  matching.key({ key: "F5" });
  expect(matching.button.click).toHaveBeenCalledOnce();

  const other = setup({ titlebarTabId: "other-tab" });
  other.key({ key: "F5" });
  expect(other.button.click).not.toHaveBeenCalled();
});

it("leaves SQL shortcuts available to the shell when Terminal has focus", () => {
  const { key, button } = setup({ terminal: true });
  expect(key({ key: "Enter", ctrlKey: true }).defaultPrevented).toBe(false);
  expect(button.click).not.toHaveBeenCalled();
});
