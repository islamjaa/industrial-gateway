# Industrial Gateway

This is a school project I made. It's a Node.js app that reads data from PLCs, lets you create calculated tags, and saves everything in a database. All the setup is done from a web page.

I'm still learning, so don't use it on real equipment without testing it first.

## What it can do

- Read from Omron (FINS), Siemens S7, Modbus (TCP and RTU), Allen-Bradley and OPC UA
- Create calculated tags with simple expressions
- Write values back to the PLC (each tag needs its own write permission)
- Save data to SQL Server, PostgreSQL, MySQL/MariaDB, SQLite or InfluxDB
- Manage devices, tags and data loggers from the web interface

## How to run it

You need Node.js 22.13 or newer.

1. Download or clone the project
2. Open a terminal in the project folder
3. Run `npm install`
4. Run `npm run test:all` to check that everything works
5. Run `npm start`
6. Open http://127.0.0.1:8080

It starts empty (no devices, tags or databases). You add everything from the
web page.

If you want to protect the web API with a token, copy `.env.example` to `.env`
and set `GATEWAY_API_TOKEN`.

## How to use it

1. Go to **Devices**, pick the driver and enter the connection settings. Test
   the connection.
2. Go to **Tags & variables** and create a tag (device, address, data type,
   polling time).
3. Go to **Data loggers** and set where to save the data (database, table,
   which tags, and when to save).
4. For calculated tags, use the expression editor. They only calculate a value
   unless you set a destination to write it back to the PLC.

## Things to be careful with

- **Writing to the PLC:** try it first on a variable that doesn't matter. When
  the PLC says "ok" it doesn't mean the value was really changed, I don't read
  it back to check.
- **Siemens addresses:** the address and the data type have to match, for
  example `QB800` with `BYTE` or `QW800` with `WORD`/`INT`.
- **Never upload your `.env` file** or any real PLC/database passwords to GitHub.
- Keep the web page on localhost unless you set a token.

## Tests

There are automated tests for the drivers, expressions, value decoding, data
loggers and write rules (`npm test`). [Write here what you really tested, for
example: "I also tried it with a simulator / a real PLC model X".]

## Folders

- `src/` - backend code (drivers, poller, web server)
- `public/` - the web page
- `test/` - tests
- `sql/` - example SQL tables
- `scripts/` - syntax check and a diagnostic script (`npm run doctor`)
