import { isTauri } from "@tauri-apps/api/core";
export async function saveExportFile(
  name: string,
  extension: "sql" | "csv" | "json",
  contents: string,
): Promise<boolean> {
  const safeBase = (name || "export").replace(/[\\/:*?"<>|]/g, "_");
  const filename = `${safeBase}.${extension}`;
  const filterName =
    extension === "sql"
      ? "SQL Script"
      : extension === "csv"
        ? "CSV File"
        : "JSON File";
  const mimeType =
    extension === "sql"
      ? "application/sql;charset=utf-8"
      : extension === "csv"
        ? "text/csv;charset=utf-8"
        : "application/json;charset=utf-8";

  if (isTauri()) {
    const [{ save }, { writeTextFile }] = await Promise.all([
      import("@tauri-apps/plugin-dialog"),
      import("@tauri-apps/plugin-fs"),
    ]);
    const path = await save({
      defaultPath: filename,
      filters: [{ name: filterName, extensions: [extension] }],
    });
    if (!path) return false;
    await writeTextFile(path, contents);
    return true;
  }

  const url = URL.createObjectURL(new Blob([contents], { type: mimeType }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
}

export async function saveSqlFile(
  name: string,
  contents: string,
): Promise<boolean> {
  const baseName = (name || "query").replace(/\.sql$/i, "").trim() || "query";
  return saveExportFile(baseName, "sql", contents);
}


