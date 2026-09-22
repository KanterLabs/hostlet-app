import standardProject from "../../contracts/v1/projects/valid-standard.json";

export type ProjectShape = "vite" | "node" | "next" | "fullstack";

export type ProjectDefaults = {
  shape: ProjectShape;
  includeDatabase: boolean;
  lockfilePath: string;
  staticRoot: string;
  applicationRoot: string;
};

type JsonObject = Record<string, unknown>;

const resources = standardProject.resources as JsonObject;

function staticService(root: string): JsonObject {
  return {
    name: "web",
    kind: "static_frontend",
    root,
    framework: "vite_static",
    node: { major: 24 },
    build_command: "npm run build",
    output_directory: "dist",
    start_command: null,
    health_check: null,
    uses_durable_data: false,
  };
}

function applicationService(root: string, framework: "node_http" | "nextjs16_standalone", durable: boolean): JsonObject {
  return {
    name: "app",
    kind: "application",
    root,
    framework,
    node: { major: 24 },
    build_command: "npm run build",
    output_directory: null,
    start_command: "npm run start",
    health_check: { protocol: "http", path: "/healthz" },
    uses_durable_data: durable,
  };
}

const databaseService: JsonObject = {
  name: "database",
  kind: "postgres",
  root: null,
  framework: "postgresql18",
  node: null,
  build_command: null,
  output_directory: null,
  start_command: null,
  health_check: null,
  uses_durable_data: false,
};

export function validStandardProjectSpec(values: ProjectDefaults): JsonObject {
  const includeStatic = values.shape === "vite" || values.shape === "fullstack";
  const includeApplication = values.shape !== "vite";
  const services: JsonObject[] = [];
  if (includeStatic) services.push(staticService(values.staticRoot.trim() || "."));
  if (includeApplication) {
    services.push(applicationService(
      values.applicationRoot.trim() || ".",
      values.shape === "next" ? "nextjs16_standalone" : "node_http",
      values.includeDatabase,
    ));
  }
  if (values.includeDatabase && includeApplication) services.push(databaseService);

  return {
    contract_version: "hostlet.project/v1",
    repositories: [{
      layout: values.shape === "fullstack" ? "monorepo" : "single_project",
      package_manager: "npm",
      lockfile_path: values.lockfilePath.trim() || "package-lock.json",
    }],
    services,
    resources: structuredClone(resources),
  };
}

export function safeProjectName(repositoryName: string): string {
  const name = repositoryName.replace(/[._-]+/g, " ").replace(/\s+/g, " ").trim();
  return (name || "My project").slice(0, 120);
}
