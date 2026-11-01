//! Engine-independent validation for remote spreadsheet changes. All SQL is built
//! from fresh server metadata; values are always bound parameters.
use serde::Deserialize;
use serde_json::{Map, Value};
use std::collections::BTreeMap;
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GridChange {
    pub original: Option<Map<String, Value>>,
    pub cells: BTreeMap<String, Option<String>>,
    pub deleted: bool,
}
#[derive(Clone, Debug)]
pub struct GridColumn {
    pub name: String,
    pub sql_type: String,
    pub kind: String,
    pub key: bool,
    pub generated: bool,
    pub writable: bool,
    pub nullable: bool,
    pub defaulted: bool,
}
pub fn validate(columns: &[GridColumn], changes: &[GridChange]) -> Result<(), String> {
    if changes.is_empty() || changes.len() > 500 {
        return Err("Save between 1 and 500 changed rows at a time.".into());
    }
    for (index, change) in changes.iter().enumerate() {
        let fail = |s: &str| format!("Row {}: {s}", index + 1);
        if let Some(original) = &change.original {
            if !columns.iter().any(|c| c.key) {
                return Err(fail(
                    "A primary key is required to update or delete existing rows.",
                ));
            }
            if original.len() != columns.len()
                || columns.iter().any(|c| !original.contains_key(&c.name))
            {
                return Err(fail(
                    "The table structure changed. Discard drafts and refresh the schema.",
                ));
            }
            for key in columns.iter().filter(|c| c.key) {
                if original.get(&key.name).is_none_or(Value::is_null) {
                    return Err(fail("Original primary key is missing. Refresh this page."));
                }
            }
        } else if change.deleted {
            return Err(fail("Cannot delete an unsaved row."));
        }
        if change.deleted {
            continue;
        }
        for (name, value) in &change.cells {
            let c = columns
                .iter()
                .find(|c| &c.name == name)
                .ok_or_else(|| fail("Unknown column. Refresh the schema."))?;
            if !c.writable || c.generated {
                return Err(fail(&format!("{} is generated or read-only.", c.name)));
            }
            if value.is_none() && !c.nullable {
                return Err(fail(&format!("{} cannot be NULL.", c.name)));
            }
            if value.as_ref().is_some_and(|v| v.len() > 1_000_000) {
                return Err(fail("A cell exceeds the 1 MB editing limit."));
            }
        }
        if change.original.is_none() {
            for c in columns {
                if !c.generated
                    && !c.nullable
                    && !c.defaulted
                    && !change.cells.contains_key(&c.name)
                {
                    return Err(fail(&format!("{} is required.", c.name)));
                }
            }
        }
    }
    Ok(())
}
pub fn original_text(value: &Value) -> Result<String, String> {
    match value {
        Value::String(v) => Ok(v.clone()),
        Value::Bool(v) => Ok(v.to_string()),
        Value::Number(v) => Ok(v.to_string()),
        _ => Err("Invalid original primary key. Refresh this page.".into()),
    }
}
pub fn check_original(
    actual: &Map<String, Value>,
    original: &Map<String, Value>,
) -> Result<(), String> {
    if actual != original {
        return Err("This row changed on the server. No changes were saved. Discard drafts and refresh before trying again.".into());
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn columns() -> Vec<GridColumn> {
        vec![
            GridColumn {
                name: "id".into(),
                sql_type: "bigint".into(),
                kind: "int8".into(),
                key: true,
                generated: true,
                writable: false,
                nullable: false,
                defaulted: true,
            },
            GridColumn {
                name: "name".into(),
                sql_type: "text".into(),
                kind: "text".into(),
                key: false,
                generated: false,
                writable: true,
                nullable: false,
                defaulted: false,
            },
        ]
    }
    fn change() -> GridChange {
        GridChange {
            original: Some(
                json!({"id":"9007199254740993","name":"a"})
                    .as_object()
                    .unwrap()
                    .clone(),
            ),
            cells: BTreeMap::from([("name".into(), Some("b".into()))]),
            deleted: false,
        }
    }
    #[test]
    fn validates_changes_and_server_generated_columns() {
        assert!(validate(&columns(), &[change()]).is_ok());
        let mut c = change();
        c.cells.insert("id".into(), Some("1".into()));
        assert!(validate(&columns(), &[c]).is_err());
        let mut c = change();
        c.cells.insert("missing".into(), Some("1".into()));
        assert!(validate(&columns(), &[c]).is_err());
        let mut c = change();
        c.cells.insert("name".into(), None);
        assert!(validate(&columns(), &[c]).is_err());
        let mut columns = columns();
        columns[0].key = false;
        assert!(validate(&columns, &[change()]).is_err());
        let c = GridChange {
            original: None,
            cells: BTreeMap::from([("name".into(), Some("O'Brien; DROP TABLE t".into()))]),
            deleted: false,
        };
        assert!(validate(&columns, &[c]).is_ok());
    }
    #[test]
    fn rejects_stale_originals_and_preserves_large_keys() {
        let original = change().original.unwrap();
        assert!(check_original(&original, &original).is_ok());
        let mut actual = original.clone();
        actual.insert("name".into(), json!("other"));
        assert!(check_original(&actual, &original).is_err());
        assert_eq!(original_text(&original["id"]).unwrap(), "9007199254740993");
    }
}
