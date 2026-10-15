# Data loggers

Configure storage destinations in the web interface. Supported providers are SQL Server, PostgreSQL, MySQL/MariaDB, SQLite, and InfluxDB 2.x. Each destination has a provider, connection settings, a target (database/schema/table, SQLite path/table, or InfluxDB bucket/measurement), a tag selection, a trigger mode, and optional deadband.

Credentials are managed by the server-side environment store and are not sent back to the browser. Use the provider's **Test connection** action before enabling production storage. Creating a database, bucket, or table may require additional permissions. Existing tables are not modified by the create-if-missing action.

The default SQL format is narrow: one row per tag sample. Avoid using untrusted values as SQL identifiers; the application validates schema and table names.
