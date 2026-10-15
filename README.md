# Industrial Gateway

Industrial Gateway is a configurable multi-protocol acquisition service built with Node.js. Devices, tags, calculated expressions, write-back rules, and data loggers are managed through the web interface. The initial installation intentionally contains no devices, tags, database destinations, or credentials.

## Features

- Omron FINS over TCP or UDP.
- Siemens S7 via `nodes7`.
- Modbus TCP and Modbus RTU.
- Allen-Bradley Logix over EtherNet/IP.
- OPC UA client.
- Physical tags and safe calculated expressions.
- Optional automatic expression-to-PLC synchronization with destination and permission validation.
- Data loggers for SQL Server, PostgreSQL, MySQL/MariaDB, SQLite, and InfluxDB 2.x.
- Web-based device, tag, and data logger administration.
- Local runtime catalog and secrets stored outside browser responses.

## Requirements

- Node.js 22.13 or later.
- Network access to the PLCs and configured storage servers.
- Suitable drivers and permissions for each selected protocol.

## Install on Windows

1. Extract the project to a dedicated folder, for example `C:\IndustrialGateway`.
2. Open PowerShell in that folder.
3. Install dependencies: `npm install`.
4. Copy `.env.example` to `.env` only if you need an administration API token or protocol credentials that are documented to use environment variables.
5. Run checks: `npm run test:all`.
6. Run the local diagnostic: `npm run doctor`.
7. Start the service: `npm start`.
8. Open `http://127.0.0.1:8080`.

The web application starts with an empty device catalog and an empty data logger list. Configure a device, add tags, configure a data logger, test the connections, and then enable the relevant entries. No database is created or contacted until a data logger is configured.

## First configuration

1. Open **Devices** and select the correct driver. Enter only the connection settings required by the actual device. Test the connection before adding production tags.
2. Open **Tags & variables** and create a physical tag. Select the source device, address, data type, and polling interval. Use **Verify tag** to validate the address where supported.
3. Open **Data loggers** and configure a storage provider, server, database or file, destination table/bucket, selected tags, and trigger mode. Save it, run **Test connection**, and create the destination only when the account has the necessary permissions.
4. For calculated tags, use the expression editor's tag selector and expression guide. Expressions only calculate a value unless an explicit automatic destination is configured.
5. Enable writes only for devices and tags approved for writes. Test write-back on a non-critical variable first.

## Data types and addresses

The interface presents conventional names such as `BOOL`, `BYTE`, `WORD`, `INT`, `DWORD`, `DINT`, `REAL`, `LREAL`, and `STRING`. The available types and address validation depend on the selected protocol. For Siemens, the address and type must match, for example `QB800` with `BYTE`, `QW800` with `WORD` or `INT`, and `QD800` with a compatible 32-bit type. Confirm the actual PLC variable and its safety implications before writing to output areas.

## Write behavior

The global write feature is available, but each physical source and target tag must have its own write permission. The application validates values and types, requires explicit authorization/confirmation for manual writes, and records write status. Automatic expression write-back is opt-in per calculated tag and has to reference an existing physical target. A driver acknowledgement is not the same as read-back verification. Always validate write behavior against a non-critical PLC variable before production use.

## Storage model

Each data logger is an independent destination with a selected set of tags and a trigger mode: every sample, on change, or interval. SQL and time-series backends are configured from the web interface. The usual SQL storage format is narrow: one row per tag sample. The installation does not include a preconfigured SQL Server host, database, username, or password.

## Raspberry Pi deployment

The same Node.js structure is intended to run on Windows and Linux, but each native dependency must be verified on the exact Raspberry Pi OS/architecture. SQL Server should normally remain on a separate x64 server; point the data logger to that server's network hostname/IP rather than `127.0.0.1` when the gateway runs on a Raspberry Pi. For remote web access, configure `GATEWAY_API_TOKEN`, bind the web server to the intended interface, and protect access with network controls.

## Validation status

Automated tests cover configuration validation, expression evaluation, driver adapters, value decoding, data logger providers, and write policy. These tests do not replace a communication test with each real PLC/server model. Verify each protocol, data type, address format, and write behavior on the target hardware.

## Useful commands

```powershell
npm run test:all
npm run doctor
npm start
```

## Security

Never commit `.env`, PLC credentials, OPC UA private keys, or production catalogs containing sensitive connection data. Use least-privilege accounts. Keep the web interface on localhost unless remote access is explicitly secured.
