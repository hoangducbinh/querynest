USE [AdventureWorksLT2019_Test];
GO
-- Fast indexed reads: compare query execution vs client rendering/catalog time.
SET STATISTICS TIME ON;
SET STATISTICS IO ON;
SELECT TOP (3) * FROM StressTest.BigOrders ORDER BY OrderID;
SELECT TOP (3) * FROM StressTest.BigOrders WHERE CustomerID=42 ORDER BY OrderDate;
SELECT TOP (100) * FROM StressTest.WideRows ORDER BY RowID;
SELECT TOP (3) ID, Name, Text02 FROM StressTest.Catalog_3000;
-- Aggregate scans: intentionally more server work than point lookups.
SELECT Status,COUNT_BIG(*) AS orders,SUM(TotalAmount) AS total FROM StressTest.BigOrders GROUP BY Status;
SET STATISTICS IO OFF;
SET STATISTICS TIME OFF;
