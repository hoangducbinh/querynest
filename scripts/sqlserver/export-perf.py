import subprocess,json,time,pathlib
query=r"""SET NOCOUNT ON;
SELECT (SELECT CONVERT(varchar(20),o.object_id) AS id,s.name AS [schema],o.name,o.type AS kind,
JSON_QUERY((SELECT CONCAT(o.object_id,':',c.column_id) AS id,c.name,
ty.name+CASE WHEN ty.name IN ('varchar','nvarchar','char','nchar','varbinary','binary') THEN '('+CASE WHEN c.max_length=-1 THEN 'max' ELSE CONVERT(varchar(10),CASE WHEN ty.name IN ('nvarchar','nchar') THEN c.max_length/2 ELSE c.max_length END) END+')' WHEN ty.name IN ('decimal','numeric') THEN '('+CONVERT(varchar(10),c.precision)+','+CONVERT(varchar(10),c.scale)+')' ELSE '' END AS type,
c.is_nullable AS nullable,CAST(CASE WHEN EXISTS(SELECT 1 FROM sys.indexes i JOIN sys.index_columns ic ON ic.object_id=i.object_id AND ic.index_id=i.index_id WHERE i.object_id=o.object_id AND i.is_primary_key=1 AND ic.column_id=c.column_id) THEN 1 ELSE 0 END AS bit) AS primaryKey,
CAST(CASE WHEN c.is_identity=1 OR c.is_computed=1 THEN 1 ELSE 0 END AS bit) AS generated
FROM sys.columns c JOIN sys.types ty ON ty.user_type_id=c.user_type_id WHERE c.object_id=o.object_id AND c.is_hidden=0 ORDER BY c.column_id FOR JSON PATH)) AS columns
FROM sys.objects o JOIN sys.schemas s ON s.schema_id=o.schema_id WHERE o.type IN ('U','V') AND o.is_ms_shipped=0 ORDER BY s.name,o.name FOR JSON PATH) AS tables,
JSON_QUERY((SELECT CONCAT('fk:',f.object_id) AS id,CONVERT(varchar(20),f.parent_object_id) AS sourceTable,CONVERT(varchar(20),f.referenced_object_id) AS targetTable,
JSON_QUERY('['+STRING_AGG('"'+CONCAT(fc.parent_object_id,':',fc.parent_column_id)+'"',',') WITHIN GROUP(ORDER BY fc.constraint_column_id)+']') AS sourceColumns,
JSON_QUERY('['+STRING_AGG('"'+CONCAT(fc.referenced_object_id,':',fc.referenced_column_id)+'"',',') WITHIN GROUP(ORDER BY fc.constraint_column_id)+']') AS targetColumns
FROM sys.foreign_keys f JOIN sys.foreign_key_columns fc ON fc.constraint_object_id=f.object_id GROUP BY f.object_id,f.parent_object_id,f.referenced_object_id FOR JSON PATH)) AS relationships
FOR JSON PATH, WITHOUT_ARRAY_WRAPPER;
"""
subprocess.run(['docker','exec','-i','mssql-test','bash','-c','cat > /tmp/dbplayground-export.sql'],input=query.encode(),check=True)
start=time.monotonic()
data=subprocess.check_output(['docker','exec','mssql-test','bash','-lc','SQLCMDPASSWORD="$MSSQL_SA_PASSWORD" /opt/mssql-tools18/bin/sqlcmd -S localhost -U sa -C -b -y0 -d AdventureWorksLT2019_Test -i /tmp/dbplayground-export.sql'])
blob=b''.join(data.splitlines()); parsed=json.loads(blob[blob.index(b'{'):])
if isinstance(parsed['tables'],str): parsed['tables']=json.loads(parsed['tables'])
path=pathlib.Path('scripts/sqlserver/perf-catalog.local.json')
path.write_text(json.dumps(parsed,ensure_ascii=False))
wide_query="SET NOCOUNT ON; SELECT TOP(100) * FROM StressTest.WideRows ORDER BY RowID FOR JSON PATH,INCLUDE_NULL_VALUES;"
subprocess.run(['docker','exec','-i','mssql-test','bash','-c','cat > /tmp/dbplayground-wide.sql'],input=wide_query.encode(),check=True)
wide=subprocess.check_output(['docker','exec','mssql-test','bash','-lc','SQLCMDPASSWORD="$MSSQL_SA_PASSWORD" /opt/mssql-tools18/bin/sqlcmd -S localhost -U sa -C -b -y0 -d AdventureWorksLT2019_Test -i /tmp/dbplayground-wide.sql'])
blob=b''.join(wide.splitlines()); rows=json.loads(blob[blob.index(b'['):])
pathlib.Path('scripts/sqlserver/perf-wide.local.json').write_text(json.dumps(rows,ensure_ascii=False))
print(json.dumps({'tables':len(parsed['tables']),'columns':sum(len(t['columns']) for t in parsed['tables']),'relationships':len(parsed['relationships']),'catalog_json_bytes':path.stat().st_size,'export_seconds':round(time.monotonic()-start,3),'wide_rows':len(rows),'wide_columns':len(rows[0])}))
