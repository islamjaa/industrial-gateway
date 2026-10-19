IF OBJECT_ID(N'dbo.Telemetry', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.Telemetry
    (
        Id            BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT PK_Telemetry PRIMARY KEY,
        TagId         NVARCHAR(150) NOT NULL,
        TagAddress    NVARCHAR(100) NOT NULL,
        ValueFloat    FLOAT NULL,
        ValueString   NVARCHAR(4000) NULL,
        Quality       NVARCHAR(20) NOT NULL,
        TimestampUtc  DATETIME2(3) NOT NULL,
        CreatedAtUtc  DATETIME2(3) NOT NULL CONSTRAINT DF_Telemetry_CreatedAtUtc DEFAULT SYSUTCDATETIME()
    );

    CREATE INDEX IX_Telemetry_TagAddress_Timestamp
        ON dbo.Telemetry (TagAddress, TimestampUtc DESC);
END;
GO
