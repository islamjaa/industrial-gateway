# Install Industrial Gateway

1. Install Node.js 22.13 or later.
2. Extract this project to a dedicated folder.
3. Open a terminal in the project root and run `npm install`.
4. Run `npm run test:all`.
5. Run `npm run doctor`.
6. Start with `npm start`.
7. Open `http://127.0.0.1:8080`.

The initial catalog and data logger list are empty. All device, tag, expression, and data logger configuration is created in the web interface. No database server, database name, user, password, device, or tag is preconfigured.

For remote access, set a strong `GATEWAY_API_TOKEN` in `.env`, then configure `web.host` in `config.yaml` for the required network interface. Do not expose the interface without a token and network access controls.
