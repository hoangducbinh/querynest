/** Route SQL shortcuts through the focused pane's actual Run button, just like a mouse click. */
export function installRunShortcut(target: Window, doc: Document) {
  const handler = (event: KeyboardEvent) => {
    const isF5 =
      event.key === "F5" || event.code === "F5" || event.keyCode === 116;
    const isModifiedEnter =
      event.key === "Enter" && (event.ctrlKey || event.metaKey);
    if ((!isF5 && !isModifiedEnter) || doc.activeElement?.closest(".system-terminal")) return;
    event.preventDefault();
    event.stopPropagation();
    if (
      event.repeat ||
      event.isComposing ||
      event.altKey ||
      (isF5 && (event.ctrlKey || event.metaKey)) ||
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
      doc.activeElement?.closest<HTMLElement>(".sql-workspace") ??
      doc.querySelector<HTMLElement>(".sql-pane-container.is-active .sql-workspace");
    const toolbar = doc.getElementById("titlebar-sql-actions")?.firstElementChild;
    const tabId = pane?.dataset?.sqlTabId;
    const button =
      pane?.querySelector<HTMLButtonElement>(".sql-run-button") ??
      (tabId && toolbar?.getAttribute("data-sql-tab-id") === tabId
        ? toolbar?.querySelector<HTMLButtonElement>(".sql-run-button")
        : undefined);
    if (button && !button.disabled && button.dataset?.action !== "stop")
      button.click();
  };
  target.addEventListener("keydown", handler, { capture: true });
  return () =>
    target.removeEventListener("keydown", handler, { capture: true });
}
