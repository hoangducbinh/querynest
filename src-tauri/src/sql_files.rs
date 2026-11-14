use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{fs, io, path::PathBuf};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;
use uuid::Uuid;

fn preference_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?
        .join("sql-folder.json"))
}

fn read_folder(app: &AppHandle) -> Result<Option<PathBuf>, String> {
    match fs::read(preference_path(app)?) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| e.to_string()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
pub async fn sql_folder(app: AppHandle) -> Result<Option<PathBuf>, String> {
    existing_sql_folder(&app)
}

pub(crate) fn existing_sql_folder(app: &AppHandle) -> Result<Option<PathBuf>, String> {
    Ok(read_folder(app)?.filter(|folder| {
        folder.is_dir() && folder.canonicalize().is_ok_and(|path| path == *folder)
    }))
}

#[tauri::command]
pub async fn choose_sql_folder(app: AppHandle) -> Result<Option<PathBuf>, String> {
    let mut dialog = app
        .dialog()
        .file()
        .set_title("Choose a folder for SQL autosave");
    if let Ok(Some(current)) = read_folder(&app) {
        if let Some(parent) = current.parent() {
            dialog = dialog.set_directory(parent);
        }
    }
    let Some(selected) = dialog.blocking_pick_folder() else {
        return Ok(None);
    };
    let parent = selected.into_path().map_err(|e| e.to_string())?;
    let parent = parent.canonicalize().map_err(|e| e.to_string())?;
    if let Ok(Some(current)) = read_folder(&app) {
        if current.parent() == Some(parent.as_path())
            && current.is_dir()
            && current.canonicalize().is_ok_and(|path| path == current)
        {
            return Ok(Some(current));
        }
    }
    let folder = parent.join(format!("SQL Queries - {}", Uuid::new_v4()));
    fs::create_dir(&folder).map_err(|e| e.to_string())?;
    let preference = preference_path(&app)?;
    fs::create_dir_all(
        preference
            .parent()
            .ok_or("Missing app configuration folder")?,
    )
    .map_err(|e| e.to_string())?;
    let contents = serde_json::to_vec(&folder).map_err(|e| e.to_string())?;
    atomic_write(preference, &contents)?;
    Ok(Some(folder))
}

fn atomic_write(path: PathBuf, contents: &[u8]) -> Result<(), String> {
    let temporary = path.with_file_name(format!(".{}.tmp", Uuid::new_v4()));
    let result = (|| -> io::Result<()> {
        use std::io::Write;
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(contents)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temporary, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result.map_err(|e| e.to_string())
}

#[derive(Deserialize)]
pub struct QueryFile {
    id: String,
    name: String,
    sql: String,
    previous_sql: Option<String>,
    file_path: Option<PathBuf>,
}

#[tauri::command]
pub async fn autosave_sql_files(
    app: AppHandle,
    workspace_id: String,
    queries: Vec<QueryFile>,
    read_only: bool,
) -> Result<Vec<Option<String>>, String> {
    let folder = read_folder(&app)?.ok_or("Choose a SQL autosave folder first")?;
    if folder.canonicalize().map_err(|e| e.to_string())? != folder {
        return Err("Choose the SQL autosave folder again. Its location changed.".into());
    }
    let entries = fs::read_dir(&folder)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    let mut results = Vec::with_capacity(queries.len());
    for query in queries {
        let suffix = query_suffix(&workspace_id, &query.id);
        let existing = entries
            .iter()
            .find(|entry| entry.file_name().to_string_lossy().ends_with(&suffix));
        let path = if let Some(relative) = &query.file_path {
            resolve_sql_file(&folder, relative)?
        } else if let Some(entry) = existing {
            entry.path()
        } else {
            let title: String = query
                .name
                .trim_end_matches(".sql")
                .chars()
                .take(56)
                .map(|ch| {
                    if ch.is_alphanumeric() || ch == '-' || ch == '_' || ch == ' ' {
                        ch
                    } else {
                        '_'
                    }
                })
                .collect();
            folder.join(format!("Query {}{}", title.trim(), suffix))
        };
        let disk = match fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.is_file() => {
                Some(fs::read_to_string(&path).map_err(|e| e.to_string())?)
            }
            Ok(_) => return Err("The SQL path is not a regular file.".into()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => None,
            Err(error) => return Err(error.to_string()),
        };
        if let Some(disk) = disk {
            if disk == query.sql {
                results.push(None);
                continue;
            }
            if read_only || query.previous_sql.as_ref() != Some(&disk) {
                results.push(Some(disk));
                continue;
            }
        } else if read_only || query.sql.trim().is_empty() {
            results.push(None);
            continue;
        }
        atomic_write(path, query.sql.as_bytes())?;
        results.push(None);
    }
    Ok(results)
}

#[derive(serde::Serialize)]
pub struct SqlFolderEntry {
    name: String,
    directory: bool,
}

#[tauri::command]
pub async fn list_sql_folder(
    app: AppHandle,
    relative: PathBuf,
) -> Result<Vec<SqlFolderEntry>, String> {
    let root = existing_sql_folder(&app)?.ok_or("Choose a SQL autosave folder first")?;
    if relative
        .components()
        .any(|part| !matches!(part, std::path::Component::Normal(_)))
    {
        return Err("Invalid folder path.".into());
    }
    let folder = root
        .join(relative)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    if !folder.starts_with(&root) {
        return Err("Folder is outside the SQL autosave directory.".into());
    }
    let mut entries = Vec::new();
    for entry in fs::read_dir(folder).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let kind = entry.file_type().map_err(|e| e.to_string())?;
        let Some(name) = entry.file_name().into_string().ok() else {
            continue;
        };
        if (kind.is_file() || kind.is_dir()) && !name.starts_with('.') {
            entries.push(SqlFolderEntry {
                name,
                directory: kind.is_dir(),
            });
        }
    }
    entries.sort_by(|a, b| {
        b.directory
            .cmp(&a.directory)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(entries)
}

fn query_suffix(workspace_id: &str, tab_id: &str) -> String {
    let mut hash = Sha256::new();
    hash.update(workspace_id.len().to_le_bytes());
    hash.update(workspace_id.as_bytes());
    hash.update(tab_id.as_bytes());
    format!(" - {:x}.sql", hash.finalize())
}

fn resolve_sql_file(root: &std::path::Path, relative: &std::path::Path) -> Result<PathBuf, String> {
    if relative
        .components()
        .any(|part| !matches!(part, std::path::Component::Normal(_)))
        || !relative
            .extension()
            .and_then(|ext| ext.to_str())
            .is_some_and(|ext| ext.eq_ignore_ascii_case("sql"))
    {
        return Err("Choose a SQL file inside the SQL folder.".into());
    }
    let path = root.join(relative);
    let parent = path.parent().ok_or("Invalid SQL file path.")?;
    if parent.canonicalize().map_err(|e| e.to_string())? != parent {
        return Err("The SQL path is outside the SQL folder.".into());
    }
    Ok(path)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenSqlFile {
    name: String,
    sql: String,
    tab_id: Option<String>,
}

#[tauri::command]
pub async fn read_sql_file(
    app: AppHandle,
    relative: PathBuf,
    workspace_id: String,
    tab_ids: Vec<String>,
) -> Result<OpenSqlFile, String> {
    let root = existing_sql_folder(&app)?.ok_or("Choose a SQL autosave folder first")?;
    let path = resolve_sql_file(&root, &relative)?;
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("Invalid SQL file name")?
        .to_owned();
    let tab_id = if relative.components().count() == 1 {
        tab_ids
            .into_iter()
            .find(|id| name.ends_with(&query_suffix(&workspace_id, id)))
    } else {
        None
    };
    if !fs::symlink_metadata(&path)
        .map_err(|e| e.to_string())?
        .is_file()
    {
        return Err("The SQL path is not a regular file.".into());
    }
    let sql = fs::read_to_string(path).map_err(|e| e.to_string())?;
    Ok(OpenSqlFile { name, sql, tab_id })
}
