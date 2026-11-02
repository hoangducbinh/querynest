-- Disposable performance fixtures in the restored test database only.
-- Re-runnable: existing tables/data are retained, no DROP/TRUNCATE/DELETE.
USE [AdventureWorksLT2019_Test];
GO
SET NOCOUNT ON;
SET XACT_ABORT ON;
DECLARE @lock int;
EXEC @lock = sys.sp_getapplock @Resource=N'dbplayground-stress-seed', @LockMode=N'Exclusive', @LockOwner=N'Session', @LockTimeout=0;
IF @lock < 0 THROW 50000, 'Another seed is already running.', 1;
IF SCHEMA_ID(N'StressTest') IS NULL EXEC(N'CREATE SCHEMA StressTest');

CREATE TABLE #Numbers (n int NOT NULL PRIMARY KEY);
WITH digits(n) AS (SELECT n FROM (VALUES(0),(1),(2),(3),(4),(5),(6),(7),(8),(9)) d(n))
INSERT #Numbers SELECT 1+a.n+10*b.n+100*c.n+1000*d.n+10000*e.n+100000*f.n
FROM digits a CROSS JOIN digits b CROSS JOIN digits c CROSS JOIN digits d CROSS JOIN digits e CROSS JOIN digits f;

IF OBJECT_ID(N'StressTest.Customers',N'U') IS NULL
CREATE TABLE StressTest.Customers (
 CustomerID int NOT NULL PRIMARY KEY, CustomerCode varchar(24) NOT NULL,
 DisplayName nvarchar(100) NOT NULL, Email varchar(120) NULL,
 City nvarchar(80) NOT NULL, CreatedAt datetime2(0) NOT NULL,
 IsActive bit NOT NULL, CreditLimit decimal(18,2) NOT NULL
);
IF NOT EXISTS(SELECT 1 FROM StressTest.Customers)
INSERT StressTest.Customers
SELECT n,CONCAT('CUS-',RIGHT(CONCAT('000000',n),6)),CONCAT(N'Khách hàng thử nghiệm ',n),
 CONCAT('customer',n,'@example.invalid'),
 CHOOSE(1+n%5,N'Hồ Chí Minh',N'Hà Nội',N'Đà Nẵng',N'Hải Phòng',N'Cần Thơ'),
 DATEADD(minute,n,CONVERT(datetime2(0),'2020-01-01')),CONVERT(bit,CASE WHEN n%9=0 THEN 0 ELSE 1 END),n%10000*125.25
FROM #Numbers WHERE n<=100000;
RAISERROR('Customers ready: 100,000 rows',0,1) WITH NOWAIT;

IF OBJECT_ID(N'StressTest.BigOrders',N'U') IS NULL
CREATE TABLE StressTest.BigOrders (
 OrderID int NOT NULL PRIMARY KEY, CustomerID int NOT NULL,
 OrderNumber varchar(30) NOT NULL, OrderDate datetime2(0) NOT NULL,
 Status varchar(20) NOT NULL, Quantity int NOT NULL, UnitPrice decimal(18,2) NOT NULL,
 Discount decimal(9,4) NOT NULL, TaxAmount decimal(18,2) NOT NULL,
 TotalAmount decimal(18,2) NOT NULL, Currency char(3) NOT NULL,
 ShipCity nvarchar(80) NOT NULL, AddressLine nvarchar(200) NULL,
 Notes nvarchar(500) NULL, ExternalID uniqueidentifier NOT NULL,
 IsPriority bit NOT NULL, ShippedAt datetime2(0) NULL,
 UpdatedAt datetime2(0) NOT NULL, SourceSystem varchar(30) NOT NULL,
 Metadata nvarchar(400) NULL,
 CONSTRAINT FK_StressTest_BigOrders_Customers FOREIGN KEY(CustomerID) REFERENCES StressTest.Customers(CustomerID)
);
DECLARE @batch int=0;
WHILE @batch<10
BEGIN
 INSERT StressTest.BigOrders
 SELECT n,1+(n-1)%100000,CONCAT('ORD-',RIGHT(CONCAT('000000000',n),9)),
 DATEADD(second,n,CONVERT(datetime2(0),'2024-01-01')),
 CHOOSE(1+n%4,'pending','paid','shipped','cancelled'),1+n%20,25.50+n%5000,n%15/100.0,
 n%200*1.25,(1+n%20)*(25.50+n%5000),'VND',
 CHOOSE(1+n%3,N'Hồ Chí Minh',N'Hà Nội',N'Đà Nẵng'),CONCAT(n%1000,N' Đường dữ liệu thử nghiệm'),
 CASE WHEN n%7=0 THEN NULL ELSE CONCAT(N'Đơn hàng thử nghiệm ',n,N' — nội dung để kiểm tra cuộn và hiển thị Unicode') END,
 NEWID(),CONVERT(bit,n%2),CASE WHEN n%4=0 THEN NULL ELSE DATEADD(second,n+3600,CONVERT(datetime2(0),'2024-01-01')) END,
 DATEADD(second,n+7200,CONVERT(datetime2(0),'2024-01-01')),'synthetic',
 CONCAT('{"test":true,"batch":',@batch,',"reference":',n,'}')
 FROM #Numbers num WHERE n>@batch*100000 AND n<=(@batch+1)*100000
 AND NOT EXISTS(SELECT 1 FROM StressTest.BigOrders o WHERE o.OrderID=num.n);
 SET @batch+=1;
 RAISERROR('BigOrders batch %d / 10 ready',0,1,@batch) WITH NOWAIT;
END;
IF NOT EXISTS(SELECT 1 FROM sys.indexes WHERE object_id=OBJECT_ID(N'StressTest.BigOrders') AND name=N'IX_BigOrders_Customer_Date')
 CREATE INDEX IX_BigOrders_Customer_Date ON StressTest.BigOrders(CustomerID,OrderDate) INCLUDE(Status,TotalAmount);

-- 120 payload columns plus RowID: mixed dates, decimals, nullable Unicode strings.
DECLARE @ddl nvarchar(max)=N'CREATE TABLE StressTest.WideRows(RowID int NOT NULL PRIMARY KEY',
 @values nvarchar(max)=N'SELECT n', @col int=1, @suffix varchar(3);
WHILE @col<=40
BEGIN
 SET @suffix=RIGHT('000'+CONVERT(varchar(3),@col),3);
 SET @ddl+=N',Amount'+@suffix+N' decimal(18,4) NULL,Label'+@suffix+N' nvarchar(100) NULL,Date'+@suffix+N' datetime2(0) NULL';
 SET @values+=N',CONVERT(decimal(18,4),n*'+CONVERT(nvarchar(3),@col)+N'/13.0),CASE WHEN n%11=0 THEN NULL ELSE CONCAT(N''Cột '+@suffix+N' — dữ liệu dài cần resize '',n) END,DATEADD(minute,n+'+CONVERT(nvarchar(3),@col)+N',CONVERT(datetime2(0),''2024-01-01''))';
 SET @col+=1;
END;
IF OBJECT_ID(N'StressTest.WideRows',N'U') IS NULL EXEC(@ddl+N')');
IF NOT EXISTS(SELECT 1 FROM StressTest.WideRows)
 EXEC(N'INSERT StressTest.WideRows '+@values+N' FROM #Numbers WHERE n<=20000');
RAISERROR('WideRows ready: 20,000 rows, 121 columns',0,1) WITH NOWAIT;

-- Catalog load: 3,000 tables x 25 columns, 3 rows each, one FK per table.
DECLARE @i int=1, @name sysname, @sql nvarchar(max);
WHILE @i<=3000
BEGIN
 SET @name=N'Catalog_'+RIGHT('0000'+CONVERT(varchar(4),@i),4);
 IF OBJECT_ID(N'StressTest.'+@name,N'U') IS NULL
 BEGIN
  SET @sql=N'CREATE TABLE StressTest.'+QUOTENAME(@name)+N'(
   ID int NOT NULL PRIMARY KEY, CustomerID int NOT NULL REFERENCES StressTest.Customers(CustomerID),
   Code varchar(30) NOT NULL, Name nvarchar(100) NOT NULL, Description nvarchar(400) NULL,
   Amount decimal(18,2) NOT NULL, Quantity int NOT NULL, Status varchar(20) NOT NULL,
   CreatedAt datetime2(0) NOT NULL, UpdatedAt datetime2(0) NULL,
   Flag bit NOT NULL, ExternalID uniqueidentifier NOT NULL, Payload nvarchar(500) NULL,
   Metric01 float NULL, Metric02 float NULL, Metric03 decimal(20,6) NULL,
   Tag01 nvarchar(80) NULL, Tag02 nvarchar(80) NULL, Tag03 nvarchar(80) NULL,
   Date01 date NULL, Date02 datetime2(0) NULL, Int01 bigint NULL, Int02 int NULL,
   Text01 nvarchar(250) NULL, Text02 nvarchar(250) NULL);
   INSERT StressTest.'+QUOTENAME(@name)+N'
   SELECT n,n,CONCAT(''TEST-'',n),CONCAT(N''Bảng '+CONVERT(nvarchar(4),@i)+N' — dòng '',n),
   N''Synthetic fixture'',n*100.25,n,''active'',''2024-01-01'',NULL,
   CONVERT(bit,n%2),NEWID(),N''{"test":true}'',n*1.1,n*2.2,n*3.3,
   N''Tag A'',NULL,N''Tag C'',''2024-01-01'',NULL,9007199254740993+n,n,NULL,N''Unicode — dữ liệu thử nghiệm''
   FROM #Numbers WHERE n<=3;';
  EXEC(@sql);
 END;
 IF @i%100=0 RAISERROR('Catalog tables: %d / 3000',0,1,@i) WITH NOWAIT;
 SET @i+=1;
END;
EXEC sys.sp_releaseapplock @Resource=N'dbplayground-stress-seed', @LockOwner=N'Session';
SELECT s.name AS schema_name,COUNT(*) AS tables FROM sys.tables t JOIN sys.schemas s ON s.schema_id=t.schema_id WHERE s.name=N'StressTest' GROUP BY s.name;
SELECT COUNT_BIG(*) AS orders FROM StressTest.BigOrders;
SELECT COUNT_BIG(*) AS wide_rows FROM StressTest.WideRows;
SELECT COUNT(*) AS wide_columns FROM sys.columns WHERE object_id=OBJECT_ID(N'StressTest.WideRows');
EXEC sys.sp_spaceused;
