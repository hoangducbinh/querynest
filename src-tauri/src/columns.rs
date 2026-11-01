//! Remote column DDL is planned from fresh metadata. Identifiers are quoted,
//! types are allowlisted and defaults must parse as exactly one SQL expression.
use serde::{Deserialize, Serialize};
use sqlparser::{
    dialect::{Dialect, MsSqlDialect, PostgreSqlDialect},
    parser::Parser,
    tokenizer::{Token, Tokenizer, Whitespace},
};
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ColumnInfo {
    pub id: String,
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
    pub default_value: String,
    pub generated: bool,
    pub primary_key: bool,
    pub unique_constraints: Vec<String>,
    pub default_constraint: Option<String>,
    pub collation: Option<String>,
    pub dependencies: Vec<String>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ColumnContext {
    pub table_id: String,
    pub schema: String,
    pub table: String,
    pub columns: Vec<ColumnInfo>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ColumnDraft {
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
    pub default_value: String,
    pub unique: bool,
    pub primary_key: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Action {
    Add,
    Alter,
    Drop,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ColumnChange {
    pub action: Action,
    pub column_id: Option<String>,
    pub column: Option<ColumnDraft>,
    pub expected: ColumnContext,
}
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Engine {
    Postgres,
    Mssql,
}
#[derive(Debug)]
pub enum Operation {
    Sql(String),
    Rename { qualified: String, name: String },
}
pub fn quote(engine: Engine, name: &str) -> String {
    match engine {
        Engine::Postgres => format!("\"{}\"", name.replace('"', "\"\"")),
        Engine::Mssql => format!("[{}]", name.replace(']', "]]")),
    }
}
fn normalize(value: &str) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}
pub fn data_type(engine: Engine, value: &str) -> Result<String, String> {
    let input = normalize(value);
    let (base, args, suffix) = if let Some(open) = input.find('(') {
        let close = input.find(')').ok_or("Invalid data type parameters.")?;
        if close < open {
            return Err("Invalid data type.".into());
        }
        (
            input[..open].trim(),
            Some(&input[open + 1..close]),
            input[close + 1..].trim(),
        )
    } else {
        (input.as_str(), None, "")
    };
    let key = if suffix.is_empty() {
        base.to_string()
    } else {
        format!("{base} {suffix}")
    };
    let allowed = match engine {
        Engine::Postgres => [
            "text",
            "varchar",
            "character varying",
            "char",
            "character",
            "smallint",
            "integer",
            "int",
            "bigint",
            "numeric",
            "decimal",
            "real",
            "double precision",
            "boolean",
            "bool",
            "date",
            "timestamp",
            "timestamp without time zone",
            "timestamp with time zone",
            "timestamptz",
            "time",
            "time without time zone",
            "time with time zone",
            "timetz",
            "uuid",
            "json",
            "jsonb",
            "bytea",
        ]
        .as_slice(),
        Engine::Mssql => [
            "nvarchar",
            "varchar",
            "nchar",
            "char",
            "tinyint",
            "smallint",
            "int",
            "bigint",
            "decimal",
            "numeric",
            "real",
            "float",
            "bit",
            "date",
            "time",
            "datetime",
            "smalldatetime",
            "datetime2",
            "datetimeoffset",
            "uniqueidentifier",
            "binary",
            "varbinary",
            "xml",
            "money",
            "smallmoney",
            "text",
            "ntext",
        ]
        .as_slice(),
    };
    if !allowed.contains(&key.as_str()) {
        return Err("Unsupported data type in this editor. Use one of the suggested types, or use SQL for custom types.".into());
    }
    let mut canonical = key.clone();
    if let Some(args) = args {
        let args = args.trim();
        if engine == Engine::Mssql
            && args == "max"
            && matches!(base, "varchar" | "nvarchar" | "varbinary")
        {
            return Ok(format!("{base}(max)"));
        }
        let values = args
            .split(',')
            .map(|s| {
                s.trim()
                    .parse::<u32>()
                    .map_err(|_| "Data type parameters must be whole numbers.".to_string())
            })
            .collect::<Result<Vec<_>, _>>()?;
        let valid = if matches!(base, "numeric" | "decimal") {
            !values.is_empty()
                && values.len() <= 2
                && values[0] >= 1
                && values[0] <= if engine == Engine::Mssql { 38 } else { 1000 }
                && values.get(1).is_none_or(|s| *s <= values[0])
        } else if matches!(
            base,
            "varchar"
                | "nvarchar"
                | "nchar"
                | "char"
                | "character"
                | "character varying"
                | "binary"
                | "varbinary"
        ) {
            values.len() == 1
                && values[0] > 0
                && values[0]
                    <= match engine {
                        Engine::Postgres => 10_485_760,
                        Engine::Mssql => {
                            if matches!(base, "nvarchar" | "nchar") {
                                4000
                            } else {
                                8000
                            }
                        }
                    }
        } else if matches!(
            base,
            "time" | "timetz" | "timestamp" | "timestamptz" | "datetime2" | "datetimeoffset"
        ) {
            values.len() == 1 && values[0] <= if engine == Engine::Postgres { 6 } else { 7 }
        } else if engine == Engine::Mssql && base == "float" {
            values.len() == 1 && (1..=53).contains(&values[0])
        } else {
            false
        };
        if !valid {
            return Err("Invalid length, precision or scale for this data type.".into());
        }
        canonical = format!(
            "{base}({}){}",
            values
                .iter()
                .map(u32::to_string)
                .collect::<Vec<_>>()
                .join(","),
            if suffix.is_empty() {
                String::new()
            } else {
                format!(" {suffix}")
            }
        );
    }
    if engine == Engine::Mssql
        && args.is_none()
        && matches!(
            base,
            "varchar" | "nvarchar" | "nchar" | "char" | "binary" | "varbinary"
        )
    {
        return Err("Specify a length, for example nvarchar(255).".into());
    }
    Ok(canonical)
}
fn collatable(value: &str) -> bool {
    matches!(
        normalize(value).split('(').next().unwrap_or("").trim(),
        "text"
            | "ntext"
            | "varchar"
            | "nvarchar"
            | "char"
            | "nchar"
            | "character"
            | "character varying"
    )
}
pub fn default_expression(engine: Engine, value: &str) -> Result<Option<String>, String> {
    if value.trim().is_empty() {
        return Ok(None);
    }
    if value.len() > 8000 {
        return Err("Default expression is too long.".into());
    }
    let dialect: &dyn Dialect = match engine {
        Engine::Postgres => &PostgreSqlDialect {},
        Engine::Mssql => &MsSqlDialect {},
    };
    let mut parser = Parser::new(dialect)
        .try_with_sql(value)
        .map_err(|e| e.to_string())?;
    let _expr = parser
        .parse_expr()
        .map_err(|e| format!("Invalid default expression: {e}"))?;
    if parser.peek_token().token != Token::EOF {
        return Err("Enter a single default expression, without statements or semicolons.".into());
    }
    // Keep original quoting: AST Display in this parser version does not escape
    // national string literals correctly. Parsing still verifies a single expr.
    let tokens = Tokenizer::new(dialect, value)
        .tokenize()
        .map_err(|e| e.to_string())?;
    let line_comment = tokens
        .iter()
        .any(|t| matches!(t, Token::Whitespace(Whitespace::SingleLineComment { .. })));
    Ok(Some(if line_comment {
        format!("{}\n", value.trim())
    } else {
        value.trim().to_string()
    }))
}
pub fn plan(
    engine: Engine,
    actual: &ColumnContext,
    change: &ColumnChange,
) -> Result<Vec<Operation>, String> {
    if *actual != change.expected {
        return Err(
            "The table schema changed. Close and reopen the column editor before applying changes."
                .into(),
        );
    }
    let table = format!(
        "{}.{}",
        quote(engine, &actual.schema),
        quote(engine, &actual.table)
    );
    let old = match change.action {
        Action::Add => None,
        _ => Some(
            actual
                .columns
                .iter()
                .find(|c| Some(&c.id) == change.column_id.as_ref())
                .ok_or("Column no longer exists. Refresh the schema.")?,
        ),
    };
    if matches!(change.action, Action::Drop) {
        let old = old.unwrap();
        if actual.columns.len() <= 1 {
            return Err("Keep at least one column in the table.".into());
        }
        if old.primary_key || !old.dependencies.is_empty() || !old.unique_constraints.is_empty() {
            return Err("This column is used by constraints or indexes. Manage those dependencies in SQL before deleting it.".into());
        }
        let mut result = Vec::new();
        if let Some(default) = &old.default_constraint {
            result.push(Operation::Sql(format!(
                "ALTER TABLE {table} DROP CONSTRAINT {}",
                quote(engine, default)
            )));
        }
        result.push(Operation::Sql(format!(
            "ALTER TABLE {table} DROP COLUMN {}",
            quote(engine, &old.name)
        )));
        return Ok(result);
    }
    let draft = change
        .column
        .as_ref()
        .ok_or("Column settings are required.")?;
    let name = draft.name.trim();
    let length = if engine == Engine::Postgres {
        name.len()
    } else {
        name.encode_utf16().count()
    };
    if name.is_empty()
        || name.chars().any(char::is_control)
        || length > if engine == Engine::Postgres { 63 } else { 128 }
    {
        return Err(
            "Invalid column name (PostgreSQL: 63 bytes; SQL Server: 128 UTF-16 units).".into(),
        );
    }
    if actual.columns.iter().any(|c| {
        old.is_none_or(|o| c.id != o.id)
            && if engine == Engine::Mssql {
                c.name.eq_ignore_ascii_case(name)
            } else {
                c.name == name
            }
    }) {
        return Err("A column with this name already exists.".into());
    }
    if draft.primary_key && draft.nullable {
        return Err("A primary key column must be required.".into());
    }
    if old.is_some_and(|c| c.primary_key) && !draft.primary_key {
        return Err("Manage existing primary keys in SQL.".into());
    }
    if draft.primary_key
        && old.is_none_or(|c| !c.primary_key)
        && actual.columns.iter().any(|c| c.primary_key)
    {
        return Err(
            "This table already has a primary key. Manage composite primary keys in SQL.".into(),
        );
    }
    let type_changed = old.is_none_or(|c| normalize(&c.data_type) != normalize(&draft.data_type));
    let default_changed = old.is_none_or(|c| c.default_value.trim() != draft.default_value.trim());
    let nullable_changed = old.is_none_or(|c| c.nullable != draft.nullable);
    let unique_changed = old.is_none_or(|c| !c.unique_constraints.is_empty() != draft.unique);
    if old.is_some_and(|c| c.generated)
        && (type_changed
            || default_changed
            || nullable_changed
            || unique_changed
            || draft.primary_key != old.unwrap().primary_key)
    {
        return Err("Generated/identity columns support renaming only here. Use SQL for generation changes.".into());
    }
    if engine == Engine::Mssql && type_changed && old.is_some_and(|c| !c.dependencies.is_empty()) {
        return Err("This column is indexed or constrained. Manage dependencies in SQL before changing its type.".into());
    }
    if unique_changed && old.is_some_and(|c| c.unique_constraints.len() > 1) {
        return Err("Multiple unique constraints use this column. Manage them in SQL.".into());
    }
    let sql_type = if type_changed {
        data_type(engine, &draft.data_type)?
    } else {
        old.unwrap().data_type.clone()
    };
    let expression = if default_changed || (engine == Engine::Mssql && type_changed) {
        default_expression(engine, &draft.default_value)?
    } else {
        None
    };
    let mut result = Vec::new();
    match old {
        None => {
            let mut sql = format!(
                "ALTER TABLE {table} ADD {} {sql_type} {}",
                quote(engine, name),
                if draft.nullable { "NULL" } else { "NOT NULL" }
            );
            if let Some(expr) = expression {
                sql.push_str(&format!(" DEFAULT ({expr})"));
                if engine == Engine::Mssql {
                    sql.push_str(" WITH VALUES");
                }
            }
            result.push(Operation::Sql(sql));
        }
        Some(old) => {
            let column = quote(engine, &old.name);
            if engine == Engine::Mssql && (default_changed || type_changed) {
                if let Some(default) = &old.default_constraint {
                    result.push(Operation::Sql(format!(
                        "ALTER TABLE {table} DROP CONSTRAINT {}",
                        quote(engine, default)
                    )));
                }
            } else if engine == Engine::Postgres && default_changed && !old.default_value.is_empty()
            {
                result.push(Operation::Sql(format!(
                    "ALTER TABLE {table} ALTER COLUMN {column} DROP DEFAULT"
                )));
            }
            if engine == Engine::Postgres {
                if type_changed {
                    result.push(Operation::Sql(format!(
                        "ALTER TABLE {table} ALTER COLUMN {column} TYPE {sql_type}{}",
                        if collatable(&sql_type) {
                            old.collation
                                .as_ref()
                                .map(|c| format!(" COLLATE {c}"))
                                .unwrap_or_default()
                        } else {
                            String::new()
                        }
                    )));
                }
                if nullable_changed {
                    result.push(Operation::Sql(format!(
                        "ALTER TABLE {table} ALTER COLUMN {column} {} NOT NULL",
                        if draft.nullable { "DROP" } else { "SET" }
                    )));
                }
            } else if type_changed || nullable_changed {
                result.push(Operation::Sql(format!(
                    "ALTER TABLE {table} ALTER COLUMN {column} {sql_type}{} {}",
                    if !type_changed || collatable(&sql_type) {
                        old.collation
                            .as_ref()
                            .map(|c| format!(" COLLATE {c}"))
                            .unwrap_or_default()
                    } else {
                        String::new()
                    },
                    if draft.nullable { "NULL" } else { "NOT NULL" }
                )));
            }
            if let Some(expr) = expression {
                result.push(Operation::Sql(match engine {
                    Engine::Postgres => {
                        format!("ALTER TABLE {table} ALTER COLUMN {column} SET DEFAULT ({expr})")
                    }
                    Engine::Mssql => {
                        format!(
                            "ALTER TABLE {table} ADD {}DEFAULT ({expr}) FOR {column}",
                            old.default_constraint
                                .as_ref()
                                .map(|name| format!("CONSTRAINT {} ", quote(engine, name)))
                                .unwrap_or_default()
                        )
                    }
                }));
            }
            if unique_changed && !draft.unique {
                for constraint in &old.unique_constraints {
                    result.push(Operation::Sql(format!(
                        "ALTER TABLE {table} DROP CONSTRAINT {}",
                        quote(engine, constraint)
                    )));
                }
            }
        }
    }
    let target = old.map_or(name, |c| c.name.as_str());
    let column = quote(engine, target);
    if draft.unique && unique_changed {
        result.push(Operation::Sql(format!(
            "ALTER TABLE {table} ADD UNIQUE ({column})"
        )));
    }
    if draft.primary_key && old.is_none_or(|c| !c.primary_key) {
        result.push(Operation::Sql(format!(
            "ALTER TABLE {table} ADD PRIMARY KEY ({column})"
        )));
    }
    if old.is_some_and(|c| c.name != name) {
        result.push(match engine {
            Engine::Postgres => Operation::Sql(format!(
                "ALTER TABLE {table} RENAME COLUMN {column} TO {}",
                quote(engine, name)
            )),
            Engine::Mssql => Operation::Rename {
                qualified: format!("{table}.{column}"),
                name: name.into(),
            },
        });
    }
    Ok(result)
}
#[cfg(test)]
mod tests {
    use super::*;
    fn context() -> ColumnContext {
        ColumnContext {
            table_id: "1".into(),
            schema: "dbo".into(),
            table: "items".into(),
            columns: vec![ColumnInfo {
                id: "1:1".into(),
                name: "name".into(),
                data_type: "varchar(30)".into(),
                nullable: true,
                default_value: "".into(),
                generated: false,
                primary_key: false,
                unique_constraints: vec![],
                default_constraint: None,
                collation: None,
                dependencies: vec![],
            }],
        }
    }
    #[test]
    fn validates_types_and_defaults() {
        assert_eq!(
            data_type(Engine::Mssql, "nvarchar(100)").unwrap(),
            "nvarchar(100)"
        );
        assert_eq!(
            data_type(Engine::Postgres, "timestamp(6) with time zone").unwrap(),
            "timestamp(6) with time zone"
        );
        for kind in [
            "int; DROP TABLE t",
            "nvarchar(0)",
            "decimal(40,2)",
            "nvarchar(2);--",
        ] {
            assert!(data_type(Engine::Mssql, kind).is_err(), "{kind}");
        }
        assert_eq!(
            default_expression(Engine::Mssql, "N'O''Brien; x'").unwrap(),
            Some("N'O''Brien; x'".into())
        );
        for expr in ["0; DROP TABLE t", "0); DELETE FROM t;--"] {
            assert!(default_expression(Engine::Mssql, expr).is_err());
        }
    }
    #[test]
    fn preserves_dependencies_and_checks_stale_metadata() {
        let actual = context();
        let mut change = ColumnChange {
            action: Action::Alter,
            column_id: Some("1:1".into()),
            column: Some(ColumnDraft {
                name: "new]name".into(),
                data_type: "varchar(30)".into(),
                nullable: true,
                default_value: "".into(),
                unique: false,
                primary_key: false,
            }),
            expected: actual.clone(),
        };
        assert!(matches!(
            &plan(Engine::Mssql, &actual, &change).unwrap()[0],
            Operation::Rename { .. }
        ));
        change.expected.columns[0].nullable = false;
        assert!(plan(Engine::Mssql, &actual, &change).is_err());
        change.action = Action::Drop;
        change.expected = actual.clone();
        assert!(plan(Engine::Postgres, &actual, &change).is_err());
    }
}
