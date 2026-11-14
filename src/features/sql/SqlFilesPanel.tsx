import { invoke } from "@tauri-apps/api/core";
import { ChevronRight, File, FileCode, Folder, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";

export const SQL_FILE_DRAG_TYPE = "application/x-sql-workspace-file";

type Entry = { name: string; directory: boolean };

function FolderContents({
  path,
  revision,
  onOpenFile,
}: {
  path: string;
  revision: number;
  onOpenFile: (path: string) => void;
}) {
  const [entries, setEntries] = useState<Entry[]>();
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    invoke<Entry[]>("list_sql_folder", { relative: path }).then(
      (next) => {
        if (!active) return;
        setEntries(next);
        setError("");
      },
      (reason) => {
        if (active) setError(String(reason));
      },
    );
    return () => {
      active = false;
    };
  }, [path, revision]);

  if (error) return <p role="alert">{error}</p>;
  if (!entries?.length) return <p>{entries ? "No files" : "Loading…"}</p>;
  return (
    <ul>
      {entries.map(({ name, directory }) => (
        <li key={name}>
          {directory ? (
            <FolderRow
              name={name}
              path={path ? path + "/" + name : name}
              revision={revision}
              onOpenFile={onOpenFile}
            />
          ) : /\.sql$/i.test(name) ? (
            <button
              type="button"
              className="sql-file-row sql-file-item"
              title={name}
              draggable
              onClick={() => onOpenFile(path ? path + "/" + name : name)}
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = "copy";
                event.dataTransfer.setData(
                  SQL_FILE_DRAG_TYPE,
                  path ? path + "/" + name : name,
                );
              }}
            >
              <FileCode size={14} />
              <span>{name}</span>
            </button>
          ) : (
            <span className="sql-file-row sql-file-item" title={name}>
              <File size={14} />
              <span>{name}</span>
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

function FolderRow({
  name,
  path,
  revision,
  onOpenFile,
}: {
  name: string;
  path: string;
  revision: number;
  onOpenFile: (path: string) => void;
}) {
  const [expanded, setExpanded] = useState(path === "");
  return (
    <>
      <button
        type="button"
        className="sql-file-row"
        title={name}
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
      >
        <ChevronRight size={12} className="sql-folder-chevron" />
        <Folder size={14} />
        <span>{name}</span>
      </button>
      {expanded && (
        <FolderContents
          path={path}
          revision={revision}
          onOpenFile={onOpenFile}
        />
      )}
    </>
  );
}

export function SqlFilesPanel({
  folder,
  onOpenFile,
}: {
  folder: string;
  onOpenFile: (path: string) => void;
}) {
  const [revision, refresh] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!document.hidden) refresh((value) => value + 1);
    }, 3000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <aside className="sql-files-panel" aria-label="SQL files">
      <header>
        <strong title={folder}>Files</strong>
        <button
          type="button"
          aria-label="Refresh files"
          title="Refresh files"
          onClick={() => refresh((value) => value + 1)}
        >
          <RefreshCw size={14} />
        </button>
      </header>
      <div className="sql-files-list">
        <FolderRow
          key={folder}
          name={folder.split(/[\\/]/).pop() || folder}
          path=""
          revision={revision}
          onOpenFile={onOpenFile}
        />
      </div>
    </aside>
  );
}
