import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import YAML from "yaml";

import { RUNTIME_KIND, runtimeFor, runtimeKindFor } from "../src/lib/runtimes/index.js";
import { dockerRuntime } from "../src/lib/runtimes/docker-runtime.js";
import { kubeRuntime, manifestPathFor } from "../src/lib/runtimes/kube-runtime.js";
import {
  buildConfigClaim,
  buildDeployment,
  buildEnv,
  buildExposure,
  buildIngress,
  buildKubeManifests,
  buildRoute,
  buildService,
  exposureKindFor,
  renderKubeManifests
} from "../src/lib/runtimes/kube-manifests.js";
import { buildEndpoint, resolveLink } from "../src/lib/wiring/topology.js";
import { buildServiceFromCatalog } from "../src/lib/service-catalog.js";
import { normalizeSettings } from "../src/lib/store.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const stubOc = path.join(here, "fixtures", "stub-oc.mjs");

// --- the port ---

/**
 * The operations the facade dispatches. Written out rather than derived from
 * the module, so that adding an export without implementing it somewhere fails
 * here instead of at the moment a user clicks the button.
 */
const CONTRACT = [
  "readConfigMountSource", "inspectContainers", "readContainerFile", "snapshotConfig",
  "restoreConfigSnapshot", "pruneServiceBackups", "backupService", "stopContainer",
  "startContainer", "renameContainer", "removeContainer", "containerExists",
  "inspectContainerState", "composeDown", "findRollbackPoint", "imageExistsLocally",
  "composeDownRemovingVolumes", "removeImage", "measurePath", "restartService",
  "composePs", "ensureSharedNetwork", "generateAndDeploy", "installService",
  "upgradeService", "pullImage", "readImageId", "readContainerImageIdByName",
  "tagImage", "readContainerLogs", "readContainerOutcome", "runDetachedContainer",
  "checkForUpdates", "upgradeAllServices", "readNetworkDrivers", "attachController"
];

test("both runtimes implement every operation the port dispatches", () => {
  for (const name of CONTRACT) {
    assert.equal(typeof dockerRuntime[name], "function", `dockerRuntime is missing ${name}`);
    assert.equal(typeof kubeRuntime[name], "function", `kubeRuntime is missing ${name}`);
  }
});

test("neither runtime quietly grows an operation the other lacks", () => {
  const ops = (runtime) => Object.keys(runtime).filter((key) => typeof runtime[key] === "function").sort();

  assert.deepEqual(ops(dockerRuntime), ops(kubeRuntime));
});

test("settings with no runtime key mean Docker, now and permanently", () => {
  // Every install predating a second runtime has no such key. Reading its
  // absence as anything else would switch a working stack out from under it.
  assert.equal(runtimeKindFor({}), RUNTIME_KIND.DOCKER);
  assert.equal(runtimeKindFor(), RUNTIME_KIND.DOCKER);
  assert.equal(runtimeFor({ runtime: undefined }), dockerRuntime);
});

test("an unrecognised runtime falls back rather than failing", () => {
  assert.equal(runtimeFor({ runtime: "nomad" }), dockerRuntime);
});

test("the kube runtime is selected when settings ask for it", () => {
  assert.equal(runtimeKindFor({ runtime: "kube" }), RUNTIME_KIND.KUBE);
});

// --- manifests ---

const SETTINGS = normalizeSettings({
  initialized: true,
  runtime: "kube",
  kubeNamespace: "media",
  kubeMediaClaim: "media-library",
  puid: "911",
  pgid: "911",
  tz: "America/Chicago",
  selectedServiceIds: ["radarr", "seerr", "flaresolverr"]
});

const radarr = () => buildServiceFromCatalog(SETTINGS, "radarr");

test("a deployment never rolls, because its database cannot be shared", () => {
  // RollingUpdate starts the new pod before stopping the old one. On a
  // ReadWriteOnce claim that hangs; on ReadWriteMany it succeeds and two
  // processes write one SQLite database. The second is silent and loses data.
  assert.equal(buildDeployment(SETTINGS, radarr()).spec.strategy.type, "Recreate");
});

test("the pod asks for the stack's identity rather than taking the namespace's", () => {
  const security = buildDeployment(SETTINGS, radarr()).spec.template.spec.securityContext;

  assert.equal(security.runAsUser, 911);
  assert.equal(security.runAsGroup, 911);
  // fsGroup is what makes a freshly provisioned claim writable at all.
  assert.equal(security.fsGroup, 911);
});

test("compose variable references are resolved, not written through literally", () => {
  const env = new Map(buildEnv(SETTINGS, radarr()).map((entry) => [entry.name, entry.value]));

  // There is no .env file beside a manifest, so "${PUID}" would arrive at the
  // container as those eight characters.
  assert.equal(env.get("PUID"), "911");
  assert.equal(env.get("TZ"), "America/Chicago");
  assert.ok(![...env.values()].some((value) => value.includes("${")));
});

test("the config claim is Keelarr's to create; the media claim is the operator's", () => {
  const deployment = buildDeployment(SETTINGS, radarr());
  const volumes = new Map(deployment.spec.template.spec.volumes.map((volume) => [volume.name, volume]));

  assert.equal(volumes.get("config").persistentVolumeClaim.claimName, "radarr-config");
  // Shared by every app and outliving all of them — the same reason mediaRoot
  // is a path Keelarr is given rather than one it makes.
  assert.equal(volumes.get("media").persistentVolumeClaim.claimName, "media-library");
  assert.equal(
    buildKubeManifests(SETTINGS, radarr()).filter((doc) => doc.kind === "PersistentVolumeClaim").length,
    1
  );
});

test("the config claim is ReadWriteOnce, matching the one-writer rule", () => {
  assert.deepEqual(buildConfigClaim(SETTINGS, radarr()).spec.accessModes, ["ReadWriteOnce"]);
});

test("no storage class is named when none was chosen", () => {
  // Naming one that does not exist leaves the claim Pending with no clear cause.
  assert.equal("storageClassName" in buildConfigClaim(SETTINGS, radarr()).spec, false);
  assert.equal(
    buildConfigClaim(normalizeSettings({ ...SETTINGS, kubeStorageClass: "ceph-rbd" }), radarr()).spec.storageClassName,
    "ceph-rbd"
  );
});

test("Seerr's manifest mounts the path Seerr actually writes to", () => {
  const seerr = buildServiceFromCatalog(SETTINGS, "seerr");
  const mount = buildDeployment(SETTINGS, seerr).spec.template.spec.containers[0].volumeMounts
    .find((entry) => entry.name === "config");

  assert.equal(mount.mountPath, "/app/config");
});

test("a service that stores nothing gets no claim", () => {
  const flaresolverr = buildServiceFromCatalog(SETTINGS, "flaresolverr");
  const kinds = buildKubeManifests(SETTINGS, flaresolverr).map((doc) => doc.kind);

  assert.equal(kinds.includes("PersistentVolumeClaim"), false);
  assert.deepEqual(kinds, ["Deployment", "Service"]);
});

test("the Service targets the port by name so the two cannot drift", () => {
  const service = buildService(SETTINGS, radarr());

  assert.equal(service.spec.ports[0].port, 7878);
  assert.equal(service.spec.ports[0].targetPort, "http");
  assert.deepEqual(service.spec.selector, buildDeployment(SETTINGS, radarr()).spec.selector.matchLabels);
});

test("no route is invented when no domain was given", () => {
  // A hostless Route works and produces an address nobody can predict — and
  // these are addresses people bookmark.
  assert.equal(buildRoute(SETTINGS, radarr()), null);
});

test("a route is built once there is a domain to build it from", () => {
  const route = buildRoute(exposed(), radarr());

  assert.equal(route.spec.host, "radarr.apps.example.com");
  assert.equal(route.spec.tls.termination, "edge");
});

// --- the two cluster flavours ---

const exposed = (overrides = {}) =>
  normalizeSettings({ ...SETTINGS, kubeDomain: "apps.example.com", ...overrides });

test("OKD is exposed with a Route and plain Kubernetes with an Ingress", () => {
  assert.equal(buildExposure(exposed(), radarr()).kind, "Route");
  assert.equal(buildExposure(exposed({ kubeFlavor: "kubernetes" }), radarr()).kind, "Ingress");
});

test("neither flavour exposes anything without a domain", () => {
  assert.equal(buildExposure(SETTINGS, radarr()), null);
  assert.equal(buildExposure(normalizeSettings({ ...SETTINGS, kubeFlavor: "kubernetes" }), radarr()), null);
});

test("an ingress routes the whole app, not just its front page", () => {
  const rule = buildIngress(exposed({ kubeFlavor: "kubernetes" }), radarr()).spec.rules[0];

  assert.equal(rule.host, "radarr.apps.example.com");
  // These apps serve their own assets from below the root; Exact would match
  // the front page and 404 everything it loads.
  assert.equal(rule.http.paths[0].pathType, "Prefix");
  assert.deepEqual(rule.http.paths[0].backend.service, { name: "radarr", port: { name: "http" } });
});

test("an ingress class is named only when one was chosen", () => {
  const spec = (overrides) => buildIngress(exposed({ kubeFlavor: "kubernetes", ...overrides }), radarr()).spec;

  assert.equal("ingressClassName" in spec({}), false);
  assert.equal(spec({ kubeIngressClass: "nginx" }).ingressClassName, "nginx");
});

test("an ingress is plain HTTP until a certificate is named, and says nothing otherwise", () => {
  // A Route gets TLS from the OKD router for free; an Ingress does not. Quietly
  // serving these apps over HTTP would be a downgrade nobody chose.
  assert.equal("tls" in buildIngress(exposed({ kubeFlavor: "kubernetes" }), radarr()).spec, false);

  const secured = buildIngress(exposed({ kubeFlavor: "kubernetes", kubeTlsSecret: "wildcard-tls" }), radarr());
  assert.deepEqual(secured.spec.tls, [{ hosts: ["radarr.apps.example.com"], secretName: "wildcard-tls" }]);
});

test("the CLI defaults to the one the flavour actually has", () => {
  // `kubectl` cannot create a Route, and `oc` is rarely installed beside a
  // plain cluster, so a single fixed default is wrong half the time.
  assert.equal(normalizeSettings({ runtime: "kube" }).kubeBin, "oc");
  assert.equal(normalizeSettings({ runtime: "kube", kubeFlavor: "kubernetes" }).kubeBin, "kubectl");
  assert.equal(
    normalizeSettings({ runtime: "kube", kubeFlavor: "kubernetes", kubeBin: "/opt/bin/oc" }).kubeBin,
    "/opt/bin/oc"
  );
});

test("an unrecognised flavour falls back rather than generating nothing", () => {
  assert.equal(normalizeSettings({ runtime: "kube", kubeFlavor: "nomad" }).kubeFlavor, "okd");
});

test("the rendered manifest for a plain cluster mentions no OpenShift types", () => {
  const yaml = renderKubeManifests(exposed({ kubeFlavor: "kubernetes" }), radarr());

  assert.ok(!yaml.includes("route.openshift.io"));
  assert.ok(yaml.includes("networking.k8s.io/v1"));
});

test("the claim is applied before the deployment that waits on it", () => {
  // A Deployment with no claim sits Pending, which is a much harder thing to
  // explain than a missing volume.
  const kinds = buildKubeManifests(SETTINGS, radarr()).map((doc) => doc.kind);

  assert.ok(kinds.indexOf("PersistentVolumeClaim") < kinds.indexOf("Deployment"));
});

test("the rendered file is valid multi-document YAML", () => {
  const documents = YAML.parseAllDocuments(renderKubeManifests(SETTINGS, radarr())).map((doc) => doc.toJS());

  assert.deepEqual(documents.map((doc) => doc.kind), ["PersistentVolumeClaim", "Deployment", "Service"]);
  assert.ok(documents.every((doc) => doc.metadata.namespace === "media"));
});

// --- the kube runtime, through a stub binary ---

async function kubeHarness(state = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "keelarr-kube-"));
  const statePath = path.join(dir, "state.json");
  await writeFile(statePath, JSON.stringify({ log: [], ...state }), "utf8");
  process.env.STUB_OC_STATE = statePath;

  const settings = normalizeSettings({
    ...SETTINGS,
    kubeBin: stubOc,
    stackRoot: dir
  });
  const service = buildServiceFromCatalog(settings, "radarr");

  return {
    settings,
    service,
    dir,
    log: async () => JSON.parse(await readFile(statePath, "utf8")).log
  };
}

test("deploying writes the manifest, applies it, and waits for the rollout", async () => {
  const { settings, service, log } = await kubeHarness();
  const result = await kubeRuntime.generateAndDeploy(settings, service);
  const calls = await log();

  assert.equal(result.ok, true);
  assert.match(calls[0], /^-n media apply -f .*okd\/manifests\.yaml$/);
  // Apply returns when the API server has stored the object, which is long
  // before anything runs. Without this, success would mean "YAML accepted".
  assert.match(calls[1], /^-n media rollout status deployment\/radarr/);
  assert.ok(await readFile(manifestPathFor(service), "utf8"));
});

test("a failed rollout is a failed deploy, however happily apply returned", async () => {
  const { settings, service } = await kubeHarness({
    failCommand: "rollout status",
    failMessage: "error: deployment \"radarr\" exceeded its progress deadline"
  });
  const result = await kubeRuntime.generateAndDeploy(settings, service);

  assert.equal(result.ok, false);
});

test("stopping a service leaves its data alone", async () => {
  const { settings, service, log } = await kubeHarness();
  await kubeRuntime.composeDown(settings, service);
  const [call] = await log();

  // `compose down` keeps named volumes, and this has to make the same promise:
  // deleting the claim here would make every upgrade a data loss.
  assert.ok(!call.includes("pvc"));
  assert.match(call, /delete deployment,service,route -l app\.kubernetes\.io\/name=radarr/);
});

test("teardown names the resource kind the cluster actually has", async () => {
  // `oc delete ... route` against a plain cluster fails the whole command with
  // "the server doesn't have a resource type route", so a fixed list would tear
  // down nothing at all on one of the two flavours.
  const okd = await kubeHarness();
  await kubeRuntime.composeDown(okd.settings, okd.service);
  assert.match((await okd.log())[0], /delete deployment,service,route /);

  const plain = await kubeHarness();
  const plainSettings = normalizeSettings({ ...plain.settings, kubeFlavor: "kubernetes", kubeBin: stubOc });
  await kubeRuntime.composeDown(plainSettings, plain.service);
  const call = (await plain.log())[0];
  assert.match(call, /delete deployment,service,ingress /);
  assert.ok(!call.includes("route"));
});

test("the kinds a flavour has are named for the CLI", () => {
  assert.equal(exposureKindFor(SETTINGS), "route");
  assert.equal(exposureKindFor(normalizeSettings({ ...SETTINGS, kubeFlavor: "kubernetes" })), "ingress");
});

test("measuring a path reports unknown rather than running a broken command", async () => {
  // The caller passes null whenever config lives in a volume, which on a
  // cluster it always does. Inventing a target produced `deployment/`.
  assert.equal(await kubeRuntime.measurePath(SETTINGS, null, {}), null);
  assert.equal(await kubeRuntime.measurePath(SETTINGS, "/config", {}), null);
});

test("removing with volumes is the only path that deletes the claim", async () => {
  const { settings, service, log } = await kubeHarness();
  await kubeRuntime.composeDownRemovingVolumes(settings, service);

  assert.match((await log())[0], /delete deployment,service,route,pvc/);
});

test("pods are translated into the inspect shape the rest of Keelarr reads", async () => {
  const { settings } = await kubeHarness({
    pods: {
      items: [{
        metadata: { labels: { "app.kubernetes.io/name": "radarr", "app.kubernetes.io/managed-by": "keelarr" } },
        spec: { containers: [{ image: "lscr.io/linuxserver/radarr:latest", ports: [{ containerPort: 7878 }], env: [], volumeMounts: [] }] },
        status: {
          phase: "Running",
          startTime: "2026-10-08T00:00:00Z",
          containerStatuses: [{ restartCount: 2, state: { running: { startedAt: "2026-10-08T00:01:00Z" } } }]
        }
      }]
    }
  });
  const [inspect] = await kubeRuntime.inspectContainers(settings, ["radarr"]);

  assert.equal(inspect.Name, "/radarr");
  assert.equal(inspect.State.Running, true);
  assert.equal(inspect.RestartCount, 2);
  // Addressed by Service name, which is what cluster DNS resolves — and which
  // happens to be the same address shape a shared Docker network produces.
  assert.deepEqual(inspect.NetworkSettings.Networks.keelarr.Aliases, ["radarr"]);
  assert.deepEqual(inspect.Config.ExposedPorts, { "7878/tcp": {} });
});

test("a pod for an app that was not asked about is not returned", async () => {
  const { settings } = await kubeHarness({
    pods: {
      items: [{
        metadata: { labels: { "app.kubernetes.io/name": "sonarr" } },
        spec: { containers: [{ image: "x", ports: [], env: [], volumeMounts: [] }] },
        status: { phase: "Running", containerStatuses: [{}] }
      }]
    }
  });

  assert.deepEqual(await kubeRuntime.inspectContainers(settings, ["radarr"]), []);
});

test("reading a config file goes through the deployment, not a pod name", async () => {
  // Pod names carry a replica hash that changes on every rollout.
  const { settings, log } = await kubeHarness({ execOutput: "<Config><ApiKey>abc</ApiKey></Config>" });
  const text = await kubeRuntime.readContainerFile(settings, "radarr", "/config/config.xml");

  assert.match(text, /ApiKey/);
  assert.match((await log())[0], /exec deployment\/radarr -- cat \/config\/config\.xml/);
});

test("a missing file reads as absent rather than as an error", async () => {
  const { settings } = await kubeHarness({ failCommand: "exec" });

  assert.equal(await kubeRuntime.readContainerFile(settings, "radarr", "/config/config.xml"), null);
});

// --- what it refuses, and why that is the point ---

test("update checking says it does not know rather than guessing", async () => {
  const result = await kubeRuntime.checkForUpdates(SETTINGS, radarr());

  assert.equal(result.ok, false);
  assert.equal(result.status, "unknown");
  assert.match(result.reason, /cannot see what a registry holds/);
});

test("the Docker-only flows refuse with a reason instead of pretending", async () => {
  for (const name of ["renameContainer", "tagImage", "runDetachedContainer", "pullImage", "removeImage"]) {
    const result = await kubeRuntime[name](SETTINGS, "radarr");
    assert.equal(result.ok, false, `${name} should refuse`);
    assert.ok(result.reason.length > 20, `${name} should say why`);
  }
});

test("a snapshot is refused rather than silently skipped, because rollback depends on it", async () => {
  const result = await kubeRuntime.snapshotConfig(SETTINGS, radarr(), "/tmp");

  assert.equal(result.ok, false);
  // The consequence is the part that matters: an upgrade here is not reversible
  // the way it is on Docker, and that must not be discovered during a rollback.
  assert.match(result.reason, /rollback can restore the image but not the database/);
});

test("the shared network is already true inside a namespace", async () => {
  const result = await kubeRuntime.ensureSharedNetwork(SETTINGS, "keelarr");

  assert.equal(result.ok, true);
  assert.equal(result.created, false);
});


// --- wiring, on cluster shapes ---

/** A pod as `kubeRuntime.inspectContainers` reports it. */
function podInspect(id, port) {
  return {
    Name: `/${id}`,
    State: { Running: true, Status: "running", StartedAt: "2026-10-01T00:00:00Z", Health: null },
    RestartCount: 0,
    HostConfig: { NetworkMode: "keelarr", RestartPolicy: { Name: "unless-stopped" } },
    Config: { Image: "x", Labels: {}, ExposedPorts: { [`${port}/tcp`]: {} }, Env: [] },
    NetworkSettings: { Networks: { keelarr: { IPAddress: "", Aliases: [id] } }, Ports: {} },
    Mounts: []
  };
}

const clusterEndpoint = (id, port, drivers) =>
  buildEndpoint({
    serviceId: id,
    name: id,
    containerName: id,
    fallbackPort: port,
    inspect: podInspect(id, port),
    networkDrivers: drivers
  });

test("a namespace answers its own network drivers without shelling out", async () => {
  const drivers = await kubeRuntime.readNetworkDrivers(SETTINGS, ["keelarr", "keelarr"]);

  // Nothing in a namespace is macvlan-shaped, and every app reaches every other
  // by Service name — which is what an ordinary bridge means to the resolver.
  assert.deepEqual([...drivers.entries()], [["keelarr", "bridge"]]);
});

test("an app in the cluster is addressed by Service name, through cluster DNS", async () => {
  const drivers = await kubeRuntime.readNetworkDrivers(SETTINGS, ["keelarr"]);
  const link = resolveLink(clusterEndpoint("keelarr", 4687, drivers), clusterEndpoint("radarr", 7878, drivers), {
    hostAddress: null
  });

  assert.equal(link.ok, true);
  assert.equal(link.baseUrl, "http://radarr:7878");
});

test("addressing survives a driver lookup that answered nothing", () => {
  // The honest worst case: driving a cluster from a machine with no Docker, so
  // a Docker-shaped probe would return an empty map. An unknown driver has to
  // degrade to an ordinary bridge rather than blocking the link.
  const link = resolveLink(
    clusterEndpoint("keelarr", 4687, new Map()),
    clusterEndpoint("radarr", 7878, new Map()),
    { hostAddress: null }
  );

  assert.equal(link.ok, true);
  assert.equal(link.baseUrl, "http://radarr:7878");
});

test("there is nothing for the controller to attach to in a namespace", async () => {
  const result = await kubeRuntime.attachController(SETTINGS, [{ network: "keelarr" }]);

  assert.deepEqual(result, { attached: [], skipped: [] });
});
