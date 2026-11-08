use crate::columns::{self, ColumnChange, ColumnContext, ColumnInfo, Engine, Operation};
use crate::grid::{self, GridChange, GridColumn};
// SQL Server over TDS. Credentials and sockets are scoped to a desktop session.
use futures_util::TryStreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sqlparser::{
    ast::Statement,
    dialect::MsSqlDialect,
    parser::Parser,
    tokenizer::{Token, Tokenizer},
};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tiberius::{AuthMethod, Client, ColumnData, Config, EncryptionLevel, FromSql, QueryItem};
use tokio::{
    net::TcpStream,
    sync::{Mutex, Notify},
};
use tokio_util::compat::{Compat, TokioAsyncWriteCompatExt};
type MsClient = Client<Compat<TcpStream>>;
#[derive(Default)]
pub struct MsState {
    sessions: Mutex<HashMap<String, Arc<Session>>>,
}
struct Session {
    config: Config,
    client: Mutex<Option<MsClient>>,
    read_only: bool,
    running: AtomicBool,
    cancel: Notify,
    stop: Notify,
    attention: tiberius::CancelHandle,
    validation: Mutex<()>,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MsConfig {
    #[serde(default = "sql_auth")]
    auth: String,
    host: String,
    port: u16,
    database: String,
    user: String,
    encrypt: bool,
    trust_certificate: bool,
    read_only: bool,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Failure {
    message: String,
    code: Option<u32>,
    line: Option<u32>,
    closed: bool,
    uncertain: bool,
    messages: Vec<String>,
    result_sets: Vec<ResultSet>,
}
impl Failure {
    fn message(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            code: None,
            line: None,
            closed: false,
            uncertain: false,
            messages: vec![],
            result_sets: vec![],
        }
    }
    fn closed(message: &str) -> Self {
        Self {
            closed: true,
            ..Self::message(message)
        }
    }
}
impl From<tiberius::error::Error> for Failure {
    fn from(e: tiberius::error::Error) -> Self {
        match e {
            tiberius::error::Error::Server(e) => Self {
                message: e.message().into(),
                code: Some(e.code()),
                line: Some(e.line()),
                closed: false,
                uncertain: false,
                messages: vec![],
                result_sets: vec![],
            },
            e => Self {
                closed: matches!(
                    &e,
                    tiberius::error::Error::Io { .. }
                        | tiberius::error::Error::Protocol(_)
                        | tiberius::error::Error::Tls(_)
                ),
                ..Self::message(e.to_string())
            },
        }
    }
}
struct Running<'a>(&'a AtomicBool);
impl Drop for Running<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct ResultSet {
    columns: Vec<String>,
    column_types: Vec<String>,
    rows: Vec<Value>,
    affected_rows: u64,
    truncated: bool,
    messages: Vec<String>,
}
fn result_column_type(kind: tiberius::ColumnType) -> &'static str {
    use tiberius::ColumnType::*;
    match kind {
        Null => "null",
        Bit | Bitn => "bit",
        Int1 => "tinyint",
        Int2 => "smallint",
        Int4 => "int",
        Int8 => "bigint",
        Intn => "integer",
        Datetime4 => "smalldatetime",
        Float4 => "real",
        Float8 | Floatn => "float",
        Money => "money",
        Money4 => "smallmoney",
        Datetime | Datetimen => "datetime",
        Guid => "uniqueidentifier",
        Decimaln => "decimal",
        Numericn => "numeric",
        Daten => "date",
        Timen => "time",
        Datetime2 => "datetime2",
        DatetimeOffsetn => "datetimeoffset",
        BigVarBin => "varbinary",
        BigVarChar => "varchar",
        BigBinary => "binary",
        BigChar => "char",
        NVarchar => "nvarchar",
        NChar => "nchar",
        Xml => "xml",
        Udt => "udt",
        Text => "text",
        Image => "image",
        NText => "ntext",
        SSVariant => "sql_variant",
    }
}
fn quote(name: &str) -> String {
    format!("[{}]", name.replace(']', "]]"))
}
fn sql_auth() -> String {
    "sql".into()
}
fn options(c: &MsConfig, password: String) -> Result<Config, Failure> {
    if c.host.trim().is_empty()
        || c.port == 0
        || c.database.trim().is_empty()
        || (c.auth != "windows" && c.user.trim().is_empty())
        || c.host.contains('\\')
    {
        return Err(Failure::message(
            "Host, TCP port, database and SQL login are required. For named instances, use the server host and its TCP port.",
        ));
    }
    let mut config = Config::new();
    config.host(c.host.trim());
    config.port(c.port);
    config.database(c.database.trim());
    match c.auth.as_str() {
        "sql" => {
            config.authentication(AuthMethod::sql_server(c.user.trim(), password));
        }
        "windows" => {
            #[cfg(windows)]
            {
                config.authentication(AuthMethod::Integrated);
            }
            #[cfg(not(windows))]
            {
                return Err(Failure::message(
                    "Windows authentication is available in the Windows desktop app. Use SQL Server login on macOS.",
                ));
            }
        }
        _ => return Err(Failure::message("Invalid SQL Server authentication mode.")),
    }
    config.application_name("Max Learning");
    config.encryption(if c.encrypt {
        EncryptionLevel::Required
    } else {
        EncryptionLevel::NotSupported
    });
    if c.trust_certificate {
        config.trust_cert();
    }
    Ok(config)
}
async fn open(config: Config) -> Result<MsClient, Failure> {
    let endpoint = config.get_addr();
    tokio::time::timeout(Duration::from_secs(12),async {
        let tcp=TcpStream::connect(&endpoint).await.map_err(|e| Failure::message(format!("Could not connect to SQL Server at {endpoint}: {e}. Check TCP/IP, port and firewall.")))?;
        tcp.set_nodelay(true).map_err(|e|Failure::message(e.to_string()))?;
        let mut client=Client::connect(config,tcp.compat_write()).await?;
        client.simple_query("SET LOCK_TIMEOUT 5000; SET QUOTED_IDENTIFIER ON;").await?.into_results().await?;
        Ok(client)
    }).await.map_err(|_|Failure::message(format!("SQL Server at {endpoint} did not respond within 12 seconds. Check TCP/IP, port, TLS and firewall.")))?
}
async fn session(state: &MsState, id: &str) -> Result<Arc<Session>, Failure> {
    state
        .sessions
        .lock()
        .await
        .get(id)
        .cloned()
        .ok_or_else(|| Failure::closed("Connection closed. Connect again to continue."))
}
fn unique_names(names: impl Iterator<Item = String>) -> Vec<String> {
    let mut used = HashSet::new();
    names
        .enumerate()
        .map(|(i, name)| {
            let base = if name.is_empty() {
                format!("Column {}", i + 1)
            } else {
                name
            };
            let mut name = base.clone();
            let mut n = 2;
            while !used.insert(name.clone()) {
                name = format!("{base} ({n})");
                n += 1;
            }
            name
        })
        .collect()
}
fn cell(data: ColumnData<'static>) -> Result<Value, Failure> {
    use ColumnData::*;
    Ok(match data {
        U8(v) => json!(v),
        I16(v) => json!(v),
        I32(v) => json!(v),
        I64(v) => v
            .map(|v| {
                if (-9_007_199_254_740_991..=9_007_199_254_740_991).contains(&v) {
                    json!(v)
                } else {
                    json!(v.to_string())
                }
            })
            .unwrap_or(Value::Null),
        F32(v) => json!(v),
        F64(v) => json!(v),
        Bit(v) => json!(v),
        String(v) => json!(v),
        Guid(v) => json!(v.map(|v| v.to_string())),
        Binary(v) => json!(v.map(|v| {
            let mut s = std::string::String::from("0x");
            for byte in v.iter() {
                use std::fmt::Write;
                let _ = write!(s, "{byte:02X}");
            }
            s
        })),
        Numeric(v) => json!(v.map(|v| v.to_string())),
        Xml(v) => json!(v.map(|v| v.to_string())),
        ref value @ Date(_) => json!(chrono::NaiveDate::from_sql(value)?.map(|v| v.to_string())),
        ref value @ Time(_) => json!(chrono::NaiveTime::from_sql(value)?.map(|v| v.to_string())),
        ref value @ (DateTime(_) | SmallDateTime(_) | DateTime2(_)) => {
            json!(chrono::NaiveDateTime::from_sql(value)?.map(|v| v.to_string()))
        }
        ref value @ DateTimeOffset(_) => {
            json!(chrono::DateTime::<chrono::FixedOffset>::from_sql(value)?.map(|v| v.to_rfc3339()))
        }
    })
}
async fn collect(
    client: &mut MsClient,
    sql: &str,
    limit: usize,
) -> Result<Vec<ResultSet>, Failure> {
    let observer = client.cancellation_handle();
    observer.take_messages();
    let mut sets: Vec<ResultSet> = vec![];
    let result: Result<(), Failure> = async {
        let mut stream = client.simple_query(sql).await?;
        let mut total = 0;
        while let Some(item) = stream.try_next().await? {
            match item {
                QueryItem::Metadata(metadata) => {
                    if sets.len() >= 50 {
                        return Err(Failure::closed(
                            "Too many result sets (maximum 50). Reconnect and narrow the batch.",
                        ));
                    }
                    sets.push(ResultSet {
                        columns: unique_names(
                            metadata.columns().iter().map(|c| c.name().to_owned()),
                        ),
                        column_types: metadata
                            .columns()
                            .iter()
                            .map(|c| result_column_type(c.column_type()).to_owned())
                            .collect(),
                        ..Default::default()
                    });
                }
                QueryItem::Row(row) => {
                    let set = sets
                        .last_mut()
                        .ok_or_else(|| Failure::message("Missing SQL Server result metadata."))?;
                    if set.rows.len() >= limit || total >= 10000 {
                        set.truncated = true;
                        continue;
                    }
                    let mut record = Map::new();
                    for (name, value) in set.columns.iter().zip(row) {
                        record.insert(name.clone(), cell(value)?);
                    }
                    set.rows.push(Value::Object(record));
                    total += 1;
                }
            }
        }
        Ok(())
    }
    .await;
    let messages = observer.take_messages();
    match result {
        Ok(()) => {
            if sets.is_empty() {
                sets.push(ResultSet::default());
            }
            sets[0].messages = messages;
            Ok(sets)
        }
        Err(mut error) => {
            error.messages = messages;
            error.result_sets = sets;
            Err(error)
        }
    }
}
// SQL Server has no per-transaction READ ONLY mode. This is a conservative query
// guard, not a permission boundary. Restricted SQL logins enforce access at the server.
fn query_only(sql: &str) -> Result<(), Failure> {
    let dialect = MsSqlDialect {};
    let statements=Parser::parse_sql(&dialect,sql).map_err(|e|Failure::message(format!("Query-only guard could not verify this T-SQL. Use a read-only SQL login or disable the guard to run it. {e}")))?;
    if statements.is_empty() || statements.iter().any(|s| !matches!(s, Statement::Query(_))) {
        return Err(Failure::message(
            "Query-only connection: only SELECT queries are allowed. Reconnect with the guard disabled to write.",
        ));
    }
    let tokens = Tokenizer::new(&dialect, sql)
        .tokenize()
        .map_err(|e| Failure::message(e.to_string()))?;
    let forbidden = [
        "INTO",
        "INSERT",
        "UPDATE",
        "DELETE",
        "MERGE",
        "EXEC",
        "EXECUTE",
        "OPENROWSET",
        "OPENQUERY",
        "OPENDATASOURCE",
        "NEXT",
    ];
    if tokens.iter().any(|t|matches!(t,Token::Word(w) if w.quote_style.is_none() && forbidden.contains(&w.value.to_uppercase().as_str()))) {return Err(Failure::message("Query-only guard blocked a write or external-access clause. Disable the guard only if you intend to execute it."));}
    Ok(())
}
async fn run(s: &Session, sql: &str, limit: usize) -> Result<Vec<ResultSet>, Failure> {
    if s.read_only {
        query_only(sql)?;
    }
    if s.running.swap(true, Ordering::SeqCst) {
        return Err(Failure::message(
            "Another query is running on this connection.",
        ));
    }
    let _running = Running(&s.running);
    let mut guard = s.client.lock().await;
    let mut client = guard
        .take()
        .ok_or_else(|| Failure::closed("Connection closed. Reconnect to continue."))?;
    s.attention.arm();
    let result = {
        // Keep the token decoder alive while ATTENTION is sent and acknowledged.
        // Dropping collect mid-token would leave the connection unsynchronized.
        let query = collect(&mut client, sql, limit);
        tokio::pin!(query);
        let deadline = tokio::time::sleep(Duration::from_secs(60));
        tokio::pin!(deadline);
        loop {
            tokio::select! {
                biased;
                _ = s.cancel.notified() => break Err(Failure::closed("Connection disconnected.")),
                _ = s.stop.notified() => {
                    if !s.attention.requested() { continue; }
                    let drained = tokio::time::timeout(Duration::from_secs(5), &mut query).await;
                    break if s.attention.acknowledged() && !matches!(&drained, Ok(Err(e)) if e.closed) {
                        Err(Failure::message("Query stopped. Connection kept open; remaining batches were skipped."))
                    } else {
                        Err(Failure::closed("Cancellation could not synchronize the SQL Server session. Reconnect to continue."))
                    };
                }
                result = &mut query => break if s.attention.requested() {
                    if s.attention.acknowledged() && !matches!(&result, Err(e) if e.closed) {
                        Err(Failure::message("Query stopped. Connection kept open; remaining batches were skipped."))
                    } else { Err(Failure::closed("SQL Server did not acknowledge cancellation. Reconnect to continue.")) }
                } else { result },
                _ = &mut deadline => {
                    s.attention.cancel();
                    let drained = tokio::time::timeout(Duration::from_secs(5), &mut query).await;
                    break if s.attention.acknowledged() && !matches!(&drained, Ok(Err(e)) if e.closed) {
                        Err(Failure::message("Query exceeded 60 seconds and was stopped. Connection kept open."))
                    } else { Err(Failure::closed("Query timed out and the session could not recover. Reconnect to continue.")) };
                }
            }
        }
    };
    if !matches!(&result,Err(e) if e.closed) {
        *guard = Some(client);
    }
    result
}
async fn catalog(client: &mut MsClient) -> Result<Value, Failure> {
    let rows=client.simple_query(r#"
SELECT o.object_id, s.name AS schema_name, o.name AS table_name, o.type AS kind,
 c.column_id, c.name AS column_name,
 ty.name + CASE WHEN ty.name IN ('varchar','char','varbinary','binary','nvarchar','nchar') THEN '(' + CASE WHEN c.max_length=-1 THEN 'max' ELSE CONVERT(varchar(10), CASE WHEN ty.name IN ('nvarchar','nchar') THEN c.max_length/2 ELSE c.max_length END) END + ')'
 WHEN ty.name IN ('numeric','decimal') THEN '('+CONVERT(varchar(10),c.precision)+','+CONVERT(varchar(10),c.scale)+')' ELSE '' END AS type_name,
 bt.name AS base_type, c.is_nullable, c.is_identity, c.is_computed, c.generated_always_type, c.default_object_id,
 CAST(CASE WHEN bt.name IN ('timestamp','rowversion') THEN 1 ELSE 0 END AS bit) AS version_column,
 CAST(CASE WHEN EXISTS(SELECT 1 FROM sys.indexes i JOIN sys.index_columns ic ON ic.object_id=i.object_id AND ic.index_id=i.index_id WHERE i.object_id=o.object_id AND i.is_primary_key=1 AND ic.column_id=c.column_id) THEN 1 ELSE 0 END AS bit) AS primary_key
FROM sys.objects o JOIN sys.schemas s ON s.schema_id=o.schema_id JOIN sys.columns c ON c.object_id=o.object_id JOIN sys.types ty ON ty.user_type_id=c.user_type_id JOIN sys.types bt ON bt.user_type_id=c.system_type_id
WHERE o.type IN ('U','V') AND c.is_hidden=0 AND o.is_ms_shipped=0 AND HAS_PERMS_BY_NAME(QUOTENAME(s.name)+'.'+QUOTENAME(o.name),'OBJECT','SELECT')=1
ORDER BY s.name,o.name,c.column_id;
"#).await?.into_first_result().await?;
    let mut tables = BTreeMap::<i32, Value>::new();
    for row in rows {
        let object: i32 = row
            .try_get("object_id")?
            .ok_or_else(|| Failure::message("Missing SQL Server object metadata."))?;
        let column: i32 = row
            .try_get("column_id")?
            .ok_or_else(|| Failure::message("Missing SQL Server object metadata."))?;
        let table=tables.entry(object).or_insert_with(||json!({"id":object.to_string(),"schema":row.get::<&str,_>("schema_name"),"name":row.get::<&str,_>("table_name"),"kind":row.get::<&str,_>("kind"),"columns":[]}));
        table["columns"].as_array_mut().unwrap().push(json!({"id":format!("{object}:{column}"),"name":row.get::<&str,_>("column_name"),"type":row.get::<&str,_>("type_name"),"nullable":row.get::<bool,_>("is_nullable"),"generated":row.get::<bool,_>("is_identity").unwrap_or(false)||row.get::<bool,_>("is_computed").unwrap_or(false)||row.get::<u8,_>("generated_always_type").unwrap_or(0)>0||row.get::<bool,_>("version_column").unwrap_or(false),"defaultValue":if row.get::<i32,_>("default_object_id").unwrap_or(0)>0 {"DEFAULT"} else {""},"readOnly":!ms_writable(row.get::<&str,_>("base_type").unwrap_or("")),"primaryKey":row.get::<bool,_>("primary_key")}));
    }
    let rows=client.simple_query("SELECT constraint_object_id,parent_object_id,referenced_object_id,parent_column_id,referenced_column_id FROM sys.foreign_key_columns ORDER BY constraint_object_id,constraint_column_id").await?.into_first_result().await?;
    let mut relations = BTreeMap::<i32, Value>::new();
    for row in rows {
        let id: i32 = row
            .try_get(0)?
            .ok_or_else(|| Failure::message("Missing SQL Server object metadata."))?;
        let source: i32 = row
            .try_get(1)?
            .ok_or_else(|| Failure::message("Missing SQL Server object metadata."))?;
        let target: i32 = row
            .try_get(2)?
            .ok_or_else(|| Failure::message("Missing SQL Server object metadata."))?;
        let sc: i32 = row
            .try_get(3)?
            .ok_or_else(|| Failure::message("Missing SQL Server object metadata."))?;
        let tc: i32 = row
            .try_get(4)?
            .ok_or_else(|| Failure::message("Missing SQL Server object metadata."))?;
        if !tables.contains_key(&source) || !tables.contains_key(&target) {
            continue;
        }
        let relation=relations.entry(id).or_insert_with(||json!({"id":format!("fk:{id}"),"sourceTable":source.to_string(),"targetTable":target.to_string(),"sourceColumns":[],"targetColumns":[]}));
        relation["sourceColumns"]
            .as_array_mut()
            .unwrap()
            .push(json!(format!("{source}:{sc}")));
        relation["targetColumns"]
            .as_array_mut()
            .unwrap()
            .push(json!(format!("{target}:{tc}")));
    }
    Ok(
        json!({"tables":tables.into_values().collect::<Vec<_>>(),"relationships":relations.into_values().collect::<Vec<_>>()}),
    )
}
async fn metadata(config: Config) -> Result<(String, Value, MsClient), Failure> {
    let mut client = open(config).await?;
    let result = tokio::time::timeout(Duration::from_secs(15), async {
        let row = client
            .simple_query("SELECT CONVERT(varchar(128),SERVERPROPERTY('ProductVersion'))")
            .await?
            .into_row()
            .await?
            .ok_or_else(|| Failure::message("SQL Server returned no version."))?;
        let version = row.get::<&str, _>(0).unwrap_or("").to_string();
        let catalog = catalog(&mut client).await?;
        Ok::<_, Failure>((version, catalog))
    })
    .await
    .map_err(|_| Failure::message("SQL Server schema inspection timed out."))??;
    Ok((result.0, result.1, client))
}
#[tauri::command]
pub async fn ms_test_connection(config: MsConfig, password: String) -> Result<Value, Failure> {
    let (version, _, _) = metadata(options(&config, password)?).await?;
    Ok(json!({"serverVersion":version}))
}
#[tauri::command]
pub async fn ms_connect(
    state: tauri::State<'_, MsState>,
    config: MsConfig,
    password: String,
) -> Result<Value, Failure> {
    let opts = options(&config, password)?;
    connect_options(&state, opts, config.read_only).await
}
async fn connect_options(state: &MsState, opts: Config, read_only: bool) -> Result<Value, Failure> {
    let (version, catalog, client) = metadata(opts.clone()).await?;
    let id = uuid::Uuid::new_v4().to_string();
    state.sessions.lock().await.insert(
        id.clone(),
        Arc::new(Session {
            config: opts,
            attention: client.cancellation_handle(),
            stop: Notify::new(),
            client: Mutex::new(Some(client)),
            read_only,
            running: AtomicBool::new(false),
            cancel: Notify::new(),
            validation: Mutex::new(()),
        }),
    );
    Ok(json!({"sessionId":id,"serverVersion":version,"catalog":catalog}))
}
#[tauri::command]
pub async fn ms_databases(
    state: tauri::State<'_, MsState>,
    session_id: String,
) -> Result<Vec<String>, Failure> {
    let s = session(&state, &session_id).await?;
    // Discovery has its own socket so it never changes the editor's transaction or database.
    let mut client = open(s.config.clone()).await?;
    let rows = client.simple_query("SELECT name FROM sys.databases WHERE state = 0 AND HAS_DBACCESS(name) = 1 ORDER BY name").await?.into_first_result().await?;
    Ok(rows
        .iter()
        .filter_map(|row| row.get::<&str, _>(0).map(str::to_owned))
        .collect())
}
#[tauri::command]
pub async fn ms_open_database(
    state: tauri::State<'_, MsState>,
    session_id: String,
    database: String,
) -> Result<Value, Failure> {
    open_database(&state, &session_id, &database).await
}
async fn open_database(
    state: &MsState,
    session_id: &str,
    database: &str,
) -> Result<Value, Failure> {
    if database.is_empty() || database.contains('\0') {
        return Err(Failure::message("Invalid database name."));
    }
    let s = session(&state, &session_id).await?;
    let mut opts = s.config.clone();
    opts.database(database);
    connect_options(&state, opts, s.read_only).await
}
#[tauri::command]
pub async fn ms_disconnect(
    state: tauri::State<'_, MsState>,
    session_id: String,
) -> Result<(), Failure> {
    if let Some(s) = state.sessions.lock().await.remove(&session_id) {
        s.cancel.notify_one();
        s.client.lock().await.take();
    }
    Ok(())
}
#[tauri::command]
pub async fn ms_cancel(
    state: tauri::State<'_, MsState>,
    session_id: String,
) -> Result<(), Failure> {
    let s = session(&state, &session_id).await?;
    if s.running.load(Ordering::SeqCst) && s.attention.cancel() {
        s.stop.notify_one();
    }
    Ok(())
}
#[tauri::command]
pub async fn ms_catalog(
    state: tauri::State<'_, MsState>,
    session_id: String,
) -> Result<Value, Failure> {
    let s = session(&state, &session_id).await?;
    let (_, catalog, _) = metadata(s.config.clone()).await?;
    Ok(catalog)
}
#[tauri::command]
pub async fn ms_query(
    state: tauri::State<'_, MsState>,
    session_id: String,
    sql: String,
) -> Result<Value, Failure> {
    let s = session(&state, &session_id).await?;
    let sets = run(&s, &sql, 1000).await?;
    let mut result = serde_json::to_value(&sets[0]).map_err(|e| Failure::message(e.to_string()))?;
    result["resultSets"] =
        serde_json::to_value(sets).map_err(|e| Failure::message(e.to_string()))?;
    Ok(result)
}
#[tauri::command]
pub async fn ms_table_data(
    state: tauri::State<'_, MsState>,
    session_id: String,
    table_id: String,
    page: u32,
) -> Result<Value, Failure> {
    let s = session(&state, &session_id).await?;
    let object: i32 = table_id
        .parse()
        .map_err(|_| Failure::message("Invalid table ID."))?;
    let mut meta = open(s.config.clone()).await?;
    let rows=tokio::time::timeout(Duration::from_secs(15),async {
        let row=meta.query("SELECT s.name,o.name FROM sys.objects o JOIN sys.schemas s ON o.schema_id=s.schema_id WHERE o.object_id=@P1 AND o.type IN ('U','V') AND HAS_PERMS_BY_NAME(QUOTENAME(s.name)+'.'+QUOTENAME(o.name),'OBJECT','SELECT')=1",&[&object]).await?.into_row().await?.ok_or_else(||Failure::message("Table unavailable or SELECT permission denied."))?;
        let table=format!("{}.{}",quote(row.try_get(0)?.ok_or_else(|| Failure::message("Missing schema name."))?),quote(row.try_get(1)?.ok_or_else(|| Failure::message("Missing table name."))?));
        let keys=meta.query("SELECT c.name FROM sys.indexes i JOIN sys.index_columns ic ON ic.object_id=i.object_id AND ic.index_id=i.index_id JOIN sys.columns c ON c.object_id=ic.object_id AND c.column_id=ic.column_id WHERE i.object_id=@P1 AND i.is_primary_key=1 ORDER BY ic.key_ordinal",&[&object]).await?.into_first_result().await?;
        let order=if keys.is_empty() {"(SELECT NULL)".to_string()} else {keys.iter().map(|r|r.try_get::<&str,_>(0).map(|v| quote(v.unwrap_or("")))).collect::<Result<Vec<_>,_>>()?.join(",")};
        Ok::<_,Failure>((table,order))
    }).await.map_err(|_|Failure::message("Table inspection timed out."))??;
    let sql = format!(
        "SELECT * FROM {} ORDER BY {} OFFSET {} ROWS FETCH NEXT 101 ROWS ONLY",
        rows.0,
        rows.1,
        u64::from(page) * 100
    );
    let mut sets = tokio::time::timeout(Duration::from_secs(60), collect(&mut meta, &sql, 100))
        .await
        .map_err(|_| Failure::message("Table preview timed out."))??;
    serde_json::to_value(sets.remove(0)).map_err(|e| Failure::message(e.to_string()))
}
#[derive(Serialize)]
pub struct Diagnostic {
    start: usize,
    end: usize,
    message: String,
    warning: bool,
}
#[tauri::command]
pub async fn ms_validate(
    state: tauri::State<'_, MsState>,
    session_id: String,
    sql: String,
) -> Result<Vec<Diagnostic>, Failure> {
    if sql.trim().is_empty() {
        return Ok(vec![]);
    }
    let s = session(&state, &session_id).await?;
    let _validation = s
        .validation
        .try_lock()
        .map_err(|_| Failure::message("SQL validation is busy."))?;
    let mut client = open(s.config.clone()).await?;
    // Metadata inspection compiles the text without executing user statements.
    let result=tokio::time::timeout(Duration::from_secs(10), async {
        client.query("EXEC sys.sp_describe_first_result_set @tsql=@P1, @params=NULL, @browse_information_mode=0",&[&sql]).await?.into_results().await?;
        Ok::<_,tiberius::error::Error>(())
    }).await.map_err(|_|Failure::message("SQL validation timed out."))?;
    match result {
        Ok(()) => Ok(vec![]),
        Err(error) => {
            let e = Failure::from(error);
            let start = sql
                .split_inclusive('\n')
                .take(e.line.unwrap_or(1).saturating_sub(1) as usize)
                .map(|l| l.encode_utf16().count())
                .sum::<usize>()
                .min(sql.encode_utf16().count());
            Ok(vec![Diagnostic {
                start,
                end: start + 1,
                message: e.message,
                warning: !matches!(e.code, Some(102 | 105 | 156 | 207 | 208 | 209 | 4104)),
            }])
        }
    }
}
fn ms_writable(kind: &str) -> bool {
    let kind = kind.split('(').next().unwrap_or(kind);
    matches!(
        kind,
        "tinyint"
            | "smallint"
            | "int"
            | "bigint"
            | "real"
            | "float"
            | "decimal"
            | "numeric"
            | "money"
            | "smallmoney"
            | "bit"
            | "varchar"
            | "nvarchar"
            | "char"
            | "nchar"
            | "text"
            | "ntext"
            | "date"
            | "time"
            | "datetime"
            | "smalldatetime"
            | "datetime2"
            | "datetimeoffset"
            | "uniqueidentifier"
            | "binary"
            | "varbinary"
            | "image"
            | "xml"
    )
}
fn ms_parameter(column: &GridColumn, index: usize) -> String {
    if matches!(column.kind.as_str(), "binary" | "varbinary" | "image") {
        format!("CONVERT(varbinary(max),@P{index},1)")
    } else if matches!(
        column.kind.as_str(),
        "varchar" | "nvarchar" | "char" | "nchar" | "text" | "ntext"
    ) {
        format!("CONVERT(nvarchar(max),@P{index})")
    } else {
        format!("CONVERT({},@P{index})", column.sql_type)
    }
}
async fn ms_bound_rows(
    client: &mut MsClient,
    sql: String,
    params: &[Option<String>],
) -> Result<Vec<tiberius::Row>, Failure> {
    let mut query = tiberius::Query::new(sql);
    for value in params {
        query.bind(value.as_deref());
    }
    Ok(query.query(client).await?.into_first_result().await?)
}
async fn save_grid(s: &Session, object: i32, changes: Vec<GridChange>) -> Result<usize, Failure> {
    if s.read_only {
        return Err(Failure::message(
            "Query-only connection. Reconnect with the guard disabled to edit data.",
        ));
    }
    let mut client = open(s.config.clone()).await?;
    client
        .simple_query("SET XACT_ABORT ON; SET ANSI_WARNINGS ON; BEGIN TRANSACTION;")
        .await?
        .into_results()
        .await?;
    let result=tokio::time::timeout(Duration::from_secs(60),async {
        let row=client.query("SELECT s.name,o.name FROM sys.objects o JOIN sys.schemas s ON s.schema_id=o.schema_id WHERE o.object_id=@P1 AND o.type='U' AND o.is_ms_shipped=0 AND HAS_PERMS_BY_NAME(QUOTENAME(s.name)+'.'+QUOTENAME(o.name),'OBJECT','SELECT')=1",&[&object]).await?.into_row().await?.ok_or_else(||Failure::message("Only ordinary tables with SELECT permission can be edited. Views are read-only."))?;
        let table=format!("{}.{}",quote(row.get(0).unwrap_or("")),quote(row.get(1).unwrap_or("")));
        // Short, bounded saves serialize writes on this table while snapshots are
        // checked, including inserts and metadata. No scan/count of the table.
        client.simple_query(format!("SELECT TOP (1) 1 FROM {table} WITH (TABLOCKX,HOLDLOCK)")).await?.into_results().await?;
        let actual=client.query("SELECT OBJECT_ID(@P1)",&[&table]).await?.into_row().await?.and_then(|r|r.get::<i32,_>(0));
        if actual!=Some(object) {return Err(Failure::message("The table was replaced. Refresh the schema."));}
        let metadata=client.query("SELECT c.name, bt.name AS kind, c.max_length, c.precision, c.scale, c.is_nullable, c.is_identity, c.is_computed, c.generated_always_type, c.default_object_id, CAST(CASE WHEN EXISTS(SELECT 1 FROM sys.indexes i JOIN sys.index_columns ic ON ic.object_id=i.object_id AND ic.index_id=i.index_id WHERE i.object_id=c.object_id AND i.is_primary_key=1 AND ic.column_id=c.column_id) THEN 1 ELSE 0 END AS bit) AS is_key FROM sys.columns c JOIN sys.types bt ON bt.user_type_id=c.system_type_id WHERE c.object_id=@P1 AND c.is_hidden=0 ORDER BY c.column_id",&[&object]).await?.into_first_result().await?;
        let columns:Vec<GridColumn>=metadata.iter().map(|r| {
            let name=r.get::<&str,_>("name").unwrap_or("").to_string();let kind=r.get::<&str,_>("kind").unwrap_or("").to_string();
            let sql_type=if matches!(kind.as_str(),"numeric"|"decimal") {format!("{}({},{})",kind,r.get::<u8,_>("precision").unwrap_or(18),r.get::<u8,_>("scale").unwrap_or(0))} else if matches!(kind.as_str(),"datetime2"|"datetimeoffset"|"time") {format!("{}({})",kind,r.get::<u8,_>("scale").unwrap_or(7))} else {kind.clone()};
            let generated=r.get::<bool,_>("is_identity").unwrap_or(false)||r.get::<bool,_>("is_computed").unwrap_or(false)||r.get::<u8,_>("generated_always_type").unwrap_or(0)>0||matches!(kind.as_str(),"timestamp"|"rowversion");
            GridColumn {name,sql_type,kind:kind.clone(),key:r.get::<bool,_>("is_key").unwrap_or(false),generated,writable:ms_writable(&kind)&&!generated,nullable:r.get::<bool,_>("is_nullable").unwrap_or(false),defaulted:r.get::<i32,_>("default_object_id").unwrap_or(0)>0||generated}
        }).collect();
        grid::validate(&columns,&changes).map_err(Failure::message)?;
        let mut affected=0;
        for change in &changes {
            let mut params=Vec::<Option<String>>::new();let mut predicate=Vec::new();
            if let Some(original)=&change.original {
                for key in columns.iter().filter(|c|c.key) {
                    if !ms_writable(&key.kind) {return Err(Failure::message("This primary key type is not supported by the grid. Use SQL to edit this table."));}
                    params.push(Some(grid::original_text(&original[&key.name]).map_err(Failure::message)?));predicate.push(format!("{}={}",quote(&key.name),ms_parameter(key,params.len())));
                }
                let rows=ms_bound_rows(&mut client,format!("SELECT * FROM {table} WHERE {}",predicate.join(" AND ")),&params).await?;
                if rows.len()!=1 {return Err(Failure::message("The row was deleted or its primary key changed. No changes were saved. Discard drafts and refresh."));}
                let mut snapshot=Map::new();
                for (c,value) in columns.iter().zip(rows.into_iter().next().unwrap()) {snapshot.insert(c.name.clone(),cell(value)?);}
                grid::check_original(&snapshot,original).map_err(Failure::message)?;
            }
            let sql=if change.deleted {format!("DELETE FROM {table} OUTPUT 1 INTO @dbpg_affected WHERE {}",predicate.join(" AND "))}
            else {
                let mut names=Vec::new();let mut values=Vec::new();let mut sets=Vec::new();
                for (name,value) in &change.cells {let c=columns.iter().find(|c|&c.name==name).unwrap();params.push(value.clone());let expression=ms_parameter(c,params.len());names.push(quote(name));values.push(expression.clone());sets.push(format!("{}={expression}",quote(name)));}
                if change.original.is_some() {if sets.is_empty() {continue;}format!("UPDATE {table} SET {} OUTPUT 1 INTO @dbpg_affected WHERE {}",sets.join(","),predicate.join(" AND "))}
                else if names.is_empty() {format!("INSERT INTO {table} OUTPUT 1 INTO @dbpg_affected DEFAULT VALUES")}
                else {format!("INSERT INTO {table} ({}) OUTPUT 1 INTO @dbpg_affected VALUES ({})",names.join(","),values.join(","))}
            };
            let sql=format!("DECLARE @dbpg_affected TABLE (n int); {sql}; SELECT COUNT_BIG(*) FROM @dbpg_affected;");
            let mut query=tiberius::Query::new(sql);for value in &params {query.bind(value.as_deref());}
            let results=query.query(&mut client).await?.into_results().await?;
            let count=results.last().and_then(|rows|rows.first()).and_then(|r|r.get::<i64,_>(0));
            if count!=Some(1) {return Err(Failure::message("A row was not changed exactly once. No changes were saved."));}
            affected+=1;
        }
        Ok::<_,Failure>(affected)
    }).await;
    match result {
        Ok(Ok(affected)) => {
            match tokio::time::timeout(Duration::from_secs(15), async {
                client
                    .simple_query("COMMIT TRANSACTION;")
                    .await?
                    .into_results()
                    .await?;
                Ok::<_, tiberius::error::Error>(())
            })
            .await
            {
                Ok(Ok(())) => Ok(affected),
                _ => Err(Failure {
                    uncertain: true,
                    ..Failure::message(
                        "Could not confirm COMMIT. The save outcome is unknown. Discard drafts and refresh before retrying.",
                    )
                }),
            }
        }
        other => {
            // Dropping this dedicated socket also rolls back if the server/transport fails.
            let _ = tokio::time::timeout(Duration::from_secs(5), async {
                client
                    .simple_query("IF @@TRANCOUNT>0 ROLLBACK TRANSACTION;")
                    .await?
                    .into_results()
                    .await?;
                Ok::<_, tiberius::error::Error>(())
            })
            .await;
            match other {
                Ok(Err(error)) => Err(error),
                _ => Err(Failure::message(
                    "Grid save timed out and was rolled back. Refresh before retrying.",
                )),
            }
        }
    }
}
#[tauri::command]
pub async fn ms_save_grid(
    state: tauri::State<'_, MsState>,
    session_id: String,
    table_id: String,
    changes: Vec<GridChange>,
) -> Result<usize, Failure> {
    let s = session(&state, &session_id).await?;
    let object = table_id
        .parse()
        .map_err(|_| Failure::message("Invalid table ID."))?;
    save_grid(&s, object, changes).await
}

async fn column_context(c: &mut MsClient, object: i32) -> Result<ColumnContext, Failure> {
    let table=c.query("SELECT s.name,o.name FROM sys.objects o JOIN sys.schemas s ON s.schema_id=o.schema_id WHERE o.object_id=@P1 AND o.type='U' AND o.is_ms_shipped=0 AND HAS_PERMS_BY_NAME(QUOTENAME(s.name)+'.'+QUOTENAME(o.name),'OBJECT','SELECT')=1",&[&object]).await?.into_row().await?.ok_or_else(||Failure::message("Only ordinary tables can be changed in this editor."))?;
    let rows=c.query(r#"
SELECT col.column_id,col.name,col.collation_name,col.is_nullable,col.is_identity,col.is_computed,col.generated_always_type,bt.name AS base_type,
 CASE WHEN ty.is_user_defined=1 THEN QUOTENAME(SCHEMA_NAME(ty.schema_id))+'.'+QUOTENAME(ty.name) ELSE ty.name+
 CASE WHEN ty.name IN ('varchar','nvarchar','char','nchar','binary','varbinary') THEN '('+CASE WHEN col.max_length=-1 THEN 'max' ELSE CONVERT(varchar(10),CASE WHEN ty.name IN ('nvarchar','nchar') THEN col.max_length/2 ELSE col.max_length END) END+')'
 WHEN ty.name IN ('numeric','decimal') THEN '('+CONVERT(varchar(10),col.precision)+','+CONVERT(varchar(10),col.scale)+')'
 WHEN ty.name IN ('time','datetime2','datetimeoffset') THEN '('+CONVERT(varchar(10),col.scale)+')' ELSE '' END END AS data_type,
 dc.definition AS default_value,dc.name AS default_constraint,
 CAST(CASE WHEN EXISTS(SELECT 1 FROM sys.indexes i JOIN sys.index_columns ic ON ic.object_id=i.object_id AND ic.index_id=i.index_id WHERE i.object_id=col.object_id AND i.is_primary_key=1 AND ic.column_id=col.column_id) THEN 1 ELSE 0 END AS bit) AS primary_key
FROM sys.columns col JOIN sys.types ty ON ty.user_type_id=col.user_type_id JOIN sys.types bt ON bt.user_type_id=col.system_type_id LEFT JOIN sys.default_constraints dc ON dc.object_id=col.default_object_id
WHERE col.object_id=@P1 AND col.is_hidden=0 ORDER BY col.column_id
"#,&[&object]).await?.into_first_result().await?;
    let uniques=c.query("SELECT ic.column_id,k.name FROM sys.key_constraints k JOIN sys.index_columns ic ON ic.object_id=k.parent_object_id AND ic.index_id=k.unique_index_id WHERE k.parent_object_id=@P1 AND k.type='UQ' AND ic.key_ordinal>0 AND (SELECT COUNT(*) FROM sys.index_columns ci WHERE ci.object_id=k.parent_object_id AND ci.index_id=k.unique_index_id AND ci.key_ordinal>0)=1 ORDER BY k.name",&[&object]).await?.into_first_result().await?;
    let dependencies=c.query(r#"
SELECT ic.column_id,'Index: '+i.name AS label FROM sys.indexes i JOIN sys.index_columns ic ON ic.object_id=i.object_id AND ic.index_id=i.index_id WHERE i.object_id=@P1 AND i.index_id>0
UNION SELECT f.parent_column_id,'Foreign key: '+fk.name FROM sys.foreign_key_columns f JOIN sys.foreign_keys fk ON fk.object_id=f.constraint_object_id WHERE f.parent_object_id=@P1
UNION SELECT f.referenced_column_id,'Foreign key: '+fk.name FROM sys.foreign_key_columns f JOIN sys.foreign_keys fk ON fk.object_id=f.constraint_object_id WHERE f.referenced_object_id=@P1
UNION SELECT CASE WHEN d.referenced_minor_id>0 THEN d.referenced_minor_id ELSE ck.parent_column_id END,'Check: '+ck.name FROM sys.check_constraints ck LEFT JOIN sys.sql_expression_dependencies d ON d.referencing_id=ck.object_id AND d.referenced_id=@P1 WHERE ck.parent_object_id=@P1 AND (d.referenced_minor_id>0 OR ck.parent_column_id>0)
ORDER BY column_id,label
"#,&[&object]).await?.into_first_result().await?;
    let mut columns = Vec::new();
    for row in rows {
        let id = row.get::<i32, _>("column_id").unwrap_or(0);
        let mut unique_constraints = uniques
            .iter()
            .filter(|r| r.get::<i32, _>(0) == Some(id))
            .filter_map(|r| r.get::<&str, _>(1).map(str::to_string))
            .collect::<Vec<_>>();
        unique_constraints.sort();
        let mut deps = dependencies
            .iter()
            .filter(|r| r.get::<i32, _>(0) == Some(id))
            .filter_map(|r| r.get::<&str, _>(1).map(str::to_string))
            .collect::<Vec<_>>();
        deps.sort();
        deps.dedup();
        columns.push(ColumnInfo {
            id: format!("{object}:{id}"),
            name: row.get::<&str, _>("name").unwrap_or("").into(),
            data_type: row.get::<&str, _>("data_type").unwrap_or("").into(),
            nullable: row.get::<bool, _>("is_nullable").unwrap_or(false),
            default_value: row.get::<&str, _>("default_value").unwrap_or("").into(),
            generated: row.get::<bool, _>("is_identity").unwrap_or(false)
                || row.get::<bool, _>("is_computed").unwrap_or(false)
                || row.get::<u8, _>("generated_always_type").unwrap_or(0) > 0
                || matches!(
                    row.get::<&str, _>("base_type"),
                    Some("timestamp" | "rowversion")
                ),
            primary_key: row.get::<bool, _>("primary_key").unwrap_or(false),
            unique_constraints,
            default_constraint: row.get::<&str, _>("default_constraint").map(str::to_string),
            collation: row.get::<&str, _>("collation_name").map(str::to_string),
            dependencies: deps,
        });
    }
    Ok(ColumnContext {
        table_id: object.to_string(),
        schema: table.get::<&str, _>(0).unwrap_or("").into(),
        table: table.get::<&str, _>(1).unwrap_or("").into(),
        columns,
    })
}
#[tauri::command]
pub async fn ms_column_context(
    state: tauri::State<'_, MsState>,
    session_id: String,
    table_id: String,
) -> Result<ColumnContext, Failure> {
    let s = session(&state, &session_id).await?;
    let object = table_id
        .parse()
        .map_err(|_| Failure::message("Invalid table ID."))?;
    let mut client = open(s.config.clone()).await?;
    tokio::time::timeout(Duration::from_secs(15), column_context(&mut client, object))
        .await
        .map_err(|_| Failure::message("Column metadata timed out."))?
}
async fn change_column(s: &Session, object: i32, change: ColumnChange) -> Result<(), Failure> {
    if s.read_only {
        return Err(Failure::message(
            "Query-only connection. Reconnect with the guard disabled to change columns.",
        ));
    }
    let mut client = open(s.config.clone()).await?;
    client
        .simple_query("SET XACT_ABORT ON; SET ANSI_WARNINGS ON; BEGIN TRANSACTION;")
        .await?
        .into_results()
        .await?;
    let result = tokio::time::timeout(Duration::from_secs(60), async {
        let before = column_context(&mut client, object).await?;
        let table = format!("{}.{}", quote(&before.schema), quote(&before.table));
        client
            .simple_query(format!(
                "SELECT TOP (1) 1 FROM {table} WITH (TABLOCKX,HOLDLOCK)"
            ))
            .await?
            .into_results()
            .await?;
        let identity = client
            .query("SELECT OBJECT_ID(@P1)", &[&table])
            .await?
            .into_row()
            .await?
            .and_then(|r| r.get::<i32, _>(0));
        if identity != Some(object) {
            return Err(Failure::message(
                "The table was replaced. Reopen the column editor.",
            ));
        }
        let actual = column_context(&mut client, object).await?;
        let operations =
            columns::plan(Engine::Mssql, &actual, &change).map_err(Failure::message)?;
        for op in operations {
            match op {
                Operation::Sql(sql) => {
                    client.simple_query(sql).await?.into_results().await?;
                }
                Operation::Rename { qualified, name } => {
                    client
                        .query(
                            "EXEC sys.sp_rename @objname=@P1,@newname=@P2,@objtype=N'COLUMN'",
                            &[&qualified, &name],
                        )
                        .await?
                        .into_results()
                        .await?;
                }
            }
        }
        Ok::<_, Failure>(())
    })
    .await
    .unwrap_or_else(|_| {
        Err(Failure::message(
            "Column change timed out. No changes were committed.",
        ))
    });
    if let Err(error) = result {
        let _ = tokio::time::timeout(Duration::from_secs(5), async {
            client
                .simple_query("IF @@TRANCOUNT>0 ROLLBACK TRANSACTION")
                .await?
                .into_results()
                .await?;
            Ok::<_, tiberius::error::Error>(())
        })
        .await;
        return Err(error);
    }
    match tokio::time::timeout(Duration::from_secs(15), async {
        client
            .simple_query("COMMIT TRANSACTION")
            .await?
            .into_results()
            .await?;
        Ok::<_, tiberius::error::Error>(())
    })
    .await
    {
        Ok(Ok(())) => Ok(()),
        _ => Err(Failure {
            uncertain: true,
            ..Failure::message(
                "Could not confirm COMMIT. Close the editor and refresh the schema before trying again.",
            )
        }),
    }
}
#[tauri::command]
pub async fn ms_change_column(
    state: tauri::State<'_, MsState>,
    session_id: String,
    table_id: String,
    change: ColumnChange,
) -> Result<(), Failure> {
    let s = session(&state, &session_id).await?;
    let object = table_id
        .parse()
        .map_err(|_| Failure::message("Invalid table ID."))?;
    change_column(&s, object, change).await
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn transport_errors_close_the_session() {
        let error = Failure::from(tiberius::error::Error::Io {
            kind: std::io::ErrorKind::ConnectionReset,
            message: "Connection reset".into(),
        });
        assert!(error.closed);
    }
    #[test]
    fn safe_identifiers() {
        assert_eq!(quote("a]b; DROP"), "[a]]b; DROP]");
    }
    #[test]
    fn precision_and_nulls() {
        assert_eq!(
            cell(ColumnData::Numeric(Some(
                tiberius::numeric::Numeric::new_with_scale(123400, 4)
            )))
            .unwrap(),
            json!("12.3400")
        );
        assert_eq!(
            cell(ColumnData::I64(Some(9_007_199_254_740_993))).unwrap(),
            json!("9007199254740993")
        );
        assert_eq!(cell(ColumnData::I32(None)).unwrap(), Value::Null);
        assert_eq!(
            cell(ColumnData::Binary(Some(vec![0, 255].into()))).unwrap(),
            json!("0x00FF")
        );
        assert_eq!(
            unique_names(["id", "id", "id (2)"].into_iter().map(str::to_string)),
            vec!["id", "id (2)", "id (2) (2)"]
        );
    }
    #[test]
    fn readonly_blocks_write_batches() {
        for sql in [
            "SELECT 1; DELETE FROM users",
            "SELECT * INTO copy FROM users",
            "WITH c AS (SELECT 1 AS n) DELETE FROM users",
            "EXEC p",
            "BEGIN TRAN; SELECT 1",
            "SELECT NEXT VALUE FOR seq",
            "SELECT * FROM OPENQUERY(link,'DELETE FROM t')",
        ] {
            assert!(query_only(sql).is_err(), "{sql}");
        }
        for sql in [
            "SELECT TOP 10 * FROM dbo.users",
            "WITH c AS (SELECT 1 AS id) SELECT * FROM c",
            "SELECT 'DELETE INTO' AS [UPDATE] /* INSERT */",
            "SELECT 1; SELECT 2",
        ] {
            assert!(query_only(sql).is_ok(), "{sql}");
        }
    }
    #[tokio::test]
    #[ignore = "requires SQLSERVER_TEST_HOST and an available SQL Server; creates session-local temp data only"]
    async fn live_sqlserver_driver() {
        let config = MsConfig {
            auth: std::env::var("SQLSERVER_TEST_AUTH").unwrap_or_else(|_| "sql".into()),
            host: std::env::var("SQLSERVER_TEST_HOST").expect("Set SQLSERVER_TEST_HOST"),
            port: std::env::var("SQLSERVER_TEST_PORT")
                .unwrap_or_else(|_| "1433".into())
                .parse()
                .unwrap(),
            database: std::env::var("SQLSERVER_TEST_DATABASE").unwrap_or_else(|_| "master".into()),
            user: std::env::var("SQLSERVER_TEST_USER").unwrap_or_else(|_| "sa".into()),
            encrypt: true,
            trust_certificate: std::env::var("SQLSERVER_TEST_TRUST_CERT")
                .is_ok_and(|v| v == "true"),
            read_only: false,
        };
        let options = options(
            &config,
            std::env::var("SQLSERVER_TEST_PASSWORD").unwrap_or_default(),
        )
        .unwrap();
        let (version, catalog, client) = metadata(options.clone()).await.unwrap();
        assert!(!version.is_empty());
        assert!(catalog["tables"].is_array());
        let session = Arc::new(Session {
            config: options,
            attention: client.cancellation_handle(),
            stop: Notify::new(),
            client: Mutex::new(Some(client)),
            read_only: false,
            running: AtomicBool::new(false),
            cancel: Notify::new(),
            validation: Mutex::new(()),
        });
        let printed = run(
            &session,
            "SET NOCOUNT OFF; PRINT N'Query output QA'; SELECT 1 AS a; SELECT 2 AS b;",
            1000,
        )
        .await
        .unwrap();
        assert_eq!(printed.len(), 2);
        assert!(printed[0].messages.iter().any(|m| m == "Query output QA"));
        assert!(
            printed[0]
                .messages
                .iter()
                .any(|m| m.contains("rows affected"))
        );
        let failure = run(
            &session,
            "SELECT 99 AS before_error; PRINT N'Before error QA'; RAISERROR('Expected QA error',16,1);",
            1000,
        )
        .await
        .unwrap_err();
        assert!(failure.messages.iter().any(|m| m == "Before error QA"));
        assert_eq!(failure.result_sets[0].rows[0]["before_error"], json!(99));
        let clean = run(&session, "SELECT 3 AS c", 1000).await.unwrap();
        assert!(
            !clean[0]
                .messages
                .iter()
                .any(|m| m.contains("Before error QA"))
        );
        let result=run(&session,"SELECT CONVERT(bigint,9007199254740993) AS id, CONVERT(decimal(20,4),12.3400) AS amount, CONVERT(nvarchar(40),N'Xin chào') AS name, NULL AS missing; SELECT 2 AS n;",1000).await.unwrap();
        assert_eq!(result.len(), 2);
        assert_eq!(result[0].rows[0]["id"], json!("9007199254740993"));
        assert_eq!(result[0].rows[0]["amount"], json!("12.3400"));
        assert_eq!(result[0].rows[0]["name"], json!("Xin chào"));
        assert_eq!(result[0].rows[0]["missing"], Value::Null);
        let result = run(
            &session,
            "DECLARE @n int=42; SELECT @n AS n; SELECT 1 AS empty WHERE 1=0;",
            1000,
        )
        .await
        .unwrap();
        assert_eq!(result[0].rows[0]["n"], json!(42));
        assert_eq!(result[1].columns, vec!["empty"]);
        run(&session,"CREATE TABLE #dbplayground_qa(id int PRIMARY KEY); INSERT INTO #dbplayground_qa VALUES(1); BEGIN TRANSACTION; INSERT INTO #dbplayground_qa VALUES(2); ROLLBACK;",1000).await.unwrap();
        let result = run(&session, "SELECT * FROM #dbplayground_qa ORDER BY id", 1000)
            .await
            .unwrap();
        assert_eq!(result[0].rows.len(), 1);
        let result=run(&session,"SELECT TOP (250) ROW_NUMBER() OVER (ORDER BY a.object_id) AS n FROM sys.all_objects a CROSS JOIN sys.all_objects b",100).await.unwrap();
        assert_eq!(result[0].rows.len(), 100);
        assert!(result[0].truncated);
        let error = run(
            &session,
            "SELECT * FROM __dbplayground_missing_table_qa",
            1000,
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, Some(208));
        let mut observer = open(session.config.clone()).await.unwrap();
        let sid = run(&session, "SELECT @@SPID AS session_id", 1)
            .await
            .unwrap()[0]
            .rows[0]["session_id"]
            .as_i64()
            .unwrap() as i32;
        let cancelling = session.clone();
        let handle = tokio::spawn(async move {
            run(&cancelling, "WAITFOR DELAY '00:00:10'; SELECT 1", 1000).await
        });
        tokio::time::sleep(Duration::from_millis(200)).await;
        let cancelled_at = std::time::Instant::now();
        assert!(session.attention.cancel());
        session.stop.notify_one();
        let stopped = tokio::time::timeout(Duration::from_secs(2), handle)
            .await
            .expect("Cancellation must not wait for the 10-second query");
        assert!(!stopped.unwrap().unwrap_err().closed);
        eprintln!("SQLSERVER_CANCEL_MS {}", cancelled_at.elapsed().as_millis());
        assert!(session.client.lock().await.is_some());
        let kept = run(
            &session,
            "SELECT @@SPID AS session_id; SELECT COUNT(*) AS n FROM #dbplayground_qa",
            10,
        )
        .await
        .unwrap();
        assert_eq!(kept[0].rows[0]["session_id"], json!(sid));
        assert_eq!(kept[1].rows[0]["n"], json!(1));
        run(
            &session,
            "SET CONTEXT_INFO 0x123456; BEGIN TRANSACTION; INSERT INTO #dbplayground_qa VALUES(3);",
            10,
        )
        .await
        .unwrap();
        for _ in 0..3 {
            let cancelling = session.clone();
            let handle = tokio::spawn(async move {
                run(&cancelling,"SELECT TOP (20000) REPLICATE(N'x',1000) AS payload FROM sys.all_objects a CROSS JOIN sys.all_objects b; WAITFOR DELAY '00:00:10';",10).await
            });
            tokio::time::sleep(Duration::from_millis(50)).await;
            assert!(session.attention.cancel());
            session.stop.notify_one();
            let failure = tokio::time::timeout(Duration::from_secs(2), handle)
                .await
                .unwrap()
                .unwrap()
                .unwrap_err();
            assert!(!failure.closed, "{}", failure.message);
            let kept = run(&session,"SELECT @@SPID AS sid,CONVERT(varchar(20),SUBSTRING(CONTEXT_INFO(),1,3),1) AS ctx,@@TRANCOUNT AS transactions; SELECT COUNT(*) AS n FROM #dbplayground_qa",10).await.unwrap();
            assert_eq!(kept[0].rows[0]["sid"], json!(sid));
            assert_eq!(kept[0].rows[0]["ctx"], json!("0x123456"));
            assert_eq!(kept[0].rows[0]["transactions"], json!(1));
            assert_eq!(kept[1].rows[0]["n"], json!(2));
        }
        run(
            &session,
            "ROLLBACK; SELECT COUNT(*) AS n FROM #dbplayground_qa",
            10,
        )
        .await
        .unwrap();

        // Verify the server request disappears, rather than only abandoning
        // the client future. The local fixture login has DMV visibility.
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let row = observer
                    .query(
                        "SELECT COUNT(*) FROM sys.dm_exec_requests WHERE session_id=@P1",
                        &[&sid],
                    )
                    .await
                    .unwrap()
                    .into_row()
                    .await
                    .unwrap()
                    .unwrap();
                if row.get::<i32, _>(0) == Some(0) {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        })
        .await
        .expect("SQL Server must stop the disconnected request");
    }
    #[tokio::test]
    #[ignore = "requires SQLSERVER_TEST_HOST; creates and removes an isolated grid_qa_* schema"]
    async fn live_sqlserver_grid() {
        use futures_util::FutureExt;
        let config = MsConfig {
            auth: std::env::var("SQLSERVER_TEST_AUTH").unwrap_or_else(|_| "sql".into()),
            host: std::env::var("SQLSERVER_TEST_HOST").expect("Set SQLSERVER_TEST_HOST"),
            port: std::env::var("SQLSERVER_TEST_PORT")
                .unwrap_or_else(|_| "1433".into())
                .parse()
                .unwrap(),
            database: std::env::var("SQLSERVER_TEST_DATABASE").unwrap_or_else(|_| "master".into()),
            user: std::env::var("SQLSERVER_TEST_USER").unwrap_or_else(|_| "sa".into()),
            encrypt: true,
            trust_certificate: std::env::var("SQLSERVER_TEST_TRUST_CERT")
                .is_ok_and(|v| v == "true"),
            read_only: false,
        };
        let options = options(
            &config,
            std::env::var("SQLSERVER_TEST_PASSWORD").unwrap_or_default(),
        )
        .unwrap();
        let mut setup = open(options.clone()).await.unwrap();
        let grid_client = open(options.clone()).await.unwrap();
        let s = Session {
            config: options.clone(),
            attention: grid_client.cancellation_handle(),
            stop: Notify::new(),
            client: Mutex::new(Some(grid_client)),
            read_only: false,
            running: AtomicBool::new(false),
            cancel: Notify::new(),
            validation: Mutex::new(()),
        };
        let schema = format!("grid_qa_{}", uuid::Uuid::new_v4().simple());
        let result=std::panic::AssertUnwindSafe(async {
            setup.simple_query(format!("CREATE SCHEMA [{schema}] AUTHORIZATION dbo")).await.unwrap().into_results().await.unwrap();
            setup.simple_query(format!("CREATE TABLE [{schema}].items (id bigint IDENTITY(9007199254740993,1), tenant int NOT NULL DEFAULT 1, name nvarchar(30) NOT NULL UNIQUE, amount decimal(30,8) DEFAULT 0, note nvarchar(max) NULL, flag bit DEFAULT 0, stamp rowversion, computed AS (name + '!'), PRIMARY KEY(id,tenant)); CREATE TABLE [{schema}].no_key (val nvarchar(50));")).await.unwrap().into_results().await.unwrap();
            setup.simple_query(format!("CREATE VIEW [{schema}].preview AS SELECT * FROM [{schema}].items")).await.unwrap().into_results().await.unwrap();
            let object=setup.query("SELECT OBJECT_ID(@P1)",&[&format!("[{schema}].items")]).await.unwrap().into_row().await.unwrap().unwrap().get::<i32,_>(0).unwrap();
            let edit=|original:Option<Map<String,Value>>,cells:Value,deleted|GridChange {original,cells:serde_json::from_value(cells).unwrap(),deleted};
            assert_eq!(save_grid(&s,object,vec![edit(None,json!({"name":"O'Brien');--","amount":"12345678901234567890.12345678","note":"","flag":"true"}),false)]).await.unwrap(),1);
            let row=collect(&mut setup,&format!("SELECT * FROM [{schema}].items"),100).await.unwrap().remove(0).rows.remove(0).as_object().unwrap().clone();
            assert_eq!(row["id"],json!("9007199254740993"));assert_eq!(row["amount"],json!("12345678901234567890.12345678"));assert_eq!(row["note"],json!(""));assert_eq!(row["flag"],json!(true));
            assert!(save_grid(&s,object,vec![edit(Some(row.clone()),json!({"id":"2"}),false)]).await.is_err());
            save_grid(&s,object,vec![edit(Some(row.clone()),json!({"tenant":"2","name":"Updated","note":null}),false)]).await.unwrap();
            let current=collect(&mut setup,&format!("SELECT * FROM [{schema}].items"),100).await.unwrap().remove(0).rows.remove(0).as_object().unwrap().clone();assert_eq!(current["tenant"],json!(2));assert_eq!(current["note"],Value::Null);
            assert!(save_grid(&s,object,vec![edit(Some(current.clone()),json!({"name":"Rollback"}),false),edit(None,json!({"name":"Rollback"}),false)]).await.is_err());
            let check=collect(&mut setup,&format!("SELECT * FROM [{schema}].items"),100).await.unwrap().remove(0).rows.remove(0);assert_eq!(check["name"],json!("Updated"));
            assert!(save_grid(&s,object,vec![edit(None,json!({"name":"This value is far too long for a nvarchar thirty column"}),false)]).await.is_err());
            setup.simple_query(format!("UPDATE [{schema}].items SET name=N'External'")).await.unwrap().into_results().await.unwrap();
            assert!(save_grid(&s,object,vec![edit(Some(current),json!({"name":"Overwrite"}),false)]).await.unwrap_err().message.contains("changed"));
            let current=collect(&mut setup,&format!("SELECT * FROM [{schema}].items"),100).await.unwrap().remove(0).rows.remove(0).as_object().unwrap().clone();
            save_grid(&s,object,vec![edit(Some(current.clone()),json!({}),true)]).await.unwrap();
            assert!(save_grid(&s,object,vec![edit(Some(current),json!({}),true)]).await.is_err());
            let keyless=setup.query("SELECT OBJECT_ID(@P1)",&[&format!("[{schema}].no_key")]).await.unwrap().into_row().await.unwrap().unwrap().get::<i32,_>(0).unwrap();
            save_grid(&s,keyless,vec![edit(None,json!({"val":"new"}),false)]).await.unwrap();
            save_grid(&s,keyless,vec![edit(None,json!({}),false)]).await.unwrap();
            assert!(save_grid(&s,keyless,vec![edit(Some(json!({"val":"new"}).as_object().unwrap().clone()),json!({"val":"changed"}),false)]).await.is_err());
            let view=setup.query("SELECT OBJECT_ID(@P1)",&[&format!("[{schema}].preview")]).await.unwrap().into_row().await.unwrap().unwrap().get::<i32,_>(0).unwrap();assert!(save_grid(&s,view,vec![edit(None,json!({"name":"no"}),false)]).await.is_err());
            let read_only=Session {config:options,client:Mutex::new(None),attention:Default::default(),stop:Notify::new(),read_only:true,running:AtomicBool::new(false),cancel:Notify::new(),validation:Mutex::new(())};assert!(save_grid(&read_only,object,vec![edit(None,json!({"name":"no"}),false)]).await.is_err());
        }).catch_unwind().await;
        setup.simple_query(format!("DROP VIEW IF EXISTS [{schema}].preview; DROP TABLE IF EXISTS [{schema}].items; DROP TABLE IF EXISTS [{schema}].no_key; DROP SCHEMA IF EXISTS [{schema}];")).await.unwrap().into_results().await.unwrap();
        if let Err(error) = result {
            std::panic::resume_unwind(error);
        }
    }
    #[tokio::test]
    #[ignore = "requires SQLSERVER_TEST_HOST; creates/removes an isolated columns_qa_* schema"]
    async fn live_sqlserver_columns() {
        use crate::columns::{Action, ColumnDraft};
        use futures_util::FutureExt;
        let config = MsConfig {
            auth: std::env::var("SQLSERVER_TEST_AUTH").unwrap_or_else(|_| "sql".into()),
            host: std::env::var("SQLSERVER_TEST_HOST").expect("Set SQLSERVER_TEST_HOST"),
            port: std::env::var("SQLSERVER_TEST_PORT")
                .unwrap_or_else(|_| "1433".into())
                .parse()
                .unwrap(),
            database: std::env::var("SQLSERVER_TEST_DATABASE").unwrap_or_else(|_| "master".into()),
            user: std::env::var("SQLSERVER_TEST_USER").unwrap_or_else(|_| "sa".into()),
            encrypt: true,
            trust_certificate: std::env::var("SQLSERVER_TEST_TRUST_CERT")
                .is_ok_and(|v| v == "true"),
            read_only: false,
        };
        let options = options(
            &config,
            std::env::var("SQLSERVER_TEST_PASSWORD").unwrap_or_default(),
        )
        .unwrap();
        let mut setup = open(options.clone()).await.unwrap();
        let s = Session {
            config: options,
            client: Mutex::new(None),
            attention: Default::default(),
            stop: Notify::new(),
            read_only: false,
            running: AtomicBool::new(false),
            cancel: Notify::new(),
            validation: Mutex::new(()),
        };
        let schema = format!("columns_qa_{}", uuid::Uuid::new_v4().simple());
        let result=std::panic::AssertUnwindSafe(async {
            setup.simple_query(format!("CREATE SCHEMA [{schema}] AUTHORIZATION dbo")).await.unwrap().into_results().await.unwrap();
            setup.simple_query(format!("CREATE TABLE [{schema}].items(id int PRIMARY KEY,name nvarchar(30) COLLATE Latin1_General_100_BIN2 NULL,n int DEFAULT 5,seq bigint IDENTITY);INSERT [{schema}].items(id,name) VALUES(1,N'Alpha'),(2,NULL);CREATE TABLE [{schema}].no_key(k int NOT NULL);INSERT [{schema}].no_key VALUES(1),(2);")).await.unwrap().into_results().await.unwrap();
            let oid=setup.query("SELECT OBJECT_ID(@P1)",&[&format!("[{schema}].items")]).await.unwrap().into_row().await.unwrap().unwrap().get::<i32,_>(0).unwrap();
            let draft=|c:&columns::ColumnInfo|ColumnDraft{name:c.name.clone(),data_type:c.data_type.clone(),nullable:c.nullable,default_value:c.default_value.clone(),unique:!c.unique_constraints.is_empty(),primary_key:c.primary_key};
            let before=column_context(&mut setup,oid).await.unwrap();
            let add=ColumnChange{action:Action::Add,column_id:None,column:Some(ColumnDraft{name:"nickname".into(),data_type:"nvarchar(20)".into(),nullable:true,default_value:"N'O''Brien'".into(),unique:false,primary_key:false}),expected:before.clone()};change_column(&s,oid,add.clone()).await.unwrap();
            let value=collect(&mut setup,&format!("SELECT nickname FROM [{schema}].items WHERE id=1"),10).await.unwrap();assert_eq!(value[0].rows[0]["nickname"],json!("O'Brien"));
            let ctx=column_context(&mut setup,oid).await.unwrap();let col=ctx.columns.iter().find(|c|c.name=="nickname").unwrap();assert!(col.default_constraint.is_some());let default_name=col.default_constraint.clone();
            let mut settings=draft(col);settings.name="nick]name".into();settings.data_type="nvarchar(50)".into();settings.nullable=false;settings.default_value="N'Updated'".into();change_column(&s,oid,ColumnChange{action:Action::Alter,column_id:Some(col.id.clone()),column:Some(settings),expected:ctx.clone()}).await.unwrap();
            let ctx=column_context(&mut setup,oid).await.unwrap();let col=ctx.columns.iter().find(|c|c.name=="nick]name").unwrap();assert!(!col.nullable);assert_eq!(col.data_type,"nvarchar(50)");assert_eq!(col.default_constraint,default_name);
            let mut settings=draft(col);settings.unique=true;settings.default_value="N'Rollback'".into();assert!(change_column(&s,oid,ColumnChange{action:Action::Alter,column_id:Some(col.id.clone()),column:Some(settings),expected:ctx.clone()}).await.is_err());assert_eq!(column_context(&mut setup,oid).await.unwrap(),ctx);
            assert!(change_column(&s,oid,add).await.unwrap_err().message.contains("schema changed"));
            change_column(&s,oid,ColumnChange{action:Action::Drop,column_id:Some(col.id.clone()),column:None,expected:ctx.clone()}).await.unwrap();
            let ctx=column_context(&mut setup,oid).await.unwrap();assert!(!ctx.columns.iter().any(|c|c.name=="nick]name"));let pk=ctx.columns.iter().find(|c|c.name=="id").unwrap();assert!(change_column(&s,oid,ColumnChange{action:Action::Drop,column_id:Some(pk.id.clone()),column:None,expected:ctx.clone()}).await.is_err());
            let col=ctx.columns.iter().find(|c|c.name=="name").unwrap();let mut settings=draft(col);settings.nullable=false;settings.default_value="N'Fill'".into();assert!(change_column(&s,oid,ColumnChange{action:Action::Alter,column_id:Some(col.id.clone()),column:Some(settings),expected:ctx.clone()}).await.is_err());assert_eq!(column_context(&mut setup,oid).await.unwrap(),ctx);
            let mut settings=draft(col);settings.data_type="nvarchar(2)".into();assert!(change_column(&s,oid,ColumnChange{action:Action::Alter,column_id:Some(col.id.clone()),column:Some(settings),expected:ctx.clone()}).await.is_err());assert_eq!(column_context(&mut setup,oid).await.unwrap(),ctx);
            let mut settings=draft(col);settings.unique=true;change_column(&s,oid,ColumnChange{action:Action::Alter,column_id:Some(col.id.clone()),column:Some(settings),expected:ctx.clone()}).await.unwrap();
            let ctx=column_context(&mut setup,oid).await.unwrap();let col=ctx.columns.iter().find(|c|c.name=="name").unwrap();assert_eq!(col.unique_constraints.len(),1);let mut settings=draft(col);settings.unique=false;change_column(&s,oid,ColumnChange{action:Action::Alter,column_id:Some(col.id.clone()),column:Some(settings),expected:ctx.clone()}).await.unwrap();
            let ctx=column_context(&mut setup,oid).await.unwrap();let col=ctx.columns.iter().find(|c|c.name=="name").unwrap();let original_collation=col.collation.clone();let mut settings=draft(col);settings.data_type="nvarchar(60)".into();change_column(&s,oid,ColumnChange{action:Action::Alter,column_id:Some(col.id.clone()),column:Some(settings),expected:ctx.clone()}).await.unwrap();assert_eq!(column_context(&mut setup,oid).await.unwrap().columns.iter().find(|c|c.name=="name").unwrap().collation,original_collation);
            setup.simple_query(format!("CREATE INDEX name_idx ON [{schema}].items(name)")).await.unwrap().into_results().await.unwrap();let ctx=column_context(&mut setup,oid).await.unwrap();let col=ctx.columns.iter().find(|c|c.name=="name").unwrap();assert!(!col.dependencies.is_empty());assert!(change_column(&s,oid,ColumnChange{action:Action::Drop,column_id:Some(col.id.clone()),column:None,expected:ctx.clone()}).await.is_err());
            let generated=ctx.columns.iter().find(|c|c.name=="seq").unwrap();assert!(generated.generated);let mut settings=draft(generated);settings.name="renamed_seq".into();change_column(&s,oid,ColumnChange{action:Action::Alter,column_id:Some(generated.id.clone()),column:Some(settings),expected:ctx.clone()}).await.unwrap();
            let keyless=setup.query("SELECT OBJECT_ID(@P1)",&[&format!("[{schema}].no_key")]).await.unwrap().into_row().await.unwrap().unwrap().get::<i32,_>(0).unwrap();let ctx=column_context(&mut setup,keyless).await.unwrap();let mut settings=draft(&ctx.columns[0]);settings.primary_key=true;change_column(&s,keyless,ColumnChange{action:Action::Alter,column_id:Some(ctx.columns[0].id.clone()),column:Some(settings),expected:ctx}).await.unwrap();assert!(column_context(&mut setup,keyless).await.unwrap().columns[0].primary_key);
        }).catch_unwind().await;
        setup.simple_query(format!("DROP TABLE IF EXISTS [{schema}].items;DROP TABLE IF EXISTS [{schema}].no_key;DROP SCHEMA IF EXISTS [{schema}]")).await.unwrap().into_results().await.unwrap();
        if let Err(error) = result {
            std::panic::resume_unwind(error);
        }
    }
    #[tokio::test]
    #[ignore = "requires SQLSERVER_TEST_PASSWORD and isolated codex_multidb_qa database"]
    async fn live_sqlserver_database_contexts() {
        let state = MsState::default();
        let config = MsConfig {
            auth: "sql".into(),
            host: "127.0.0.1".into(),
            port: 1433,
            database: "master".into(),
            user: "sa".into(),
            encrypt: true,
            trust_certificate: true,
            read_only: true,
        };
        let opts = options(
            &config,
            std::env::var("SQLSERVER_TEST_PASSWORD").expect("Set SQLSERVER_TEST_PASSWORD"),
        )
        .unwrap();
        let first = connect_options(&state, opts, true).await.unwrap();
        let first_id = first["sessionId"].as_str().unwrap();
        let second = open_database(&state, first_id, "codex_multidb_qa")
            .await
            .unwrap();
        let second_id = second["sessionId"].as_str().unwrap();
        assert_ne!(first_id, second_id);
        let a = session(&state, first_id).await.unwrap();
        let b = session(&state, second_id).await.unwrap();
        assert!(b.read_only);
        let (ra, rb) = tokio::join!(
            run(&a, "SELECT DB_NAME() AS db", 10),
            run(&b, "SELECT DB_NAME() AS db", 10)
        );
        assert_eq!(ra.unwrap()[0].rows[0]["db"], json!("master"));
        assert_eq!(rb.unwrap()[0].rows[0]["db"], json!("codex_multidb_qa"));
        assert!(
            run(&b, "CREATE TABLE forbidden(id integer)", 10)
                .await
                .is_err()
        );
        assert!(
            open_database(&state, first_id, "absent_db_codex_qa")
                .await
                .is_err()
        );
        assert_eq!(
            run(&a, "SELECT DB_NAME() AS db", 10).await.unwrap()[0].rows[0]["db"],
            json!("master")
        );
        assert!(
            second["catalog"]["tables"]
                .as_array()
                .unwrap()
                .iter()
                .any(|t| t["name"] == "database_marker")
        );
        for s in [a, b] {
            s.client.lock().await.take();
        }
    }
    #[tokio::test]
    #[ignore = "read-only benchmark requiring the local AdventureWorks StressTest fixture"]
    async fn live_sqlserver_stress_performance() {
        let config = MsConfig {
            auth: "sql".into(),
            host: std::env::var("SQLSERVER_TEST_HOST").expect("Set SQLSERVER_TEST_HOST"),
            port: std::env::var("SQLSERVER_TEST_PORT")
                .unwrap_or_else(|_| "1433".into())
                .parse()
                .unwrap(),
            database: "AdventureWorksLT2019_Test".into(),
            user: std::env::var("SQLSERVER_TEST_USER").unwrap_or_else(|_| "sa".into()),
            encrypt: true,
            trust_certificate: std::env::var("SQLSERVER_TEST_TRUST_CERT")
                .is_ok_and(|v| v == "true"),
            read_only: true,
        };
        let opts = options(
            &config,
            std::env::var("SQLSERVER_TEST_PASSWORD").unwrap_or_default(),
        )
        .unwrap();
        let start = std::time::Instant::now();
        let (_, catalog, mut client) = metadata(opts).await.unwrap();
        let schema_ms = start.elapsed().as_secs_f64() * 1000.0;
        let tables = catalog["tables"].as_array().unwrap();
        assert!(tables.len() >= 3000, "Seed StressTest first");
        let columns: usize = tables
            .iter()
            .map(|t| t["columns"].as_array().unwrap().len())
            .sum();
        let start = std::time::Instant::now();
        let bytes = serde_json::to_vec(&catalog).unwrap().len();
        let serialize_ms = start.elapsed().as_secs_f64() * 1000.0;
        let mut point_reads = Vec::new();
        let mut wide_reads = Vec::new();
        for _ in 0..3 {
            let start = std::time::Instant::now();
            let result = collect(
                &mut client,
                "SELECT TOP (3) * FROM StressTest.BigOrders ORDER BY OrderID",
                100,
            )
            .await
            .unwrap();
            point_reads.push(start.elapsed().as_secs_f64() * 1000.0);
            assert_eq!(result[0].rows.len(), 3);
            let start = std::time::Instant::now();
            let result = collect(
                &mut client,
                "SELECT TOP (100) * FROM StressTest.WideRows ORDER BY RowID",
                100,
            )
            .await
            .unwrap();
            wide_reads.push(start.elapsed().as_secs_f64() * 1000.0);
            assert_eq!(result[0].columns.len(), 121);
            assert_eq!(result[0].rows.len(), 100);
        }
        eprintln!(
            "STRESS_PERF {}",
            json!({"tables":tables.len(),"columns":columns,"catalogBytes":bytes,"connectAndCatalogMs":schema_ms,"serializeCatalogMs":serialize_ms,"pointReadMs":point_reads,"wideReadMs":wide_reads})
        );
    }
}
