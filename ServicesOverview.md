# Services Overview

This guide explains how the S3 and EC2 pages work and walks through each one step by step. It assumes the UI and AWS Emulator are already running; see [README.md](README.md) for setup.

In both services, AWS Emulator is the source of truth. It stores buckets, objects, instances, and settings in memory. The UI backend adds behavior that the emulator does not run on its own: serving websites, enforcing policies for anonymous visitors, running lifecycle rules, and running real Linux containers.

## S3

### How it works

```
Browser (S3 page) ──/api/s3/*──▶ UI backend (port 8787) ──SigV4 / HTTPS──▶ AWS Emulator (port 9297)
                                      │
Website visitor ──/s3-web/*──▶ Website endpoint (port 8791)
```

1. The S3 page calls the UI backend under `/api/s3/...`.
2. The backend signs each request with the emulator's generated credentials and sends it to the emulator over HTTPS. Basic bucket and object calls use `server/s3.js`; sandbox features use `@aws-sdk/client-s3` in `server/s3LearningBridge.js`.
3. The emulator stores the result: objects, versions, delete markers, the website configuration, Block Public Access settings, the bucket policy, and lifecycle rules.
4. The backend adds three behaviors on top:
   - **Website endpoint:** a separate server on port 8791 answers `GET /s3-web/<bucket>/...` the way an S3 website endpoint would.
   - **Policy evaluation:** the backend evaluates the bucket policy for anonymous website visitors and for the policy simulator.
   - **Lifecycle time travel:** the backend keeps a simulated clock per bucket and deletes expired versions in the emulator when you jump forward.

#### How a website request is answered

For each `GET` or `HEAD` to `http://localhost:8791/s3-web/<bucket>/<path>`, the endpoint checks these steps in order and stops at the first failure:

1. **Bucket exists.** If not: `404 NoSuchBucket`.
2. **Website hosting is enabled** (`GetBucketWebsite`). If not: `404 NoSuchWebsiteConfiguration`.
3. **Block Public Access allows public reads** (`GetPublicAccessBlock`). If `BlockPublicPolicy` or `RestrictPublicBuckets` is on: `403 AccessDenied`.
4. **The key is resolved.** `/` and any path ending in `/` get the index document appended, for example `docs/` becomes `docs/index.html`.
5. **The bucket policy allows anonymous `s3:GetObject` on that key** (`GetBucketPolicy`). An explicit Deny or a missing Allow gives `403 AccessDenied`.
6. **The object is fetched and streamed** (`GetObject`) with its `Content-Type`.
7. **If the key does not exist:** `/folder` redirects to `/folder/` when `folder/<index document>` exists. Otherwise the endpoint returns the error document with status 404, or `404 NoSuchKey` when there is no readable error document.

Every error is an S3-style XML body with an `X-Learner-Hint` header that names the rule that blocked the request. Open your browser's developer tools (Network tab) to read it.

#### How the policy simulator decides

1. It reads the policy in the editor, including unsaved edits. With an empty editor, it treats the bucket as having no policy.
2. It checks every statement's Principal, Action, Resource, and Condition against the test request.
3. If any matching statement has `"Effect": "Deny"`, the result is **EXPLICIT_DENY**. A Deny always wins.
4. Otherwise, if any matching statement has `"Effect": "Allow"`, the result is **ALLOWED**.
5. Otherwise, the result is **IMPLICIT_DENY**, because S3 denies anything that is not explicitly allowed.
6. For anonymous callers, an ALLOWED result becomes a denial when the saved Block Public Access settings block public access.

#### How a time-travel jump works

1. The bucket's simulated offset grows by the number of days you choose.
2. The backend reads the lifecycle rules and lists every object version and delete marker.
3. For each **current** version that matches an Enabled rule's prefix, its age is its last-modified time plus the simulated days. If the age reaches `Expiration.Days`, the backend calls `DeleteObject`. A versioned bucket gets a delete marker; an unversioned bucket loses the object permanently.
4. For each **noncurrent** version, its age counts from the moment a newer version or delete marker replaced it. If that age reaches `NoncurrentDays`, the backend permanently deletes that version.
5. The backend returns a log of every action, which the UI shows in the audit log.

### Walkthrough: objects and versioning

1. Open **S3**, type a bucket name, and select **+** to create a bucket.
2. Select the bucket. The **Objects & Versions** tab opens.
3. Select **Upload** and upload a small text file, for example `notes.txt`.
4. Select the **Versioning: Disabled** badge and confirm **Enable versioning**. The badge changes to **Versioning: Enabled**.
5. Edit `notes.txt` on your computer and upload it again with the same name.
6. Turn on **Show All Versions**. `notes.txt` now shows a green **Latest** row and a gray **Previous Version** row. The previous version's ID is `null` because it was uploaded before versioning was enabled.
7. Turn off **Show All Versions**, select `notes.txt`, and select **Delete selected**. The dialog explains that S3 adds a delete marker instead of erasing data. Confirm.
8. `notes.txt` disappears from the normal list. Turn **Show All Versions** back on: the key now has a red **Delete Marker** row marked "Object appears deleted to standard GET requests".
9. Select **Restore Object** on the delete marker row. The marker is removed, and the newest real version becomes **Latest** again.

### Walkthrough: host a static website

1. Create a bucket, or select an existing one, and open the **Static Website** tab.
2. Select **Load Sample Portfolio Site**. This uploads `index.html`, `style.css`, and `404.html`.
3. Turn on **Enable static website hosting**. Keep `index.html` as the index document and `404.html` as the error document, then select **Save website settings**.
4. Open the **Bucket Website Endpoint** link. If any checklist item is not done yet, the page shows an XML error; that is expected at this step.
5. Read the checklist. Each item that is not done shows ✗ and a plain-English reason.
6. Select **Open Permissions**. If Block Public Access is on, turn off **Block all public access**, select **Save Block Public Access**, and confirm.
7. In **Bucket Policy**, open **Load Beginner Preset…** and select **Public Read-Only (Static Website Hosting)**, then select **Save policy**.
8. Return to **Static Website** and select **Re-check**. All three checklist items now show ✓.
9. Open the endpoint again. The portfolio page loads with its stylesheet.
10. On the page, select **Open a missing page**. The endpoint returns `404.html` with status 404.
11. To see access enforcement, turn Block Public Access back on in **Permissions**, then reload the website. It returns `403 AccessDenied`, and `X-Learner-Hint` says Block Public Access is enabled.

### Walkthrough: test bucket policies

1. Open the **Permissions** tab.
2. In **Bucket Policy**, open **Load Beginner Preset…** and select **Deny Unencrypted Object Uploads (SSE-S3 Required)**. You do not need to save it to test it.
3. In **Test a request**, set **Action** to `s3:PutObject`, **Object key** to `notes.txt`, and **Caller** to **Authenticated Student**. Leave **Encryption header** at **None (unencrypted)**.
4. Select **Test Request**. The red card shows **EXPLICIT_DENY** and names `DenyUnencryptedObjectUploads`, because the upload sent no encryption header.
5. Change **Encryption header** to **AES256 (SSE-S3)** and test again. The Deny no longer matches. The result is **IMPLICIT_DENY**, because the preset contains no Allow statement.
6. Load **Allow Read Access Only to public/ Prefix**. Test `s3:GetObject` as **Anonymous Public User** on `public/photo.jpg` (green, ALLOWED), then on `private/photo.jpg` (red, IMPLICIT_DENY).
7. Expand **Show statement-by-statement evaluation** on any result to see why each statement did or did not apply.
8. Select **Save policy** only when you want the policy to take effect. The saved policy applies to website visitors immediately. While the Deny Unencrypted preset is saved, the emulator refuses uploads from the normal **Upload** button, because that button sends no encryption header.

### Walkthrough: lifecycle time travel

1. On the **Objects & Versions** tab, enable versioning. Create a `logs` folder and upload a file into it twice, so the file has a current version and a previous version.
2. Open the **Lifecycle & Time-Travel** tab.
3. Enter **Rule ID** `expire-logs`, **Prefix filter** `logs/`, **Expire current objects after (days)** `30`, and **Permanently delete noncurrent versions after (days)** `7`. Select **Add rule**.
4. Select **+1 Day**. The offset shows **+1 Day**, and the audit log reports that nothing reached a threshold.
5. Select **+7 Days**. The offset is now +8. The previous version has been noncurrent for 8 days, so the log shows **Noncurrent version purged**.
6. Select **+30 Days**. The offset is now +38. The current version is 38 simulated days old, so the log shows **Delete marker created**. The data survives as a noncurrent version.
7. Select **+7 Days**. That version has now been noncurrent for 7 days, so it is purged.
8. Return to **Objects & Versions** with **Show All Versions** on. Only the delete marker remains for the file.
9. Select **Reset Clock** to return the offset to +0 and clear the audit log. Objects already deleted stay deleted.

### S3 sandbox limits

- `BlockPublicPolicy` blocks website reads in the sandbox. In real AWS, only `RestrictPublicBuckets` blocks reads.
- The simulator evaluates only the bucket policy, not IAM identity policies.
- Lifecycle jumps skip rules that filter on tags or perform storage-class transitions.
- The simulated clock resets when the UI server restarts.

## EC2

### How it works

```
Browser (EC2 page) ──/api/ec2/*──▶ UI backend ──SigV4 / HTTPS──▶ AWS Emulator (EC2 metadata)
                                       │
                                       └──dockerode──▶ Local Docker (container aws-emu-ec2-<instance-id>)
Browser terminal ──WebSocket /ws/ec2/connect/<id>──▶ UI backend ──docker exec──▶ /bin/bash in the container
```

1. The EC2 page calls the UI backend under `/api/ec2/...`.
2. The backend uses `@aws-sdk/client-ec2` to call the emulator. The emulator always records the instance first and assigns its instance ID, state, and networking metadata.
3. When local Docker is available and the AMI is a local preset, the Local Compute Bridge (`server/ec2ComputeBridge.js`) creates a matching container named `aws-emu-ec2-<instance-id>`. Labels link the container to its instance ID.
4. Lifecycle actions update the emulator first and then apply the same action to the container:

   | EC2 action | Container action |
   |---|---|
   | RunInstances | Pull the image if needed, then create and start the container |
   | StopInstances | Stop the container |
   | StartInstances | Start the container |
   | RebootInstances | Restart the container |
   | TerminateInstances | Remove the container |

5. Each instance list refresh reconciles the two sides. A container is stopped, started, or removed to match its emulator instance's state, and a complete refresh removes managed containers whose instance no longer exists.
6. Without Docker, or with a non-preset AMI, EC2 runs in **metadata-only mode**. The emulator still records instances and lifecycle changes, but no container runs.

#### Local AMI presets and instance types

| AMI preset | AMI ID | Docker image | Notes |
|---|---|---|---|
| Ubuntu 24.04 LTS | `ami-02404000000000001` | `ubuntu:24.04` | Unprivileged; shell is `/bin/bash` |
| Docker-in-Docker Sandbox | `ami-0d0cce00000000001` | `docker:27.5.1-dind` | Privileged; requires explicit approval; shell is `/bin/sh` |

| Instance type | CPU limit | Memory limit |
|---|---|---|
| `t2.micro` | 1 vCPU | 1 GiB |
| `t3.micro` | 1 vCPU | 1 GiB |
| `t3.small` | 2 vCPU | 2 GiB |

#### What happens to user data

1. The backend accepts a plain shell script or base64 text, up to 1 MB.
2. After the container starts, the script is written to `/var/lib/cloud/instance/user-data.sh`.
3. The script runs in the background, and its output goes to `/var/log/cloud-init-output.log`.

### Walkthrough: launch and connect to an Ubuntu instance

1. Start Docker Desktop, then open **EC2**.
2. Check the status button at the top of the instance list. **Compute Engine: Local Docker Active** means live sandboxes are available. **Metadata-Only Mode** means Docker is not reachable; select the button to check again after Docker starts.
3. Select **Launch instance** to open the launch form.
4. Set **AMI** to **Ubuntu 24.04 LTS (ubuntu:24.04)** and **Instance type** to `t3.micro`. Keep **Count** at `1`, and optionally enter a **Name tag** such as `web-server`.
5. In **Port forwarding**, enter `8080:80`. Host port 8080 is bound to `127.0.0.1` only.
6. In **User data**, enter:

   ```bash
   #!/bin/bash
   apt-get update && apt-get install -y nginx
   nginx
   ```

7. Select **Launch**. The first launch can take longer while Docker downloads `ubuntu:24.04`.
8. The instance appears as `pending` and then `running`. Select it to see its details.
9. Select **Connect**. A browser terminal opens a shell inside the container.
10. Select **View Cloud-Init Boot Logs** to read the user-data output from `/var/log/cloud-init-output.log`.
11. When nginx finishes installing, open `http://127.0.0.1:8080` to see its welcome page.

### Walkthrough: lifecycle actions

1. Select a running instance.
2. Select **Stop**. The emulator moves the instance to `stopping` and then `stopped`, and the container stops. **Connect** becomes unavailable.
3. Select **Start**. The instance and its container run again. Files written before the stop are still there, because the container is reused.
4. Select **Reboot**. The container restarts and the instance stays `running`.
5. Select **Terminate** and confirm. The instance moves to `terminated` and its container is removed. A terminated instance cannot be started again.

### Walkthrough: Docker-in-Docker sandbox

1. Select **Launch instance**, then set **AMI** to **Docker-in-Docker Sandbox (privileged)**.
2. Read the **Privileged local container** warning and select its checkbox. **Launch** stays disabled until you approve.
3. Launch the instance, wait for `running`, and select **Connect**.
4. Run `docker run --rm hello-world` inside the terminal to use the nested Docker daemon.

Use this preset only for commands you trust. A privileged container has broad access to the host kernel and devices.

### EC2 limits

- Instances launched while Docker is unavailable stay metadata-only. Launch a new instance after Docker starts to get a sandbox.
- Port forwarding works only when launching one instance at a time.
- AMIs other than the two presets, and instance types other than `t2.micro`, `t3.micro`, and `t3.small`, run in metadata-only mode.
- The Docker-in-Docker preset is not a security boundary for untrusted code.
