const RUN_LABEL = "dev.hostlet.e2e.run";
const OWNER_LABEL = "dev.hostlet.e2e.owner";
const OWNER_VALUE = "hostlet-foundation-e2e";
const POSTGRES_USER = "hostlet_e2e";
const POSTGRES_DB = "hostlet_e2e";

function resourceSuffix(runId) {
  return runId.toLowerCase().replace(/[^a-z0-9_.-]/g, "-").slice(-52);
}

export class OwnedPostgres {
  constructor(context, { image, password, hostPort }) {
    this.context = context;
    this.image = image;
    this.password = password;
    this.hostPort = hostPort;
    const suffix = resourceSuffix(context.state.runId);
    this.containerName = `hostlet-pg-${suffix}`;
    this.volumeName = `hostlet-pgdata-${suffix}`;
    this.commandSequence = 0;
    this.cleanupPromise = null;
    context.registerCleanup("run-owned PostgreSQL container and volume", () =>
      this.cleanup("runner finalization"),
    );
  }

  get databaseUrl() {
    return `postgresql://${POSTGRES_USER}:${encodeURIComponent(this.password)}@127.0.0.1:${this.hostPort}/${POSTGRES_DB}`;
  }

  dockerEnvironment() {
    const environment = {};
    for (const name of [
      "PATH",
      "HOME",
      "USER",
      "LOGNAME",
      "LANG",
      "LC_ALL",
      "TZ",
      "DOCKER_HOST",
      "DOCKER_CONTEXT",
      "DOCKER_CONFIG",
      "DOCKER_CERT_PATH",
      "DOCKER_TLS_VERIFY",
    ]) {
      if (process.env[name] !== undefined) environment[name] = process.env[name];
    }
    return {
      ...environment,
      POSTGRES_PASSWORD: this.password,
      PGPASSWORD: this.password,
      POSTGRES_USER,
      POSTGRES_DB,
    };
  }

  async command(
    label,
    args,
    { timeoutMs = 30_000, allowFailure = false, cleanup = false } = {},
  ) {
    this.commandSequence += 1;
    const result = await this.context.runCommand(`Docker ${label}`, "docker", args, {
      env: this.dockerEnvironment(),
      timeoutMs,
      logName: `foundation-docker-${String(this.commandSequence).padStart(2, "0")}-${label}.log`,
      cleanup,
    });
    if (!allowFailure && result.code !== 0) {
      throw new Error(`Docker ${label} failed with exit ${result.code}`);
    }
    return result;
  }

  async prepare() {
    const version = await this.command("version", ["--version"]);
    const daemon = await this.command("daemon", ["info", "--format", "{{.ServerVersion}}"]);
    this.context.state.prerequisites.push({
      name: "Docker daemon",
      required: true,
      passed: version.code === 0 && daemon.code === 0,
      observed: `${version.stdout.trim()} / server ${daemon.stdout.trim()}`,
    });
    this.context.state.toolchains.docker = {
      client: version.stdout.trim(),
      server: daemon.stdout.trim(),
    };

    await this.command("pull-image", ["pull", this.image], { timeoutMs: 120_000 });
    const imageIdentity = await this.command("image-identity", [
      "image",
      "inspect",
      "--format",
      "{{.Id}}|{{join .RepoDigests \",\"}}",
      this.image,
    ]);
    this.context.state.toolchains.postgresImage = imageIdentity.stdout.trim();

    await this.command("create-volume", [
      "volume",
      "create",
      "--label",
      `${OWNER_LABEL}=${OWNER_VALUE}`,
      "--label",
      `${RUN_LABEL}=${this.context.state.runId}`,
      this.volumeName,
    ]);
    if (!(await this.findOwnedVolume())) {
      throw new Error("new PostgreSQL volume was not observable with exact run ownership labels");
    }

    await this.command("start-container", [
      "run",
      "--detach",
      "--name",
      this.containerName,
      "--label",
      `${OWNER_LABEL}=${OWNER_VALUE}`,
      "--label",
      `${RUN_LABEL}=${this.context.state.runId}`,
      "--mount",
      `type=volume,source=${this.volumeName},target=/var/lib/postgresql`,
      "--publish",
      `127.0.0.1:${this.hostPort}:5432`,
      "--env",
      "POSTGRES_PASSWORD",
      "--env",
      "POSTGRES_USER",
      "--env",
      "POSTGRES_DB",
      this.image,
    ], { timeoutMs: 60_000 });

    await this.waitUntilReady();
  }

  async waitUntilReady() {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const ready = await this.command(
        "pg-isready",
        [
          "exec",
          this.containerName,
          "pg_isready",
          "--host",
          "127.0.0.1",
          "--port",
          "5432",
          "--username",
          POSTGRES_USER,
          "--dbname",
          POSTGRES_DB,
        ],
        { allowFailure: true, timeoutMs: 5_000 },
      );
      if (ready.code === 0) {
        const authenticated = await this.command(
          "tcp-authenticated-select",
          [
            "exec",
            "--env",
            "PGPASSWORD",
            this.containerName,
            "psql",
            "--no-psqlrc",
            "--host",
            "127.0.0.1",
            "--port",
            "5432",
            "--username",
            POSTGRES_USER,
            "--dbname",
            POSTGRES_DB,
            "--command",
            "SELECT 1;",
          ],
          { allowFailure: true, timeoutMs: 5_000 },
        );
        if (authenticated.code === 0) return;
      }
      await this.context.delay(200);
    }
    throw new Error("run-owned PostgreSQL did not become ready within 30000ms");
  }

  async stop() {
    await this.requireOwnedContainer();
    await this.command("stop-container", ["stop", "--time", "10", this.containerName], {
      timeoutMs: 20_000,
    });
  }

  async start() {
    await this.requireOwnedContainer();
    await this.command("restart-container", ["start", this.containerName], { timeoutMs: 20_000 });
    await this.waitUntilReady();
  }

  async psqlJson(label, sql) {
    const result = await this.command(`psql-${label}`, [
      "exec",
      this.containerName,
      "psql",
      "--no-psqlrc",
      "--tuples-only",
      "--no-align",
      "--set",
      "ON_ERROR_STOP=1",
      "--username",
      POSTGRES_USER,
      "--dbname",
      POSTGRES_DB,
      "--command",
      sql,
    ]);
    const output = result.stdout.trim();
    try {
      return JSON.parse(output);
    } catch {
      throw new Error(`independent SQL query ${label} did not return JSON`);
    }
  }

  async psqlCommand(label, sql) {
    const result = await this.command(`psql-${label}`, [
      "exec",
      this.containerName,
      "psql",
      "--no-psqlrc",
      "--set",
      "ON_ERROR_STOP=1",
      "--username",
      POSTGRES_USER,
      "--dbname",
      POSTGRES_DB,
      "--command",
      sql,
    ]);
    return { exitStatus: result.code };
  }

  spawnPsql(label, sql) {
    this.commandSequence += 1;
    return this.context.spawnManaged(
      `Docker psql ${label}`,
      "docker",
      [
        "exec",
        this.containerName,
        "psql",
        "--no-psqlrc",
        "--set",
        "ON_ERROR_STOP=1",
        "--username",
        POSTGRES_USER,
        "--dbname",
        POSTGRES_DB,
        "--command",
        sql,
      ],
      { env: this.dockerEnvironment() },
      `foundation-docker-${String(this.commandSequence).padStart(2, "0")}-psql-${label}.log`,
    );
  }

  async psqlExpectFailure(label, sql, expectedSqlStates) {
    const acceptedStates = Array.isArray(expectedSqlStates) ? expectedSqlStates : [expectedSqlStates];
    if (!acceptedStates.length || acceptedStates.some((state) => !/^\d{5}$/.test(state))) {
      throw new Error(`independent SQL negative check ${label} requires an expected SQLSTATE`);
    }
    const result = await this.command(
      `psql-${label}`,
      [
        "exec",
        this.containerName,
        "psql",
        "--no-psqlrc",
        "--tuples-only",
        "--no-align",
        "--set",
        "ON_ERROR_STOP=1",
        "--set",
        "VERBOSITY=verbose",
        "--username",
        POSTGRES_USER,
        "--dbname",
        POSTGRES_DB,
        "--command",
        sql,
      ],
      { allowFailure: true },
    );
    if (result.code === 0) {
      throw new Error(`independent SQL negative check ${label} unexpectedly succeeded`);
    }
    const observedState = acceptedStates.find((state) =>
      new RegExp(`(?:ERROR|FATAL):\\s+${state}:`).test(result.stderr),
    );
    if (!observedState) {
      throw new Error(`independent SQL negative check ${label} failed without the expected SQLSTATE`);
    }
    return { exitStatus: result.code, sqlState: observedState };
  }

  async requireOwnedContainer() {
    const result = await this.command("verify-container-owner", [
      "container",
      "ls",
      "--all",
      "--filter",
      `name=^/${this.containerName}$`,
      "--format",
      `{{.Names}}|{{.Label \"${OWNER_LABEL}\"}}|{{.Label \"${RUN_LABEL}\"}}`,
    ]);
    const expected = `${this.containerName}|${OWNER_VALUE}|${this.context.state.runId}`;
    if (result.stdout.trim() !== expected) {
      throw new Error("refusing to operate on PostgreSQL container without exact run ownership labels");
    }
  }

  async findOwnedContainer({ cleanup = false } = {}) {
    const result = await this.command("find-container", [
      "container",
      "ls",
      "--all",
      "--filter",
      `name=^/${this.containerName}$`,
      "--format",
      `{{.Names}}|{{.Label \"${OWNER_LABEL}\"}}|{{.Label \"${RUN_LABEL}\"}}`,
    ], { cleanup });
    const output = result.stdout.trim();
    if (!output) return false;
    const expected = `${this.containerName}|${OWNER_VALUE}|${this.context.state.runId}`;
    if (output !== expected) {
      throw new Error("refusing to remove PostgreSQL container without exact run ownership labels");
    }
    return true;
  }

  async findOwnedVolume({ cleanup = false } = {}) {
    const result = await this.command("find-volume", [
      "volume",
      "ls",
      "--filter",
      `name=^${this.volumeName}$`,
      "--format",
      `{{.Name}}|{{.Label \"${OWNER_LABEL}\"}}|{{.Label \"${RUN_LABEL}\"}}`,
    ], { cleanup });
    const output = result.stdout.trim();
    if (!output) return false;
    const expected = `${this.volumeName}|${OWNER_VALUE}|${this.context.state.runId}`;
    if (output !== expected) {
      throw new Error("refusing to remove PostgreSQL volume without exact run ownership labels");
    }
    return true;
  }

  async cleanup(reason = "normal completion") {
    if (this.cleanupPromise) return this.cleanupPromise;
    this.cleanupPromise = this.performCleanup(reason);
    return this.cleanupPromise;
  }

  async performCleanup(reason) {
    const cleanupErrors = [];
    try {
      if (await this.findOwnedContainer({ cleanup: true })) {
        const removed = await this.command(
          "remove-container",
          ["container", "rm", "--force", this.containerName],
          { allowFailure: true, timeoutMs: 20_000, cleanup: true },
        );
        if (removed.code !== 0) {
          cleanupErrors.push("container removal failed");
          this.context.state.cleanup.push({
            resource: this.containerName,
            action: `${reason}; remove exact labeled run-owned PostgreSQL container`,
            result: "retained: Docker removal failed",
          });
        } else {
          this.context.state.cleanup.push({
            resource: this.containerName,
            action: `${reason}; remove exact labeled run-owned PostgreSQL container`,
            result: "removed",
          });
        }
      } else {
        this.context.state.cleanup.push({
          resource: this.containerName,
          action: `${reason}; inspect exact run-owned PostgreSQL container`,
          result: "already absent",
        });
      }
    } catch {
      cleanupErrors.push("container ownership check or removal failed");
      this.context.state.cleanup.push({
        resource: this.containerName,
        action: `${reason}; verify/remove exact labeled run-owned PostgreSQL container`,
        result: "retained or unknown: cleanup command failed",
      });
    }

    try {
      if (await this.findOwnedVolume({ cleanup: true })) {
        const removed = await this.command(
          "remove-volume",
          ["volume", "rm", this.volumeName],
          { allowFailure: true, timeoutMs: 20_000, cleanup: true },
        );
        if (removed.code !== 0) {
          cleanupErrors.push("volume removal failed");
          this.context.state.cleanup.push({
            resource: this.volumeName,
            action: `${reason}; remove exact labeled run-owned PostgreSQL data volume`,
            result: "retained: Docker removal failed",
          });
        } else {
          this.context.state.cleanup.push({
            resource: this.volumeName,
            action: `${reason}; remove exact labeled run-owned PostgreSQL data volume`,
            result: "removed",
          });
        }
      } else {
        this.context.state.cleanup.push({
          resource: this.volumeName,
          action: `${reason}; inspect exact run-owned PostgreSQL data volume`,
          result: "already absent",
        });
      }
    } catch {
      cleanupErrors.push("volume ownership check or removal failed");
      this.context.state.cleanup.push({
        resource: this.volumeName,
        action: `${reason}; verify/remove exact labeled run-owned PostgreSQL data volume`,
        result: "retained or unknown: cleanup command failed",
      });
    }

    if (cleanupErrors.length) throw new Error(cleanupErrors.join("; "));
  }
}
