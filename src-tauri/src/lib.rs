mod columns;
mod grid;
mod mssql;
mod postgres;
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(postgres::PgState::default())
        .manage(mssql::MsState::default())
        .invoke_handler(tauri::generate_handler![
            mssql::ms_connect,
            mssql::ms_test_connection,
            mssql::ms_disconnect,
            mssql::ms_catalog,
            mssql::ms_query,
            mssql::ms_validate,
            mssql::ms_table_data,
            mssql::ms_save_grid,
            mssql::ms_column_context,
            mssql::ms_change_column,
            mssql::ms_cancel,
            postgres::pg_connect,
            postgres::pg_test_connection,
            postgres::pg_disconnect,
            postgres::pg_catalog,
            postgres::pg_query,
            postgres::pg_validate,
            postgres::pg_table_data,
            postgres::pg_save_grid,
            postgres::pg_column_context,
            postgres::pg_change_column,
            postgres::pg_cancel
        ])
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while building tauri application");
}
