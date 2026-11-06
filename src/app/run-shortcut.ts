/** Route F5 through the focused pane's actual Run button, just like a mouse click. */
export function installRunShortcut(target: Window, doc: Document) {
  const handler = (event: KeyboardEvent) => {
    if (event.key !== "F5" && event.code !== "F5" && event.keyCode !== 116)
      return;
    event.preventDefault();
    event.stopPropagation();
    if (
      event.repeat ||
      event.isComposing ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey
    )
      return;
    // Radix popovers also have role=dialog; only a visible modal blocks execution.
    if (
      Array.from(
        doc.querySelectorAll<HTMLElement>(
          '.modal-overlay, [role="dialog"][aria-modal="true"], [role="alertdialog"]',
        ),
      ).some((dialog) => dialog.getClientRects().length > 0)
    )
      return;
    const pane =
      doc.activeElement?.closest(".sql-workspace") ??
      doc.querySelector(".sql-pane-container.is-active .sql-workspace");
    const button = pane?.querySelector<HTMLButtonElement>(".sql-run-button");
    if (button && !button.disabled && button.dataset?.action !== "stop")
      button.click();
  };
  target.addEventListener("keydown", handler, { capture: true });
  return () =>
    target.removeEventListener("keydown", handler, { capture: true });
}
