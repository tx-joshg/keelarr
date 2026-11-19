FROM node:22-alpine AS base

WORKDIR /app

RUN apk add --no-cache docker-cli docker-cli-compose

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY README.md ./README.md
COPY docs ./docs
COPY public ./public
COPY src ./src
COPY data/.gitkeep ./data/.gitkeep

ENV NODE_ENV=production \
    KEELARR_PORT=4687 \
    KEELARR_DATA_DIR=/app/data

EXPOSE 4687

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -q -O - http://127.0.0.1:4687/api/health >/dev/null 2>&1 || exit 1

CMD ["npm", "start"]

# The Kubernetes runtime's controller: the same image plus `kubectl` and `oc`.
# Not the default target and not what CI publishes — the runtime has never run
# against a cluster, and every Docker install would otherwise download two
# cluster CLIs it never uses. Build it with `docker build --target kube .`.
#
# `oc` from the OpenShift mirror is linked against glibc, hence gcompat.
FROM base AS kube
ARG TARGETARCH
ARG KUBECTL_VERSION=v1.34.2
ARG OC_CHANNEL=stable
RUN apk add --no-cache curl gcompat \
 && curl -fsSLo /usr/local/bin/kubectl "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${TARGETARCH}/kubectl" \
 && chmod +x /usr/local/bin/kubectl \
 && case "${TARGETARCH}" in arm64) OC_ARCH="-arm64" ;; *) OC_ARCH="" ;; esac \
 && curl -fsSL "https://mirror.openshift.com/pub/openshift-v4/clients/ocp/${OC_CHANNEL}/openshift-client-linux${OC_ARCH}.tar.gz" \
    | tar -xz -C /usr/local/bin oc \
 && apk del curl

# Last, so a plain `docker build .` — and CI — still produce the Docker image.
FROM base AS docker
