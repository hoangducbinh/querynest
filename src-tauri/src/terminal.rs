use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};
use std::{
    collections::HashMap,
    io::{Read, Write},
    sync::{Arc, Mutex},
};
use tauri::{
    AppHandle, State,
    ipc::{Channel, Response},
};

struct Session {
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
}

#[derive(Clone, Default)]
pub struct TerminalState(Arc<Mutex<HashMap<String, Arc<Session>>>>);

impl TerminalState {
    fn get(&self, id: &str) -> Result<Arc<Session>, String> {
        self.0
            .lock()
            .map_err(display)?
            .get(id)
            .cloned()
            .ok_or_else(|| "Terminal has closed".into())
    }

    fn close(&self, id: &str) {
        let session = self
            .0
            .lock()
            .ok()
            .and_then(|mut sessions| sessions.remove(id));
        if let Some(session) = session {
            if let Ok(mut killer) = session.killer.lock() {
                let _ = killer.kill();
            }
        }
    }

    pub fn close_all(&self) {
        let ids: Vec<_> = self
            .0
            .lock()
            .map(|sessions| sessions.keys().cloned().collect())
            .unwrap_or_default();
        for id in ids {
            self.close(&id);
        }
    }
}

fn display(error: impl std::fmt::Display) -> String {
    error.to_string()
}

fn size(cols: u16, rows: u16) -> PtySize {
    PtySize {
        cols: cols.clamp(2, 1000),
        rows: rows.clamp(1, 500),
        pixel_width: 0,
        pixel_height: 0,
    }
}

#[derive(serde::Serialize)]
pub struct TerminalProfile {
    id: &'static str,
    label: &'static str,
}

fn available_shells() -> Vec<(TerminalProfile, std::path::PathBuf)> {
    #[cfg(unix)]
    let candidates = [
        ("zsh", "Zsh", Some("/bin/zsh".into())),
        ("bash", "Bash", Some("/bin/bash".into())),
        (
            "fish",
            "Fish",
            [
                "/opt/homebrew/bin/fish",
                "/usr/local/bin/fish",
                "/usr/bin/fish",
            ]
            .into_iter()
            .map(std::path::PathBuf::from)
            .find(|path| path.is_file()),
        ),
    ];
    #[cfg(windows)]
    let candidates = {
        let system = std::env::var_os("SystemRoot").map(std::path::PathBuf::from);
        let programs = std::env::var_os("ProgramFiles").map(std::path::PathBuf::from);
        [
            (
                "cmd",
                "Command Prompt",
                system.as_ref().map(|path| path.join("System32/cmd.exe")),
            ),
            (
                "powershell",
                "Windows PowerShell",
                system.map(|path| path.join("System32/WindowsPowerShell/v1.0/powershell.exe")),
            ),
            (
                "pwsh",
                "PowerShell 7",
                programs.map(|path| path.join("PowerShell/7/pwsh.exe")),
            ),
        ]
    };
    candidates
        .into_iter()
        .filter_map(|(id, label, path)| {
            let path = path.filter(|path| path.is_file())?;
            Some((TerminalProfile { id, label }, path))
        })
        .collect()
}

#[tauri::command]
pub fn terminal_profiles() -> Vec<TerminalProfile> {
    available_shells()
        .into_iter()
        .map(|(profile, _)| profile)
        .collect()
}

#[tauri::command]
pub async fn terminal_open(
    app: AppHandle,
    state: State<'_, TerminalState>,
    cols: u16,
    rows: u16,
    output: Channel<Response>,
    profile: Option<String>,
) -> Result<String, String> {
    let directory = crate::sql_files::existing_sql_folder(&app)?
        .ok_or("Choose a SQL script folder before opening Terminal.")?;
    let pair = native_pty_system()
        .openpty(size(cols, rows))
        .map_err(display)?;
    let mut reader = pair.master.try_clone_reader().map_err(display)?;
    let writer = pair.master.take_writer().map_err(display)?;
    let mut command = if let Some(profile) = profile {
        let (_, shell) = available_shells()
            .into_iter()
            .find(|(entry, _)| entry.id == profile)
            .ok_or("The selected shell is unavailable.")?;
        let mut command = CommandBuilder::new(shell);
        #[cfg(unix)]
        command.arg("-l");
        command
    } else {
        CommandBuilder::new_default_prog()
    };
    command.env("TERM", "xterm-256color");
    command.cwd(directory);
    let mut child = pair.slave.spawn_command(command).map_err(display)?;
    drop(pair.slave);

    let session = Arc::new(Session {
        killer: Mutex::new(child.clone_killer()),
        master: Mutex::new(pair.master),
        writer: Mutex::new(writer),
    });
    let state = state.inner().clone();
    let id = uuid::Uuid::new_v4().to_string();
    state.0.lock().map_err(display)?.insert(id.clone(), session);
    let exit_state = state.clone();
    let exit_id = id.clone();
    std::thread::spawn(move || {
        let _ = child.wait();
        // Closing the PTY also unblocks the reader on Windows.
        let session = exit_state
            .0
            .lock()
            .ok()
            .and_then(|mut sessions| sessions.remove(&exit_id));
        drop(session);
    });
    let reader_id = id.clone();
    std::thread::spawn(move || {
        let mut bytes = [0; 8192];
        loop {
            match reader.read(&mut bytes) {
                Ok(0) => break,
                Ok(count) => {
                    if output.send(Response::new(bytes[..count].to_vec())).is_err() {
                        break;
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => break,
            }
        }
        state.close(&reader_id);
        let _ = output.send(Response::new(Vec::<u8>::new()));
    });
    Ok(id)
}

#[tauri::command]
pub async fn terminal_write(
    state: State<'_, TerminalState>,
    id: String,
    input: String,
) -> Result<(), String> {
    let session = state.get(&id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut writer = session.writer.lock().map_err(display)?;
        writer
            .write_all(input.as_bytes())
            .and_then(|()| writer.flush())
            .map_err(display)
    })
    .await
    .map_err(display)?
}

#[tauri::command]
pub fn terminal_resize(
    state: State<'_, TerminalState>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    state
        .get(&id)?
        .master
        .lock()
        .map_err(display)?
        .resize(size(cols, rows))
        .map_err(display)
}

#[tauri::command]
pub fn terminal_close(state: State<'_, TerminalState>, id: String) {
    state.close(&id);
}
