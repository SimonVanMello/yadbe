-- What EF Core's SQL Server provider creates, with a few migrations recorded out of order.
CREATE TABLE [dbo].[__EFMigrationsHistory] (
  [MigrationId] nvarchar(150) NOT NULL,
  [ProductVersion] nvarchar(32) NOT NULL,
  CONSTRAINT [PK___EFMigrationsHistory] PRIMARY KEY ([MigrationId])
);
GO
INSERT INTO [dbo].[__EFMigrationsHistory] VALUES
  (N'20240608141755_AddAuditColumns', N'8.0.6'),
  (N'20230214091200_InitialCreate', N'7.0.2'),
  (N'00000000000000_Legacy', N'3.1.0'),
  (N'20230301154501_AddCustomers', N'7.0.3');
