# Architecture

- `src/drivers/`: protocol-specific clients for Omron FINS, Siemens S7, Modbus, Allen-Bradley Logix, and OPC UA.
- `src/services/catalog-store.js`: validates and persists device and tag definitions.
- `src/services/expression-engine.js`: evaluates the allowed expression syntax without `eval` or arbitrary JavaScript execution.
- `src/services/poller.js`: polls physical tags, calculates expression tags, manages automatic write-back, and submits samples to enabled data loggers.
- `src/services/datalogger-store.js`: validates the data logger catalog.
- `src/services/datalogger-manager.js` and `datalogger-providers.js`: manages connections and sample storage.
- `src/web/server.js`: HTTP API and browser administration interface.
- `src/database.js`: shared SQL Server access used by the SQL Server logger provider.
- `data/catalog.json`: local device/tag catalog, generated on first startup.
- `data/dataloggers.json`: local storage destination catalog, generated on first startup.
- `logs/gateway.log`: runtime log file.

Configuration is separated from the application code. The default catalog and data logger list are empty so the first run is configured from the web interface.
