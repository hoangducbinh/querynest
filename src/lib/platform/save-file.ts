import { isTauri } from "@tauri-apps/api/core";
export async function saveJsonFile(
  name: string,
  contents: string,
): Promise<void> {
  const filename = name.replace(/[\\/:*?"<>|]/g, "_") + ".json";
  if (isTauri()) {
    const [{ save }, { writeTextFile }] = await Promise.all([
      import("@tauri-apps/plugin-dialog"),
      import("@tauri-apps/plugin-fs"),
    ]);
    const path = await save({
      defaultPath: filename,
      filters: [{ name: "Workspace JSON", extensions: ["json"] }],
    });
    if (path) await writeTextFile(path, contents);
    return;
  }
  const url = URL.createObjectURL(
    new Blob([contents], { type: "application/json" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
