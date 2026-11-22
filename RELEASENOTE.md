# AWS Emulator UI Release Notes

This file records user-visible changes for each AWS Emulator UI release. Releases are listed newest first.

## 0.4.0

This release adds a Local Compute Bridge that connects AWS Emulator EC2 metadata to Docker-backed Linux sandboxes and browser terminals.

### Added

- Docker-backed EC2 sandboxes managed through `dockerode`, with containers named `aws-emu-ec2-<instance-id>` and labels linking them to emulator instance IDs.
- Local AMI presets for Ubuntu 24.04 LTS and a Docker-in-Docker sandbox, using emulator-compatible AMI IDs and automatic image pulls.
- EC2 instance type resource limits for `t2.micro`, `t3.micro`, and `t3.small`, including mapped CPU and memory limits.
- User-data support for plain-text or base64 shell scripts, with boot output written to `/var/log/cloud-init-output.log`.
- Loopback-only port forwarding through `host:container` mappings such as `8080:80`.
- Docker lifecycle synchronization for EC2 launch, start, stop, reboot, and terminate operations.
- Automatic reconciliation between emulator instance state and managed Docker container state.
- `GET /api/ec2/docker-status` for detecting whether the local Docker daemon is available.
- An interactive EC2 Instance Connect terminal powered by `@xterm/xterm`, `@xterm/addon-fit`, and the `/ws/ec2/connect/:instanceId` WebSocket endpoint.
- A **View Cloud-Init Boot Logs** terminal action for diagnosing user-data scripts.
- Automated bridge coverage for Docker health fallback, AMI and resource mappings, port validation, privileged-container approval, user-data decoding, and lifecycle reconciliation.

### Changed

- EC2 metadata operations now use `@aws-sdk/client-ec2` against the configured AWS Emulator endpoint while retaining certificate-verified local transport.
- The EC2 launch form now includes AMI, instance type, port forwarding, and user-data controls.
- Running instances expose **Connect** only when their mapped local container is available and running.
- EC2 launches and lifecycle actions update the emulator first, then mirror the operation to Docker.
- Docker failures no longer interrupt metadata-only EC2 learning workflows. The interface displays a clear metadata-only warning and allows emulator operations to continue.
- The terminal frontend is lazy-loaded so xterm does not increase the initial application bundle.

### Security and safety

- EC2 port forwards bind to `127.0.0.1` rather than all host interfaces.
- Terminal WebSocket upgrades enforce the same loopback `Host` and `Origin` restrictions as the REST API.
- WebSocket terminal streams include output backpressure, resize error handling, and early-disconnect cleanup.
- Docker-in-Docker uses a privileged container and therefore requires explicit approval in the launch form. Only trusted commands and user-data scripts should be run with this preset.
- Managed-container labels are verified before lifecycle operations to avoid modifying unrelated Docker containers with conflicting names.

### Requirements and upgrade notes

- Run `npm ci`, rebuild the web application, and restart the UI server after upgrading.
- Docker Desktop or another compatible Docker daemon is required for live sandboxes and browser terminals.
- Docker remains optional for metadata-only EC2 use. Start Docker and refresh its status when live compute is needed.
- The first launch of an AMI preset may take longer while its Docker image is downloaded.

### Known limitations

- EC2 instances launched while Docker is unavailable remain metadata-only; launch a new instance after Docker starts to create a sandbox.
- The Docker-in-Docker preset is privileged and should not be treated as a security boundary for untrusted code.
- Port forwarding can be configured only when launching one instance at a time.
- Automated tests validate bridge behavior with mocked containers but do not pull images or run Docker-backed end-to-end browser sessions.

## 0.3.0

This release adds portable snapshots for ephemeral S3, DynamoDB, and SQS state.

### Added

- Header controls to export `emulator-seed.json`, optionally including currently available SQS messages.
- A dedicated EC2 instance workspace with AMI discovery, instance launch, filtering, detailed networking and configuration views, lifecycle actions, and a keyboard-accessible service tutorial.
- An accessible restore dialog with file selection, drag-and-drop, resource previews, optional clean wipe, progress announcements, and partial-error reporting.
- Signed snapshot export and import support for S3 objects, DynamoDB table schemas and items, and SQS queue settings and messages.
- `EMULATOR_SEED_FILE` startup seeding when the configured emulator first becomes healthy.
- Automated validation, service batch-size, and oversized S3 object coverage.

### Limits

- S3 snapshot objects are limited to 16 MiB each.
- SQS exports can peek up to 10 currently available messages per queue. Receiving with zero visibility can still affect receive counters and dead-letter redrive behavior.
- Snapshot import validates the complete file before an optional clean wipe and continues across individual resource errors.

## 0.2.0 — 2026-11-21

This release adds standalone runtime options, live SDK traffic inspection, dedicated DynamoDB and SQS views, and modeled REST XML request bodies.

### Added

- Native runtime mode through `EMULATOR_MODE=native` and the configurable `EMULATOR_BINARY` executable.
- External runtime mode through `EMULATOR_MODE=external` for connecting to an emulator started outside the UI.
- Runtime-aware dashboard and header controls for Docker, native, and external processes.
- Loopback traffic proxy on `http://127.0.0.1:8790` for applications configured with `AWS_ENDPOINT_URL`.
- Live Traffic page showing request and response headers, bodies, status codes, service names, and duration.
- In-memory traffic history for the latest 200 calls, with 256 KiB request and response preview limits.
- DynamoDB table browser with paginated scans and an AttributeValue-aware item grid.
- SQS queue inspector with queue attributes and controls to receive, send, delete, and purge messages.
- Smithy-driven REST XML serialization for structures, unions, lists, maps, flattened members, XML attributes, namespaces, blobs, and timestamps.
- Four-frame product demonstration at `docs/demo.gif`.
- Automated coverage for REST XML generation and traffic capture/redaction.

### Changed

- Fixed the default emulator repository discovery to use the documented sibling `../aws-emulator` checkout.
- Made Docker and an emulator source checkout optional when using the dedicated resource views with an existing emulator.
- Updated onboarding with separate external, native, and Docker workflows.
- Updated configuration and troubleshooting documentation for `EMULATOR_MODE`, `EMULATOR_BINARY`, and `UI_PROXY_PORT`.
- Updated the navigation so S3, DynamoDB, SQS, and Traffic are available as dedicated pages while Console remains the universal Smithy fallback.
- Fixed state-changing S3 and Traffic DELETE requests to send the JSON content type required by the local API.

### Security and privacy

- The traffic proxy binds to `127.0.0.1` only and verifies the emulator certificate before forwarding requests.
- Captured authorization, security-token, cookie, and set-cookie headers are redacted.
- Traffic captures remain in memory and are not written to disk.
- Generated emulator credentials remain in the backend and are not exposed to browser code.

### Requirements and upgrade notes

- Node.js 18.x, 20.x, or 22 and later with npm. Node.js 20 LTS or a newer LTS release is recommended.
- Choose one runtime mode: Docker-managed, UI-managed native executable, or an externally managed emulator.
- The official AWS Emulator native package supports Linux. Windows and macOS require Docker or a separately supplied compatible executable.
- Docker mode still requires an official AWS Emulator checkout for its Dockerfile.
- The universal Console requires an official checkout for Smithy models. S3, DynamoDB, SQS, and Traffic can operate without one.
- Existing installations require no data migration. Run `npm ci`, rebuild the web application, and restart the server.

### Known limitations

- Dedicated EC2 and Lambda pages remain placeholders; their operations are available through Console.
- Smithy protocols outside the supported set must use Raw HTTP.
- A live emulator is required to use the resource views and verify traffic forwarding.
- Native process controls can stop only a process started by the current UI server process.
- S3 uploads are limited to 16 MiB per file, and inline previews are limited to 256 KiB.
- Emulator responses captured by the backend are limited to 20 MiB.
- Traffic body previews are limited to 256 KiB per direction and the latest 200 calls.
- Browser, Docker lifecycle, native-process, and live-emulator end-to-end tests are not included.

## 0.1.0 — 2026-11-20

Initial public release of the AWS Emulator companion web application.

### Added

- Dashboard with AWS Emulator health, Docker availability, image and container status, authentication state, indexed service totals, and recent request activity.
- Docker lifecycle controls to build an emulator image and start, resume, restart, stop, remove, and inspect a container.
- Service catalog generated from official AWS Emulator Smithy models.
- Generic operation console for AWS JSON 1.0/1.1, AWS Query, EC2 Query, REST JSON, and REST XML bindings.
- Raw HTTP console with optional service-specific SigV4 signing.
- JSON input validation, generated request skeletons, body overrides, response formatting, and local request history.
- S3 browser with bucket and object operations, pagination, upload, download, text preview, folders, filtering, and multi-selection.
- Responsive, accessible interface with hash navigation, status announcements, keyboard focus support, and reduced-motion support.
- Credits page and shared project footer.

### Known limitations

- Docker Desktop or another Docker daemon was required for the managed workflow.
- The repository path required explicit configuration for the documented sibling checkout.
- REST XML structure bodies required a manual body override.
- Dedicated DynamoDB, SQS, EC2, and Lambda pages were not available.
- Browser and Docker lifecycle end-to-end tests were not included.
