import YAML from "yaml";

import { getServiceDefinition } from "../service-catalog.js";

/**
 * Kubernetes/OKD manifests for a catalog service.
 *
 * The Compose generator's counterpart, and deliberately the same shape of
 * promise: these are files on disk that the operator owns, can read, can edit,
 * can `oc apply` by hand, and can commit. Keelarr holds no hidden description
 * of the cluster — the manifests are the state, exactly as the Compose files are.
 */

export const MANAGED_BY = "keelarr";

/** One label set, used for the selector, the pods, and for finding things later. */
export function labelsFor(serviceId) {
  return {
    "app.kubernetes.io/name": serviceId,
    "app.kubernetes.io/managed-by": MANAGED_BY
  };
}

export function configClaimName(serviceId) {
  return `${serviceId}-config`;
}

/**
 * The config volume: one claim per app, created by Keelarr.
 *
 * ReadWriteOnce because exactly one pod ever writes it, and because these apps
 * keep a SQLite database in there — a claim two pods could mount is a database
 * two processes could corrupt. That constraint is also why the Deployment below
 * cannot roll.
 */
export function buildConfigClaim(settings, service) {
  return {
    apiVersion: "v1",
    kind: "PersistentVolumeClaim",
    metadata: {
      name: configClaimName(service.id),
      namespace: settings.kubeNamespace,
      labels: labelsFor(service.id)
    },
    spec: {
      accessModes: ["ReadWriteOnce"],
      resources: { requests: { storage: settings.kubeConfigSize || "5Gi" } },
      // Omitted rather than guessed when unset, so the cluster's default
      // StorageClass applies. Naming one that does not exist leaves the claim
      // Pending forever with no obvious cause.
      ...(settings.kubeStorageClass ? { storageClassName: settings.kubeStorageClass } : {})
    }
  };
}

/**
 * How the pod runs as the stack's identity.
 *
 * This is the OKD-specific part, and the one that needs something from the
 * cluster administrator. OKD's default `restricted-v2` SCC assigns an arbitrary
 * UID from the namespace's range and ignores what a manifest asks for, which
 * would leave each app writing the shared library as a different user — the
 * exact failure the single PUID/PGID rule exists to prevent.
 *
 * So Keelarr asks for the identity it needs and expects the namespace's
 * ServiceAccount to hold `anyuid`. When it does not, the pod is rejected at
 * admission with a clear message, which is the right way to fail: loudly, before
 * anything runs, rather than quietly with half a stack unable to read the other
 * half's files.
 */
export function buildSecurityContext(settings) {
  const uid = Number(settings.puid);
  const gid = Number(settings.pgid);

  return {
    runAsUser: uid,
    runAsGroup: gid,
    // fsGroup is what makes a freshly provisioned volume group-writable by the
    // pod. Without it a new PVC arrives owned by root and the app cannot write
    // its own database on first start.
    fsGroup: gid,
    supplementalGroups: [gid]
  };
}

/** The env the image reads, taken from the same catalog definition Compose uses. */
export function buildEnv(settings, service) {
  const definition = getServiceDefinition(service.id);
  const resolved = {
    PUID: String(settings.puid),
    PGID: String(settings.pgid),
    TZ: settings.tz,
    PORT: String(service.port),
    CONFIG_DIR: definition?.configMount || "/config",
    MEDIA_DIR: "/Media"
  };

  return Object.entries(definition?.buildEnvironment?.(service) || {}).map(([name, raw]) => ({
    name,
    // Compose resolves ${VAR} from the .env file beside it. There is no such
    // file here, so the same references are resolved before they are written —
    // a manifest carrying a literal "${PUID}" would reach the container as
    // those eight characters.
    value: String(raw).replace(/\$\{([A-Z_]+)\}/g, (match, key) =>
      Object.hasOwn(resolved, key) ? resolved[key] : match
    )
  }));
}

export function buildDeployment(settings, service) {
  const definition = getServiceDefinition(service.id);
  const labels = labelsFor(service.id);
  const volumeMounts = [];
  const volumes = [];

  if (service.volumes.includes("config")) {
    volumeMounts.push({ name: "config", mountPath: definition?.configMount || "/config" });
    volumes.push({ name: "config", persistentVolumeClaim: { claimName: configClaimName(service.id) } });
  }

  if (service.volumes.includes("media")) {
    volumeMounts.push({ name: "media", mountPath: "/Media" });
    // The operator's own claim, never created here. The media library is shared
    // by every app in the stack, so it has to be ReadWriteMany and it long
    // outlives any one of them — the same reason mediaRoot is a path Keelarr is
    // given rather than one it makes.
    volumes.push({ name: "media", persistentVolumeClaim: { claimName: settings.kubeMediaClaim } });
  }

  return {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { name: service.id, namespace: settings.kubeNamespace, labels },
    spec: {
      replicas: 1,
      selector: { matchLabels: labels },
      // Recreate, never RollingUpdate. A rolling update starts the new pod
      // before stopping the old one, and these apps keep a SQLite database on a
      // ReadWriteOnce claim: the new pod either cannot mount it and hangs
      // Pending while the deployment reports progress, or — on ReadWriteMany
      // storage — mounts it successfully and two processes write one database.
      // The second outcome is silent, and it is how you lose a library.
      strategy: { type: "Recreate" },
      template: {
        metadata: { labels },
        spec: {
          securityContext: buildSecurityContext(settings),
          volumes,
          containers: [
            {
              name: service.id,
              image: service.image,
              ports: [{ containerPort: service.port, name: "http" }],
              env: buildEnv(settings, service),
              volumeMounts,
              // A TCP probe rather than an HTTP one. Every app in the catalog
              // answers on a different path, and several answer 401 before they
              // are configured — which an HTTP probe would read as unhealthy and
              // restart forever. "The port is open" is the strongest claim that
              // is true for all of them.
              readinessProbe: {
                tcpSocket: { port: service.port },
                initialDelaySeconds: 10,
                periodSeconds: 10
              },
              // Far more patient than readiness. These apps perform database
              // migrations on first start after an upgrade, and killing one
              // mid-migration is how a rollback stops being able to restore.
              livenessProbe: {
                tcpSocket: { port: service.port },
                initialDelaySeconds: 120,
                periodSeconds: 30,
                failureThreshold: 5
              }
            }
          ]
        }
      }
    }
  };
}

export function buildService(settings, service) {
  return {
    apiVersion: "v1",
    kind: "Service",
    metadata: { name: service.id, namespace: settings.kubeNamespace, labels: labelsFor(service.id) },
    spec: {
      type: "ClusterIP",
      selector: labelsFor(service.id),
      // Named rather than numbered on the target side so the Deployment can
      // change its port without this needing to agree.
      ports: [{ name: "http", port: service.port, targetPort: "http", protocol: "TCP" }]
    }
  };
}

/** The hostname an app is exposed at, or null when nothing is. */
export function hostnameFor(settings, service) {
  return settings.kubeDomain
    ? `${service.id}.${String(settings.kubeDomain).replace(/^\.+/, "")}`
    : null;
}

/**
 * An OKD Route.
 *
 * Omitted entirely rather than guessed at. A Route with no host gets one
 * assigned by the cluster, which works but produces addresses nobody can
 * predict — and these are addresses people bookmark.
 */
export function buildRoute(settings, service) {
  const host = hostnameFor(settings, service);

  if (!host) {
    return null;
  }

  return {
    apiVersion: "route.openshift.io/v1",
    kind: "Route",
    metadata: { name: service.id, namespace: settings.kubeNamespace, labels: labelsFor(service.id) },
    spec: {
      host,
      to: { kind: "Service", name: service.id, weight: 100 },
      port: { targetPort: "http" },
      // Edge termination: TLS at the router, plain HTTP inside the cluster.
      // None of these apps is configured for TLS of its own, and pretending
      // otherwise produces a Route that 503s.
      tls: { termination: "edge", insecureEdgeTerminationPolicy: "Redirect" }
    }
  };
}

/**
 * The plain-Kubernetes equivalent, for clusters that have no Routes.
 *
 * Not quite a like-for-like swap, and the difference is worth knowing: a Route
 * gets TLS from the OKD router for free, while an Ingress needs a certificate
 * named in a Secret. With none given the app is served over plain HTTP, which
 * is a real downgrade — so it is left as the operator's explicit choice rather
 * than quietly arranged.
 */
export function buildIngress(settings, service) {
  const host = hostnameFor(settings, service);

  if (!host) {
    return null;
  }

  return {
    apiVersion: "networking.k8s.io/v1",
    kind: "Ingress",
    metadata: { name: service.id, namespace: settings.kubeNamespace, labels: labelsFor(service.id) },
    spec: {
      // Omitted rather than guessed when unset, so the cluster's default
      // IngressClass applies — the same reasoning as the StorageClass above.
      ...(settings.kubeIngressClass ? { ingressClassName: settings.kubeIngressClass } : {}),
      rules: [{
        host,
        http: {
          paths: [{
            path: "/",
            // Prefix, not Exact. These apps serve their own assets from paths
            // below the root, and Exact would match the front page alone.
            pathType: "Prefix",
            backend: { service: { name: service.id, port: { name: "http" } } }
          }]
        }
      }],
      ...(settings.kubeTlsSecret
        ? { tls: [{ hosts: [host], secretName: settings.kubeTlsSecret }] }
        : {})
    }
  };
}

/**
 * How this cluster exposes an app.
 *
 * The one place the two flavours genuinely diverge in the manifests. Keeping
 * the branch here means `buildKubeManifests` does not have to care, and adding
 * a third way to expose something later is one more case rather than a change
 * everywhere.
 */
export function buildExposure(settings, service) {
  return settings.kubeFlavor === "kubernetes"
    ? buildIngress(settings, service)
    : buildRoute(settings, service);
}

/**
 * The resource kinds a flavour has, lowercased for the CLI.
 *
 * Asking a plain Kubernetes cluster to delete a `route` fails the whole command
 * with "the server doesn't have a resource type route" — so a teardown that
 * named both would never remove anything on either flavour.
 */
export function exposureKindFor(settings) {
  return settings.kubeFlavor === "kubernetes" ? "ingress" : "route";
}

/**
 * Every manifest for one service, in apply order.
 *
 * The claim is first because the Deployment will sit Pending without it, and a
 * Pending pod is a much harder thing to explain than a missing volume.
 */
export function buildKubeManifests(settings, service) {
  const documents = [
    ...(service.volumes.includes("config") ? [buildConfigClaim(settings, service)] : []),
    buildDeployment(settings, service),
    buildService(settings, service)
  ];
  const exposure = buildExposure(settings, service);

  if (exposure) {
    documents.push(exposure);
  }

  return documents;
}

/** One multi-document YAML file, which is what `oc apply -f` wants. */
export function renderKubeManifests(settings, service) {
  return buildKubeManifests(settings, service)
    .map((document) => YAML.stringify(document))
    .join("---\n");
}
