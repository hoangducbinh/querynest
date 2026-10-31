const APPEARANCE_KEY = "database-playground:appearance";
export function readDarkAppearance(
  storage?: Pick<Storage, "getItem">,
): boolean {
  try {
    return (storage ?? window.localStorage).getItem(APPEARANCE_KEY) === "dark";
  } catch {
    return false;
  }
}
export function saveDarkAppearance(
  dark: boolean,
  storage?: Pick<Storage, "setItem">,
) {
  try {
    (storage ?? window.localStorage).setItem(
      APPEARANCE_KEY,
      dark ? "dark" : "light",
    );
  } catch {
    /* Keep the selected appearance usable when browser storage is unavailable. */
  }
}
