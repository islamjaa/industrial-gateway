IF COL_LENGTH(N'dbo.Telemetry', N'SourceId') IS NULL
    ALTER TABLE dbo.Telemetry ADD SourceId NVARCHAR(120) NULL;
GO
IF COL_LENGTH(N'dbo.Telemetry', N'DataType') IS NULL
    ALTER TABLE dbo.Telemetry ADD DataType NVARCHAR(40) NULL;
GO
IF COL_LENGTH(N'dbo.Telemetry', N'ErrorMessage') IS NULL
    ALTER TABLE dbo.Telemetry ADD ErrorMessage NVARCHAR(1000) NULL;
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_Telemetry_SourceId_TagId_Timestamp' AND object_id = OBJECT_ID(N'dbo.Telemetry'))
    CREATE INDEX IX_Telemetry_SourceId_TagId_Timestamp ON dbo.Telemetry (SourceId, TagId, TimestampUtc DESC);
GO
