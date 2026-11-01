use crate::columns::{self, ColumnChange, ColumnContext, Engine, Operation};
use crate::grid::{self, GridChange, GridColumn};
use futures_util::TryStreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sqlx::{
    Column, ConnectOptions, Connection, Either, Executor, PgPool, Postgres, Row, Statement,
    TypeInfo, ValueRef,
    pool::PoolConnection,
    postgres::{PgConnectOptions, PgPoolOptions, PgSslMode, PgValueFormat},
};
use std::{
    collections::{HashMap, HashSet},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::sync::Mutex;

#[derive(Default)]
pub struct PgState {
    sessions: Mutex<HashMap<String, Arc<Session>>>,
}
struct Running<'a>(&'a AtomicBool);
impl Drop for Running<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}
struct Session {
    pool: PgPool,
    connection: Mutex<Option<PoolConnection<Postgres>>>,
    pid: i32,
    read_only: bool,
    running: AtomicBool,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PgConfig {
    host: String,
    port: u16,
    database: String,
    user: String,
    ssl_mode: String,
    read_only: bool,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PgFailure {
    pub message: String,
    pub position: Option<usize>,
    pub code: Option<String>,
    pub uncertain: bool,
}
impl From<sqlx::Error> for PgFailure {
    fn from(error: sqlx::Error) -> Self {
        if let Some(db) = error
            .as_database_error()
            .and_then(|e| e.try_downcast_ref::<sqlx::postgres::PgDatabaseError>())
        {
            let position = match db.position() {
                Some(sqlx::postgres::PgErrorPosition::Original(p)) => Some(p),
                _ => None,
            };
            let mut message = db.message().to_string();
            if let Some(hint) = db.hint() {
                message.push_str(&format!("\nHint: {hint}"));
            }
            Self {
                message,
                position,
                code: Some(db.code().to_string()),
                uncertain: false,
            }
        } else {
            Self::message(error.to_string())
        }
    }
}
impl PgFailure {
    fn message(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            position: None,
            code: None,
            uncertain: false,
        }
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PgResult {
    columns: Vec<String>,
    rows: Vec<Value>,
    affected_rows: u64,
    truncated: bool,
}
fn quote(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}
fn unique_columns(names: impl Iterator<Item = String>) -> Vec<String> {
    let mut used = HashSet::new();
    names
        .map(|name| {
            let mut candidate = name.clone();
            let mut n = 2;
            while !used.insert(candidate.clone()) {
                candidate = format!("{name} ({n})");
                n += 1;
            }
            candidate
        })
        .collect()
}
fn text_value(text: &str, kind: &str) -> Value {
    match kind {
        "BOOL" => json!(text == "t" || text == "true"),
        "INT2" | "INT4" | "OID" => text
            .parse::<i64>()
            .map_or_else(|_| json!(text), |n| json!(n)),
        "INT8" => text
            .parse::<i64>()
            .ok()
            .filter(|n| (-9_007_199_254_740_991..=9_007_199_254_740_991).contains(n))
            .map_or_else(|| json!(text), |n| json!(n)),
        // Preserve NUMERIC / arrays / JSON / timestamps and large BIGINT values as text.
        "FLOAT4" | "FLOAT8" => text
            .parse::<f64>()
            .ok()
            .filter(|n| n.is_finite())
            .map_or_else(|| json!(text), |n| json!(n)),
        _ => json!(text),
    }
}
fn first_word(sql: &str) -> String {
    let mut s = sql.trim_start();
    loop {
        if let Some(rest) = s.strip_prefix("--") {
            s = rest
                .split_once('\n')
                .map_or("", |(_, tail)| tail)
                .trim_start();
        } else if let Some(rest) = s.strip_prefix("/*") {
            let mut level = 1;
            let mut i = 0;
            let bytes = rest.as_bytes();
            while i + 1 < bytes.len() && level > 0 {
                if &bytes[i..i + 2] == b"/*" {
                    level += 1;
                    i += 2;
                } else if &bytes[i..i + 2] == b"*/" {
                    level -= 1;
                    i += 2;
                } else {
                    i += 1;
                }
            }
            if level > 0 {
                return String::new();
            }
            s = rest[i..].trim_start();
        } else {
            break;
        }
    }
    s.chars()
        .take_while(|c| c.is_ascii_alphabetic())
        .collect::<String>()
        .to_uppercase()
}
async fn session(state: &PgState, id: &str) -> Result<Arc<Session>, PgFailure> {
    state
        .sessions
        .lock()
        .await
        .get(id)
        .cloned()
        .ok_or_else(|| PgFailure::message("Connection closed. Connect again to continue."))
}
const TABLES: &str = r#"
SELECT COALESCE(json_agg(t ORDER BY t.schema, t.name), '[]'::json) FROM (
SELECT c.oid::text AS id, n.nspname AS schema, c.relname AS name, c.relkind::text AS kind,
 (SELECT COALESCE(json_agg(json_build_object('id', c.oid::text || ':' || a.attnum, 'name', a.attname,
 'type', format_type(a.atttypid, a.atttypmod), 'nullable', NOT a.attnotnull,
 'generated', a.attidentity<>'' OR a.attgenerated<>'', 'defaultValue', COALESCE((SELECT pg_get_expr(d.adbin,d.adrelid) FROM pg_attrdef d WHERE d.adrelid=c.oid AND d.adnum=a.attnum),''),
 'primaryKey', EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid=c.oid AND i.indisprimary AND a.attnum=ANY(i.indkey))) ORDER BY a.attnum), '[]'::json)
 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped) AS columns
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE c.relkind IN ('r','p','v','m','f') AND n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema'
AND has_table_privilege(c.oid, 'SELECT')) t
"#;
const RELATIONS: &str = r#"
SELECT COALESCE(json_agg(json_build_object('id', c.oid::text, 'sourceTable', c.conrelid::text, 'targetTable', c.confrelid::text,
 'sourceColumns', (SELECT json_agg(c.conrelid::text || ':' || k ORDER BY pos) FROM unnest(c.conkey) WITH ORDINALITY x(k,pos)),
 'targetColumns', (SELECT json_agg(c.confrelid::text || ':' || k ORDER BY pos) FROM unnest(c.confkey) WITH ORDINALITY x(k,pos)))), '[]'::json)
FROM pg_constraint c WHERE c.contype='f'
"#;
async fn catalog(pool: &PgPool) -> Result<Value, PgFailure> {
    let tables: Value = sqlx::query_scalar(TABLES).fetch_one(pool).await?;
    let relationships: Value = sqlx::query_scalar(RELATIONS).fetch_one(pool).await?;
    Ok(json!({"tables":tables,"relationships":relationships}))
}
#[tauri::command]
pub async fn pg_connect(
    state: tauri::State<'_, PgState>,
    config: PgConfig,
    password: String,
) -> Result<Value, PgFailure> {
    connect(&state, config, password).await
}
async fn open_pool(config: &PgConfig, password: &str) -> Result<PgPool, PgFailure> {
    if config.host.trim().is_empty()
        || config.database.trim().is_empty()
        || config.user.trim().is_empty()
        || config.port == 0
    {
        return Err(PgFailure::message(
            "Host, database, user and a valid port are required.",
        ));
    }
    let ssl = match config.ssl_mode.as_str() {
        "verify-full" => PgSslMode::VerifyFull,
        "require" => PgSslMode::Require,
        "disable" => PgSslMode::Disable,
        _ => return Err(PgFailure::message("Invalid SSL mode.")),
    };
    let options = PgConnectOptions::new()
        .host(&config.host)
        .port(config.port)
        .database(&config.database)
        .username(&config.user)
        .password(password)
        .ssl_mode(ssl)
        .application_name("Max Learning")
        .disable_statement_logging();
    let pool = pool_options().connect_with(options.clone()).await;
    let pool = match pool {
        Ok(pool) => pool,
        Err(sqlx::Error::PoolTimedOut) => {
            // Pool acquisition retries connection refusals and hides their cause.
            // Probe directly only on failure so the UI can show the actual error.
            let detail = match tokio::time::timeout(Duration::from_secs(3), options.connect()).await
            {
                Ok(Ok(connection)) => {
                    connection.close().await?;
                    "The server responded, but the connection pool could not initialize. Try again."
                        .to_string()
                }
                Ok(Err(error)) => PgFailure::from(error).message,
                Err(_) => "The server did not respond. Check the host, port, network and firewall."
                    .to_string(),
            };
            return Err(PgFailure::message(format!(
                "Could not connect to PostgreSQL at {}:{}. {} For a local server, ensure PostgreSQL is running and check the SSL setting.",
                config.host, config.port, detail
            )));
        }
        Err(error) => return Err(error.into()),
    };
    Ok(pool)
}
fn pool_options() -> PgPoolOptions {
    PgPoolOptions::new()
        .max_connections(3)
        .acquire_timeout(Duration::from_secs(10))
        .after_connect(|c, _| {
            Box::pin(async move {
                sqlx::query("SET statement_timeout = '60s'")
                    .execute(&mut *c)
                    .await?;
                sqlx::query("SET lock_timeout = '5s'")
                    .execute(&mut *c)
                    .await?;
                sqlx::query("SET standard_conforming_strings = on")
                    .execute(c)
                    .await?;
                Ok(())
            })
        })
}
#[tauri::command]
pub async fn pg_databases(
    state: tauri::State<'_, PgState>,
    session_id: String,
) -> Result<Vec<String>, PgFailure> {
    let s = session(&state, &session_id).await?;
    Ok(sqlx::query_scalar("SELECT datname::text FROM pg_database WHERE datallowconn AND NOT datistemplate AND has_database_privilege(oid, 'CONNECT') ORDER BY datname").fetch_all(&s.pool).await?)
}
#[tauri::command]
pub async fn pg_open_database(
    state: tauri::State<'_, PgState>,
    session_id: String,
    database: String,
) -> Result<Value, PgFailure> {
    open_database(&state, &session_id, &database).await
}
async fn open_database(
    state: &PgState,
    session_id: &str,
    database: &str,
) -> Result<Value, PgFailure> {
    if database.is_empty() || database.contains('\0') {
        return Err(PgFailure::message("Invalid database name."));
    }
    let source = session(&state, &session_id).await?;
    let options = (*source.pool.connect_options()).clone().database(&database);
    let pool = pool_options().connect_with(options).await?;
    connect_pool(&state, pool, source.read_only).await
}
#[tauri::command]
pub async fn pg_test_connection(config: PgConfig, password: String) -> Result<Value, PgFailure> {
    let pool = open_pool(&config, &password).await?;
    let result = async {
        let version: String = sqlx::query_scalar("SHOW server_version")
            .fetch_one(&pool)
            .await?;
        catalog(&pool).await?;
        Ok(json!({"serverVersion": version}))
    }
    .await;
    pool.close().await;
    result
}
async fn connect(state: &PgState, config: PgConfig, password: String) -> Result<Value, PgFailure> {
    let pool = open_pool(&config, &password).await?;
    connect_pool(state, pool, config.read_only).await
}
async fn connect_pool(state: &PgState, pool: PgPool, read_only: bool) -> Result<Value, PgFailure> {
    let mut connection = pool.acquire().await?;
    let pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(&mut *connection)
        .await?;
    let version: String = sqlx::query_scalar("SHOW server_version")
        .fetch_one(&mut *connection)
        .await?;
    let metadata = catalog(&pool).await?;
    let id = uuid::Uuid::new_v4().to_string();
    state.sessions.lock().await.insert(
        id.clone(),
        Arc::new(Session {
            pool,
            connection: Mutex::new(Some(connection)),
            pid,
            read_only,
            running: AtomicBool::new(false),
        }),
    );
    Ok(json!({"sessionId":id,"serverVersion":version,"catalog":metadata}))
}
#[tauri::command]
pub async fn pg_catalog(
    state: tauri::State<'_, PgState>,
    session_id: String,
) -> Result<Value, PgFailure> {
    catalog(&session(&state, &session_id).await?.pool).await
}
#[tauri::command]
pub async fn pg_disconnect(
    state: tauri::State<'_, PgState>,
    session_id: String,
) -> Result<(), PgFailure> {
    let entry = state.sessions.lock().await.remove(&session_id);
    if let Some(s) = entry {
        let _ = sqlx::query("SELECT pg_cancel_backend($1)")
            .bind(s.pid)
            .execute(&s.pool)
            .await;
        s.connection.lock().await.take();
        s.pool.close().await;
    }
    Ok(())
}
#[tauri::command]
pub async fn pg_cancel(
    state: tauri::State<'_, PgState>,
    session_id: String,
) -> Result<(), PgFailure> {
    let s = session(&state, &session_id).await?;
    if s.running.load(Ordering::SeqCst) {
        sqlx::query("SELECT pg_cancel_backend($1)")
            .bind(s.pid)
            .execute(&s.pool)
            .await?;
    }
    Ok(())
}
async fn execute(
    c: &mut sqlx::PgConnection,
    sql: &str,
    limit: usize,
) -> Result<PgResult, PgFailure> {
    c.clear_cached_statements().await?;
    let statement = c.prepare(sql).await?; // PostgreSQL rejects multiple statements here; never execute an unparsed batch.
    let columns = unique_columns(statement.columns().iter().map(|c| c.name().to_string()));
    read_result(c, sql, limit, columns).await
}
async fn read_result(
    c: &mut sqlx::PgConnection,
    sql: &str,
    limit: usize,
    columns: Vec<String>,
) -> Result<PgResult, PgFailure> {
    let mut result = PgResult {
        columns,
        rows: Vec::new(),
        affected_rows: 0,
        truncated: false,
    };
    let mut stream = sqlx::raw_sql(sql).fetch_many(&mut *c);
    while let Some(message) = stream.try_next().await? {
        match message {
            Either::Left(done) => result.affected_rows = done.rows_affected(),
            Either::Right(row) => {
                if result.rows.len() >= limit {
                    result.truncated = true;
                    continue;
                }
                if result.rows.is_empty() {
                    result.columns =
                        unique_columns(row.columns().iter().map(|c| c.name().to_string()));
                }
                let mut values = Map::new();
                for (i, col) in row.columns().iter().enumerate() {
                    let raw = row.try_get_raw(i)?;
                    let value = if raw.is_null() {
                        Value::Null
                    } else {
                        if raw.format() != PgValueFormat::Text {
                            return Err(PgFailure::message("Unexpected result format."));
                        }
                        text_value(
                            raw.as_str()
                                .map_err(|e| PgFailure::message(e.to_string()))?,
                            col.type_info().name(),
                        )
                    };
                    values.insert(result.columns[i].clone(), value);
                }
                result.rows.push(Value::Object(values));
            }
        }
    }
    Ok(result)
}
async fn preview(
    c: &mut sqlx::PgConnection,
    sql: &str,
    limit: usize,
) -> Result<PgResult, PgFailure> {
    c.clear_cached_statements().await?;
    let statement = c.prepare(sql).await?;
    let columns = unique_columns(statement.columns().iter().map(|col| col.name().to_string()));
    let declaration = format!("DECLARE dbplayground_preview NO SCROLL CURSOR FOR {sql}");
    sqlx::query(&declaration).execute(&mut *c).await?;
    let fetch = format!("FETCH FORWARD {} FROM dbplayground_preview", limit + 1);
    let result = read_result(c, &fetch, limit, columns).await?;
    sqlx::query("CLOSE dbplayground_preview")
        .execute(&mut *c)
        .await?;
    Ok(result)
}
async fn run(s: &Session, sql: &str, limit: usize) -> Result<PgResult, PgFailure> {
    let mut guard = s.connection.lock().await;
    let c = guard
        .as_mut()
        .ok_or_else(|| PgFailure::message("Connection closed."))?;
    s.running.store(true, Ordering::SeqCst);
    let _running = Running(&s.running);
    let result = if s.read_only {
        if !matches!(
            first_word(sql).as_str(),
            "SELECT" | "WITH" | "SHOW" | "EXPLAIN" | "VALUES" | "TABLE"
        ) {
            Err(PgFailure::message(
                "Read-only connection: only queries are allowed. Reconnect with read-only disabled to write.",
            ))
        } else {
            let mut transaction = c.begin().await?;
            sqlx::query("SET TRANSACTION READ ONLY")
                .execute(&mut *transaction)
                .await?;
            let result = if matches!(
                first_word(sql).as_str(),
                "SELECT" | "WITH" | "VALUES" | "TABLE"
            ) {
                preview(&mut transaction, sql, limit).await
            } else {
                execute(&mut transaction, sql, limit).await
            };
            transaction.rollback().await?;
            result
        }
    } else {
        execute(c, sql, limit).await
    };
    s.running.store(false, Ordering::SeqCst);
    result
}
#[tauri::command]
pub async fn pg_query(
    state: tauri::State<'_, PgState>,
    session_id: String,
    sql: String,
    limit: Option<usize>,
) -> Result<PgResult, PgFailure> {
    let s = session(&state, &session_id).await?;
    run(&s, &sql, limit.unwrap_or(1000).clamp(1, 10000)).await
}
#[tauri::command]
pub async fn pg_validate(
    state: tauri::State<'_, PgState>,
    session_id: String,
    sql: String,
) -> Result<(), PgFailure> {
    let s = session(&state, &session_id).await?;
    let mut c = s.pool.acquire().await?;
    c.clear_cached_statements().await?;
    c.prepare(&sql).await?;
    Ok(())
}
#[tauri::command]
pub async fn pg_table_data(
    state: tauri::State<'_, PgState>,
    session_id: String,
    table_id: String,
    page: u32,
) -> Result<PgResult, PgFailure> {
    let s = session(&state, &session_id).await?;
    let oid = table_id
        .parse::<i64>()
        .map_err(|_| PgFailure::message("Invalid table ID."))?;
    let row=sqlx::query("SELECT n.nspname, c.relname, c.relkind::text AS kind FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.oid::bigint=$1 AND has_table_privilege(c.oid,'SELECT')").bind(oid).fetch_one(&s.pool).await?;
    let keys:Vec<String>=sqlx::query_scalar("SELECT a.attname::text FROM pg_index i CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY k(num,pos) JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.num WHERE i.indrelid::bigint=$1 AND i.indisprimary ORDER BY k.pos").bind(oid).fetch_all(&s.pool).await?;
    let order = if keys.is_empty() {
        if matches!(row.get::<String, _>("kind").as_str(), "r" | "p" | "m") {
            " ORDER BY tableoid, ctid".into()
        } else {
            String::new()
        }
    } else {
        format!(
            " ORDER BY {}",
            keys.iter().map(|k| quote(k)).collect::<Vec<_>>().join(",")
        )
    };
    let sql = format!(
        "SELECT * FROM {}.{}{} LIMIT 101 OFFSET {}",
        quote(row.get("nspname")),
        quote(row.get("relname")),
        order,
        u64::from(page) * 100
    );
    let mut transaction = s.pool.begin().await?;
    sqlx::query("SET TRANSACTION READ ONLY")
        .execute(&mut *transaction)
        .await?;
    let result = execute(&mut transaction, &sql, 100).await;
    transaction.rollback().await?;
    result
}
// Saves use an isolated transaction so the grid never commits a manual SQL transaction.
async fn save_grid(s: &Session, oid: i64, changes: Vec<GridChange>) -> Result<usize, PgFailure> {
    if s.read_only {
        return Err(PgFailure::message(
            "Read-only connection. Reconnect with read-only disabled to edit data.",
        ));
    }
    let mut tx = s.pool.begin().await?;
    let result=tokio::time::timeout(Duration::from_secs(60), async {
        let table=sqlx::query("SELECT n.nspname,c.relname,c.relkind::text AS kind FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.oid::bigint=$1 AND c.relkind IN ('r','p') AND has_table_privilege(c.oid,'SELECT')").bind(oid).fetch_optional(&mut *tx).await?.ok_or_else(||PgFailure::message("Only ordinary tables with SELECT permission can be edited. Views and foreign tables are read-only."))?;
        let name=format!("{}.{}",quote(table.get("nspname")),quote(table.get("relname")));
        sqlx::query(&format!("LOCK TABLE {name} IN ROW EXCLUSIVE MODE")).execute(&mut *tx).await?;
        let actual:Option<i64>=sqlx::query_scalar("SELECT to_regclass($1)::oid::bigint").bind(&name).fetch_one(&mut *tx).await?;
        if actual!=Some(oid) {return Err(PgFailure::message("The table was replaced. Refresh the schema."));}
        let metadata=sqlx::query("SELECT a.attname,format_type(a.atttypid,NULL) AS sql_type,t.typname AS kind, a.attnotnull, a.attidentity<>'' OR a.attgenerated<>'' AS generated, a.atthasdef OR a.attidentity<>'' AS defaulted, EXISTS(SELECT 1 FROM pg_index i WHERE i.indrelid=a.attrelid AND i.indisprimary AND a.attnum=ANY(i.indkey)) AS key FROM pg_attribute a JOIN pg_type t ON t.oid=a.atttypid WHERE a.attrelid::bigint=$1 AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum").bind(oid).fetch_all(&mut *tx).await?;
        let columns:Vec<GridColumn>=metadata.iter().map(|r|GridColumn {name:r.get("attname"),sql_type:r.get("sql_type"),kind:r.get::<String,_>("kind").to_uppercase(),key:r.get("key"),generated:r.get("generated"),writable:!r.get::<bool,_>("generated"),nullable:!r.get::<bool,_>("attnotnull"),defaulted:r.get("defaulted")}).collect();
        grid::validate(&columns,&changes).map_err(PgFailure::message)?;
        let mut affected=0;
        for change in &changes {
            let mut params:Vec<Option<String>>=Vec::new();
            let mut predicate=Vec::new();
            if let Some(original)=&change.original {
                for key in columns.iter().filter(|c|c.key) {
                    params.push(Some(grid::original_text(&original[&key.name]).map_err(PgFailure::message)?));
                    predicate.push(format!("{}=CAST(${}::text AS {})",quote(&key.name),params.len(),key.sql_type));
                }
                let selected=columns.iter().map(|c|format!("CASE WHEN pg_column_size({0}) IS NULL THEN NULL ELSE format('%s',{0}) END",quote(&c.name))).collect::<Vec<_>>().join(",");
                let sql=format!("SELECT {selected} FROM {name} WHERE {} FOR UPDATE",predicate.join(" AND "));
                let mut query=sqlx::query(&sql);for value in &params {query=query.bind(value);}
                let rows=query.fetch_all(&mut *tx).await?;
                if rows.len()!=1 {return Err(PgFailure::message("The row was deleted or its primary key changed. No changes were saved. Discard drafts and refresh."));}
                let mut snapshot=Map::new();
                for (index,col) in columns.iter().enumerate() {let value:Option<String>=rows[0].try_get(index)?;snapshot.insert(col.name.clone(),value.map_or(Value::Null,|v|text_value(&v,&col.kind)));}
                grid::check_original(&snapshot,original).map_err(PgFailure::message)?;
            }
            let sql=if change.deleted {
                format!("DELETE FROM {name} WHERE {}",predicate.join(" AND "))
            } else {
                let mut names=Vec::new();let mut values=Vec::new();let mut sets=Vec::new();
                for (column,value) in &change.cells {
                    let c=columns.iter().find(|c|&c.name==column).unwrap();
                    params.push(value.clone());
                    let expression=format!("CAST(${}::text AS {})",params.len(),c.sql_type);
                    names.push(quote(column));values.push(expression.clone());sets.push(format!("{}={expression}",quote(column)));
                }
                if change.original.is_some() {
                    if sets.is_empty() {continue;}
                    format!("UPDATE {name} SET {} WHERE {}",sets.join(","),predicate.join(" AND "))
                } else if names.is_empty() {format!("INSERT INTO {name} DEFAULT VALUES")}
                else {format!("INSERT INTO {name} ({}) VALUES ({})",names.join(","),values.join(","))}
            };
            let mut query=sqlx::query(&sql);for value in &params {query=query.bind(value);}
            if query.execute(&mut *tx).await?.rows_affected()!=1 {return Err(PgFailure::message("A row was not changed exactly once. No changes were saved."));}
            affected+=1;
        }
        Ok::<_,PgFailure>(affected)
    }).await.unwrap_or_else(|_|Err(PgFailure::message("Grid save timed out. No changes were saved.")));
    match result {
        Ok(affected) => {
            tx.commit().await.map_err(|_|PgFailure {uncertain:true,..PgFailure::message("Could not confirm COMMIT. The save outcome is unknown. Discard drafts and refresh before retrying.")})?;
            Ok(affected)
        }
        Err(error) => {
            tx.rollback().await?;
            Err(error)
        }
    }
}
#[tauri::command]
pub async fn pg_save_grid(
    state: tauri::State<'_, PgState>,
    session_id: String,
    table_id: String,
    changes: Vec<GridChange>,
) -> Result<usize, PgFailure> {
    let s = session(&state, &session_id).await?;
    let oid = table_id
        .parse()
        .map_err(|_| PgFailure::message("Invalid table ID."))?;
    save_grid(&s, oid, changes).await
}

const COLUMN_CONTEXT: &str = r#"
SELECT json_build_object('tableId',c.oid::text,'schema',n.nspname,'table',c.relname,'columns',
 (SELECT COALESCE(json_agg(json_build_object(
 'id',c.oid::text||':'||a.attnum,'name',a.attname,'dataType',format_type(a.atttypid,a.atttypmod),'nullable',NOT a.attnotnull,
 'defaultValue',COALESCE((SELECT pg_get_expr(ad.adbin,ad.adrelid) FROM pg_attrdef ad WHERE ad.adrelid=c.oid AND ad.adnum=a.attnum),''),
 'generated',a.attidentity<>'' OR a.attgenerated<>'',
 'primaryKey',EXISTS(SELECT 1 FROM pg_constraint pk WHERE pk.conrelid=c.oid AND pk.contype='p' AND a.attnum=ANY(pk.conkey)),
 'uniqueConstraints',(SELECT COALESCE(json_agg(u.conname::text ORDER BY u.conname),'[]'::json) FROM pg_constraint u WHERE u.conrelid=c.oid AND u.contype='u' AND array_length(u.conkey,1)=1 AND a.attnum=ANY(u.conkey)),
 'defaultConstraint',NULL,
 'collation',(SELECT quote_ident(cn.nspname)||'.'||quote_ident(co.collname) FROM pg_collation co JOIN pg_namespace cn ON cn.oid=co.collnamespace WHERE co.oid=a.attcollation),
 'dependencies',(SELECT COALESCE(json_agg(d.label ORDER BY d.label),'[]'::json) FROM (
 SELECT DISTINCT 'Index: '||ic.relname AS label FROM pg_depend pd JOIN pg_class ic ON pd.classid='pg_class'::regclass AND ic.oid=pd.objid AND ic.relkind IN ('i','I') WHERE pd.refclassid='pg_class'::regclass AND pd.refobjid=c.oid AND pd.refobjsubid=a.attnum
 UNION SELECT 'Constraint: '||con.conname FROM pg_constraint con WHERE con.contype IN ('p','u','f','c','x') AND ((con.conrelid=c.oid AND a.attnum=ANY(con.conkey)) OR (con.confrelid=c.oid AND a.attnum=ANY(con.confkey)))
 ) d)
 ) ORDER BY a.attnum),'[]'::json) FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped))
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.oid::bigint=$1 AND c.relkind IN ('r','p') AND has_table_privilege(c.oid,'SELECT')
"#;
async fn column_context(c: &mut sqlx::PgConnection, oid: i64) -> Result<ColumnContext, PgFailure> {
    let value: Value = sqlx::query_scalar(COLUMN_CONTEXT)
        .bind(oid)
        .fetch_optional(c)
        .await?
        .ok_or_else(|| PgFailure::message("Only ordinary tables can be changed in this editor."))?;
    serde_json::from_value(value).map_err(|e| PgFailure::message(e.to_string()))
}
#[tauri::command]
pub async fn pg_column_context(
    state: tauri::State<'_, PgState>,
    session_id: String,
    table_id: String,
) -> Result<ColumnContext, PgFailure> {
    let s = session(&state, &session_id).await?;
    let oid = table_id
        .parse()
        .map_err(|_| PgFailure::message("Invalid table ID."))?;
    let mut c = s.pool.acquire().await?;
    column_context(&mut c, oid).await
}
async fn change_column(s: &Session, oid: i64, change: ColumnChange) -> Result<(), PgFailure> {
    if s.read_only {
        return Err(PgFailure::message(
            "Read-only connection. Reconnect with read-only disabled to change columns.",
        ));
    }
    let mut tx = s.pool.begin().await?;
    let result = tokio::time::timeout(Duration::from_secs(60), async {
        let before = column_context(&mut tx, oid).await?;
        let table = format!("{}.{}", quote(&before.schema), quote(&before.table));
        sqlx::query(&format!("LOCK TABLE {table} IN ACCESS EXCLUSIVE MODE"))
            .execute(&mut *tx)
            .await?;
        let identity: Option<i64> = sqlx::query_scalar("SELECT to_regclass($1)::oid::bigint")
            .bind(&table)
            .fetch_one(&mut *tx)
            .await?;
        if identity != Some(oid) {
            return Err(PgFailure::message(
                "The table was replaced. Reopen the column editor.",
            ));
        }
        let actual = column_context(&mut tx, oid).await?;
        let operations =
            columns::plan(Engine::Postgres, &actual, &change).map_err(PgFailure::message)?;
        for op in operations {
            match op {
                Operation::Sql(sql) => {
                    sqlx::query(&sql).execute(&mut *tx).await?;
                }
                _ => return Err(PgFailure::message("Invalid column operation.")),
            }
        }
        Ok::<_, PgFailure>(())
    })
    .await
    .unwrap_or_else(|_| {
        Err(PgFailure::message(
            "Column change timed out. No changes were committed.",
        ))
    });
    if let Err(error) = result {
        tx.rollback().await?;
        return Err(error);
    }
    match tokio::time::timeout(Duration::from_secs(15), tx.commit()).await {
        Ok(Ok(())) => Ok(()),
        _ => Err(PgFailure {
            uncertain: true,
            ..PgFailure::message(
                "Could not confirm COMMIT. Close the editor and refresh the schema before trying again.",
            )
        }),
    }
}
#[tauri::command]
pub async fn pg_change_column(
    state: tauri::State<'_, PgState>,
    session_id: String,
    table_id: String,
    change: ColumnChange,
) -> Result<(), PgFailure> {
    let s = session(&state, &session_id).await?;
    let oid = table_id
        .parse()
        .map_err(|_| PgFailure::message("Invalid table ID."))?;
    change_column(&s, oid, change).await
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn identifiers_are_quoted() {
        assert_eq!(quote("a\";DROP"), "\"a\"\";DROP\"");
    }
    #[test]
    fn exact_values() {
        assert_eq!(
            text_value("9007199254740993", "INT8"),
            json!("9007199254740993")
        );
        assert_eq!(text_value("12.3400", "NUMERIC"), json!("12.3400"));
        assert_eq!(text_value("t", "BOOL"), json!(true));
        assert_eq!(text_value("42", "INT4"), json!(42));
    }
    #[test]
    fn comment_prefixes() {
        assert_eq!(first_word(" /* x /* y */ z */ -- a\n SELECT 1"), "SELECT");
        assert_eq!(first_word("COMMIT; DELETE FROM a"), "COMMIT");
    }
    #[test]
    fn unique_names() {
        assert_eq!(
            unique_columns(["id", "id", "id (2)", "id"].into_iter().map(String::from)),
            ["id", "id (2)", "id (2) (2)", "id (3)"]
        );
    }
    #[tokio::test]
    async fn refused_connection_reports_endpoint() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let config = PgConfig {
            host: "127.0.0.1".into(),
            port,
            database: "postgres".into(),
            user: "postgres".into(),
            ssl_mode: "disable".into(),
            read_only: true,
        };
        let error = open_pool(&config, "").await.err().unwrap();
        assert!(error.message.contains(&format!("127.0.0.1:{port}")));
        assert!(error.message.contains("refused"));
        assert!(!error.message.contains("pool timed out"));
    }
    #[tokio::test]
    #[ignore = "requires PostgreSQL fixture on localhost:55439"]
    async fn live_postgres_driver() {
        let state = PgState::default();
        let config = PgConfig {
            host: "127.0.0.1".into(),
            port: 55439,
            database: "playground_qa".into(),
            user: "postgres".into(),
            ssl_mode: "disable".into(),
            read_only: true,
        };
        let tested = pg_test_connection(config.clone(), "playground_qa_only".into())
            .await
            .unwrap();
        assert!(tested["serverVersion"].as_str().is_some());
        assert!(state.sessions.lock().await.is_empty());
        assert!(
            pg_test_connection(config.clone(), "incorrect-password".into())
                .await
                .is_err()
        );
        let info = connect(&state, config, "playground_qa_only".into())
            .await
            .unwrap();
        let s = session(&state, info["sessionId"].as_str().unwrap())
            .await
            .unwrap();
        assert!(
            info["catalog"]["tables"]
                .as_array()
                .unwrap()
                .iter()
                .any(|t| t["schema"] == "sales" && t["name"] == "customers")
        );
        let result = run(
            &s,
            "SELECT id, total, NULL::text AS missing FROM public.orders",
            1000,
        )
        .await
        .unwrap();
        assert_eq!(result.rows[0]["id"], json!("9007199254740993"));
        assert_eq!(result.rows[0]["total"], json!("123.4500"));
        assert_eq!(result.rows[0]["missing"], Value::Null);
        let result = run(
            &s,
            "SELECT * FROM public.customers ORDER BY id LIMIT 101",
            100,
        )
        .await
        .unwrap();
        assert_eq!(result.rows.len(), 100);
        assert!(result.truncated);
        assert!(run(&s, "DELETE FROM public.customers", 100).await.is_err());
        let error=run(&s,"WITH inserted AS (INSERT INTO public.customers(id,name) VALUES (9999,'blocked') RETURNING *) SELECT * FROM inserted",100).await.err().unwrap();
        assert!(matches!(
            error.code.as_deref(),
            Some("25006") | Some("0A000")
        ));
        let error = run(&s, "SELECT * FROM nonexistent_table", 100)
            .await
            .err()
            .unwrap();
        assert_eq!(error.code.as_deref(), Some("42P01"));
        assert!(error.position.is_some());
        assert!(
            run(&s, "SELECT 1; DELETE FROM public.customers", 100)
                .await
                .is_err()
        );
        let result = run(&s, "SELECT count(*) AS count FROM public.customers", 100)
            .await
            .unwrap();
        assert_eq!(result.rows[0]["count"], json!(230));

        let (slow, _) = tokio::join!(run(&s, "SELECT pg_sleep(10)", 100), async {
            tokio::time::sleep(Duration::from_millis(150)).await;
            sqlx::query("SELECT pg_cancel_backend($1)")
                .bind(s.pid)
                .execute(&s.pool)
                .await
                .unwrap();
        });
        assert_eq!(slow.err().unwrap().code.as_deref(), Some("57014"));
        assert!(run(&s, "SELECT 1", 100).await.is_ok());
        let empty = run(&s, "SELECT id FROM public.customers WHERE false", 100)
            .await
            .unwrap();
        assert!(empty.rows.is_empty());
        assert_eq!(empty.columns, vec!["id"]);
        let limited = run(&s, "SELECT n FROM generate_series(1,1000000) n", 10)
            .await
            .unwrap();
        assert_eq!(limited.rows.len(), 10);
        assert!(limited.truncated);

        let write_config = PgConfig {
            host: "127.0.0.1".into(),
            port: 55439,
            database: "playground_qa".into(),
            user: "postgres".into(),
            ssl_mode: "disable".into(),
            read_only: false,
        };
        let info = connect(&state, write_config, "playground_qa_only".into())
            .await
            .unwrap();
        let writer = session(&state, info["sessionId"].as_str().unwrap())
            .await
            .unwrap();
        run(&writer, "CREATE TEMP TABLE driver_test(id integer)", 100)
            .await
            .unwrap();
        let result = run(&writer, "INSERT INTO driver_test VALUES (1),(2)", 100)
            .await
            .unwrap();
        assert_eq!(result.affected_rows, 2);
        run(&writer, "BEGIN", 100).await.unwrap();
        run(&writer, "INSERT INTO driver_test VALUES (3)", 100)
            .await
            .unwrap();
        run(&writer, "ROLLBACK", 100).await.unwrap();
        let result = run(&writer, "SELECT count(*) AS count FROM driver_test", 100)
            .await
            .unwrap();
        assert_eq!(result.rows[0]["count"], json!(2));
        writer.connection.lock().await.take();
        writer.pool.close().await;
        s.connection.lock().await.take();
        s.pool.close().await;
    }
    #[tokio::test]
    #[ignore = "requires disposable PostgreSQL fixture on localhost:55439"]
    async fn live_postgres_grid() {
        use futures_util::FutureExt;
        let config = PgConfig {
            host: "127.0.0.1".into(),
            port: 55439,
            database: "playground_qa".into(),
            user: "postgres".into(),
            ssl_mode: "disable".into(),
            read_only: false,
        };
        let pool = open_pool(&config, "playground_qa_only").await.unwrap();
        let connection = pool.acquire().await.unwrap();
        let s = Session {
            pool: pool.clone(),
            connection: Mutex::new(Some(connection)),
            pid: 0,
            read_only: false,
            running: AtomicBool::new(false),
        };
        let schema = format!("grid_qa_{}", uuid::Uuid::new_v4().simple());
        let result=std::panic::AssertUnwindSafe(async {
            sqlx::raw_sql(&format!("CREATE SCHEMA {schema}; CREATE TABLE {schema}.items (id bigint GENERATED ALWAYS AS IDENTITY (START WITH 9007199254740993), tenant integer NOT NULL DEFAULT 1, name varchar(30) NOT NULL UNIQUE, amount numeric(30,8) DEFAULT 0, note text, flag boolean DEFAULT false, tag char(5) DEFAULT 'ab', computed text GENERATED ALWAYS AS (name || '!') STORED, PRIMARY KEY(id,tenant)); CREATE TABLE {schema}.no_key (val text); CREATE VIEW {schema}.preview AS SELECT * FROM {schema}.items;")).execute(&pool).await.unwrap();
            let oid:i64=sqlx::query_scalar("SELECT to_regclass($1)::oid::bigint").bind(format!("{schema}.items")).fetch_one(&pool).await.unwrap();
            let edit=|original:Option<Map<String,Value>>,cells:Value,deleted|GridChange {original,cells:serde_json::from_value(cells).unwrap(),deleted};
            let snapshot=||async {let mut c=pool.acquire().await.unwrap();execute(&mut c,&format!("SELECT * FROM {schema}.items ORDER BY id,tenant"),100).await.unwrap().rows};
            assert_eq!(save_grid(&s,oid,vec![edit(None,json!({"name":"O'Brien');--","amount":"12345678901234567890.12345678","note":"","flag":"true"}),false)]).await.unwrap(),1);
            let row=snapshot().await.remove(0).as_object().unwrap().clone();
            assert_eq!(row["id"],json!("9007199254740993"));assert_eq!(row["amount"],json!("12345678901234567890.12345678"));assert_eq!(row["note"],json!(""));assert_eq!(row["flag"],json!(true));
            assert!(save_grid(&s,oid,vec![edit(Some(row.clone()),json!({"id":"2"}),false)]).await.is_err());
            assert_eq!(save_grid(&s,oid,vec![edit(Some(row.clone()),json!({"tenant":"2","name":"Updated","note":null}),false)]).await.unwrap(),1);
            let current=snapshot().await.remove(0).as_object().unwrap().clone();assert_eq!(current["tenant"],json!(2));assert_eq!(current["note"],Value::Null);
            assert!(save_grid(&s,oid,vec![edit(Some(current.clone()),json!({"name":"Rollback"}),false),edit(None,json!({"name":"Rollback"}),false)]).await.is_err());
            assert_eq!(snapshot().await[0]["name"],json!("Updated"));
            assert!(save_grid(&s,oid,vec![edit(None,json!({"name":"This value is far too long for a varchar thirty column"}),false)]).await.is_err());
            sqlx::query(&format!("UPDATE {schema}.items SET name='External'")).execute(&pool).await.unwrap();
            assert!(save_grid(&s,oid,vec![edit(Some(current),json!({"name":"Overwrite"}),false)]).await.unwrap_err().message.contains("changed"));
            let current=snapshot().await.remove(0).as_object().unwrap().clone();
            save_grid(&s,oid,vec![edit(Some(current.clone()),json!({}),true)]).await.unwrap();assert!(snapshot().await.is_empty());
            assert!(save_grid(&s,oid,vec![edit(Some(current),json!({}),true)]).await.is_err());
            let keyless:i64=sqlx::query_scalar("SELECT to_regclass($1)::oid::bigint").bind(format!("{schema}.no_key")).fetch_one(&pool).await.unwrap();
            save_grid(&s,keyless,vec![edit(None,json!({"val":"new"}),false)]).await.unwrap();
            save_grid(&s,keyless,vec![edit(None,json!({}),false)]).await.unwrap();
            assert!(save_grid(&s,keyless,vec![edit(Some(json!({"val":"new"}).as_object().unwrap().clone()),json!({"val":"changed"}),false)]).await.is_err());
            let view:i64=sqlx::query_scalar("SELECT to_regclass($1)::oid::bigint").bind(format!("{schema}.preview")).fetch_one(&pool).await.unwrap();assert!(save_grid(&s,view,vec![edit(None,json!({"name":"no"}),false)]).await.is_err());
            let read_only=Session {pool:pool.clone(),connection:Mutex::new(None),pid:0,read_only:true,running:AtomicBool::new(false)};assert!(save_grid(&read_only,oid,vec![edit(None,json!({"name":"no"}),false)]).await.is_err());
        }).catch_unwind().await;
        sqlx::raw_sql(&format!("DROP SCHEMA IF EXISTS {schema} CASCADE"))
            .execute(&pool)
            .await
            .unwrap();
        s.connection.lock().await.take();
        pool.close().await;
        if let Err(error) = result {
            std::panic::resume_unwind(error);
        }
    }
    #[tokio::test]
    #[ignore = "requires disposable PostgreSQL fixture on localhost:55439"]
    async fn live_postgres_columns() {
        use crate::columns::{Action, ColumnDraft};
        use futures_util::FutureExt;
        let config = PgConfig {
            host: "127.0.0.1".into(),
            port: 55439,
            database: "playground_qa".into(),
            user: "postgres".into(),
            ssl_mode: "disable".into(),
            read_only: false,
        };
        let pool = open_pool(&config, "playground_qa_only").await.unwrap();
        let s = Session {
            pool: pool.clone(),
            connection: Mutex::new(Some(pool.acquire().await.unwrap())),
            pid: 0,
            read_only: false,
            running: AtomicBool::new(false),
        };
        let schema = format!("columns_qa_{}", uuid::Uuid::new_v4().simple());
        let result=std::panic::AssertUnwindSafe(async {
            sqlx::raw_sql(&format!("CREATE SCHEMA {schema};CREATE TABLE {schema}.items(id integer PRIMARY KEY,name varchar(30) COLLATE \"C\",n integer DEFAULT 5,seq bigint GENERATED ALWAYS AS IDENTITY);INSERT INTO {schema}.items(id,name) VALUES(1,'Alpha'),(2,NULL);CREATE TABLE {schema}.no_key(k integer NOT NULL);INSERT INTO {schema}.no_key VALUES(1),(2);")).execute(&pool).await.unwrap();
            let oid:i64=sqlx::query_scalar("SELECT to_regclass($1)::oid::bigint").bind(format!("{schema}.items")).fetch_one(&pool).await.unwrap();
            let context=||async {column_context(&mut pool.acquire().await.unwrap(),oid).await.unwrap()};
            let draft=|c:&columns::ColumnInfo|ColumnDraft{name:c.name.clone(),data_type:c.data_type.clone(),nullable:c.nullable,default_value:c.default_value.clone(),unique:!c.unique_constraints.is_empty(),primary_key:c.primary_key};
            let before=context().await;
            let add=ColumnChange{action:Action::Add,column_id:None,column:Some(ColumnDraft{name:"nickname".into(),data_type:"varchar(20)".into(),nullable:true,default_value:"'O''Brien'".into(),unique:false,primary_key:false}),expected:before.clone()};
            change_column(&s,oid,add.clone()).await.unwrap();
            let ctx=context().await;let col=ctx.columns.iter().find(|c|c.name=="nickname").unwrap();
            let value:String=sqlx::query_scalar(&format!("SELECT nickname FROM {schema}.items WHERE id=1")).fetch_one(&pool).await.unwrap();assert_eq!(value,"O'Brien");
            let mut settings=draft(col);settings.name="nick\"name".into();settings.data_type="varchar(50)".into();settings.nullable=false;settings.default_value="'Updated'".into();
            change_column(&s,oid,ColumnChange{action:Action::Alter,column_id:Some(col.id.clone()),column:Some(settings),expected:ctx.clone()}).await.unwrap();
            let ctx=context().await;let col=ctx.columns.iter().find(|c|c.name=="nick\"name").unwrap();assert!(!col.nullable);assert!(col.data_type.contains("50"));
            let mut settings=draft(col);settings.unique=true;settings.default_value="'Rollback'".into();
            assert!(change_column(&s,oid,ColumnChange{action:Action::Alter,column_id:Some(col.id.clone()),column:Some(settings),expected:ctx.clone()}).await.is_err());assert_eq!(context().await,ctx);
            assert!(change_column(&s,oid,add).await.unwrap_err().message.contains("schema changed"));
            change_column(&s,oid,ColumnChange{action:Action::Drop,column_id:Some(col.id.clone()),column:None,expected:ctx.clone()}).await.unwrap();
            let ctx=context().await;assert!(!ctx.columns.iter().any(|c|c.name=="nick\"name"));
            let pk=ctx.columns.iter().find(|c|c.name=="id").unwrap();assert!(change_column(&s,oid,ColumnChange{action:Action::Drop,column_id:Some(pk.id.clone()),column:None,expected:ctx.clone()}).await.is_err());
            let col=ctx.columns.iter().find(|c|c.name=="name").unwrap();let mut settings=draft(col);settings.nullable=false;settings.default_value="'Fill'".into();
            assert!(change_column(&s,oid,ColumnChange{action:Action::Alter,column_id:Some(col.id.clone()),column:Some(settings),expected:ctx.clone()}).await.is_err());assert_eq!(context().await,ctx);
            let mut settings=draft(col);settings.data_type="varchar(2)".into();assert!(change_column(&s,oid,ColumnChange{action:Action::Alter,column_id:Some(col.id.clone()),column:Some(settings),expected:ctx.clone()}).await.is_err());assert_eq!(context().await,ctx);
            let mut settings=draft(col);settings.unique=true;change_column(&s,oid,ColumnChange{action:Action::Alter,column_id:Some(col.id.clone()),column:Some(settings),expected:ctx.clone()}).await.unwrap();
            let ctx=context().await;let col=ctx.columns.iter().find(|c|c.name=="name").unwrap();assert_eq!(col.unique_constraints.len(),1);
            let mut settings=draft(col);settings.unique=false;change_column(&s,oid,ColumnChange{action:Action::Alter,column_id:Some(col.id.clone()),column:Some(settings),expected:ctx.clone()}).await.unwrap();
            let ctx=context().await;let col=ctx.columns.iter().find(|c|c.name=="name").unwrap();let original_collation=col.collation.clone();let mut settings=draft(col);settings.data_type="varchar(60)".into();change_column(&s,oid,ColumnChange{action:Action::Alter,column_id:Some(col.id.clone()),column:Some(settings),expected:ctx.clone()}).await.unwrap();assert_eq!(context().await.columns.iter().find(|c|c.name=="name").unwrap().collation,original_collation);
            sqlx::query(&format!("CREATE INDEX ON {schema}.items(name)")).execute(&pool).await.unwrap();
            let ctx=context().await;let col=ctx.columns.iter().find(|c|c.name=="name").unwrap();assert!(!col.dependencies.is_empty());assert!(change_column(&s,oid,ColumnChange{action:Action::Drop,column_id:Some(col.id.clone()),column:None,expected:ctx.clone()}).await.is_err());
            let generated=ctx.columns.iter().find(|c|c.name=="seq").unwrap();assert!(generated.generated);let mut settings=draft(generated);settings.name="renamed_seq".into();change_column(&s,oid,ColumnChange{action:Action::Alter,column_id:Some(generated.id.clone()),column:Some(settings),expected:ctx.clone()}).await.unwrap();
            let keyless:i64=sqlx::query_scalar("SELECT to_regclass($1)::oid::bigint").bind(format!("{schema}.no_key")).fetch_one(&pool).await.unwrap();let ctx=column_context(&mut pool.acquire().await.unwrap(),keyless).await.unwrap();let mut settings=draft(&ctx.columns[0]);settings.primary_key=true;change_column(&s,keyless,ColumnChange{action:Action::Alter,column_id:Some(ctx.columns[0].id.clone()),column:Some(settings),expected:ctx}).await.unwrap();
            assert!(column_context(&mut pool.acquire().await.unwrap(),keyless).await.unwrap().columns[0].primary_key);
        }).catch_unwind().await;
        sqlx::raw_sql(&format!("DROP SCHEMA IF EXISTS {schema} CASCADE"))
            .execute(&pool)
            .await
            .unwrap();
        s.connection.lock().await.take();
        pool.close().await;
        if let Err(error) = result {
            std::panic::resume_unwind(error);
        }
    }
    #[tokio::test]
    #[ignore = "requires disposable PostgreSQL fixture on localhost:55440"]
    async fn live_postgres_database_contexts() {
        let state = PgState::default();
        let config = PgConfig {
            host: "127.0.0.1".into(),
            port: 55440,
            database: "postgres".into(),
            user: "postgres".into(),
            ssl_mode: "disable".into(),
            read_only: true,
        };
        let first = connect(&state, config, "multidb_qa_only".into())
            .await
            .unwrap();
        let first_id = first["sessionId"].as_str().unwrap();
        let second = open_database(&state, first_id, "analytics_qa")
            .await
            .unwrap();
        let second_id = second["sessionId"].as_str().unwrap();
        assert_ne!(first_id, second_id);
        let a = session(&state, first_id).await.unwrap();
        let b = session(&state, second_id).await.unwrap();
        assert!(b.read_only);
        let (ra, rb) = tokio::join!(
            run(&a, "SELECT current_database() AS db", 10),
            run(&b, "SELECT current_database() AS db", 10)
        );
        assert_eq!(ra.unwrap().rows[0]["db"], json!("postgres"));
        assert_eq!(rb.unwrap().rows[0]["db"], json!("analytics_qa"));
        assert!(
            run(&b, "CREATE TABLE forbidden(id integer)", 10)
                .await
                .is_err()
        );
        assert!(
            open_database(&state, first_id, "absent_db_qa")
                .await
                .is_err()
        );
        assert_eq!(
            run(&a, "SELECT current_database() AS db", 10)
                .await
                .unwrap()
                .rows[0]["db"],
            json!("postgres")
        );
        assert!(
            second["catalog"]["tables"]
                .as_array()
                .unwrap()
                .iter()
                .any(|t| t["name"] == "database_marker")
        );
        for s in [a, b] {
            s.connection.lock().await.take();
            s.pool.close().await;
        }
    }
}
