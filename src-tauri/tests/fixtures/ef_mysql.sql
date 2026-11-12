-- What Pomelo creates, with a few migrations recorded out of order.
CREATE TABLE `__EFMigrationsHistory` (
  `MigrationId` varchar(150) CHARACTER SET utf8mb4 NOT NULL,
  `ProductVersion` varchar(32) CHARACTER SET utf8mb4 NOT NULL,
  CONSTRAINT `PK___EFMigrationsHistory` PRIMARY KEY (`MigrationId`)
) CHARACTER SET=utf8mb4;
INSERT INTO `__EFMigrationsHistory` VALUES
  ('20240608141755_AddAuditColumns', '8.0.6'),
  ('20230214091200_InitialCreate', '7.0.2'),
  ('00000000000000_Legacy', '3.1.0'),
  ('20230301154501_AddCustomers', '7.0.3');
