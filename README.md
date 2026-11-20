# AWS Emulator UI

A companion web UI for the emulator. It does not modify or link against the emulator. It only
reads the Smithy models under `../../aws-emulator/services/*/smithy-model/` and talks to the running emulator
over HTTPS (SigV4-signed with the credentials the emulator writes to `~/.aws/emulator/<port>/`).

- `server/`: Node (Express) backend. Signs and forwards requests, controls the Docker container.
- `web/`: React + Vite frontend.

## Run

```powershell
cd ui
npm install
npm run dev        # UI on http://localhost:5173, API on http://127.0.0.1:8787
```

Production-style: `npm run build && npm start`, then open http://localhost:8787.

In the header, use **Build image** (once), then **Start**. Docker Desktop must be running.
The image is built from the emulator repository's `Dockerfile`, piped on stdin so no build context is sent.

## Pages

- **Console**: pick any service and operation (from the Smithy models), edit the JSON input, send.
  Supports awsJson, awsQuery, ec2Query, restJson and restXml request building. **Raw HTTP** sends any request.
  XML request bodies are not generated yet; use the body override field.

## Configuration (environment variables)

| Variable | Default |
|---|---|
| `EMULATOR_PORT` | `9297` |
| `EMULATOR_REGION` | `us-east-1` |
| `EMULATOR_HOME` | `~/.aws/emulator` |
| `EMULATOR_REPO` | sibling folder `aws-emulator` (`../../aws-emulator` relative to `ui/`) |
| `UI_API_PORT` / `UI_WEB_PORT` | `8787` / `5173` |

## Security

The API binds to `127.0.0.1`, rejects unknown `Host`/`Origin` headers and non-JSON POSTs, because
it can sign requests and run `docker` commands.

## Tests

`npm test` checks request building against the real models.
