# Paperclip 2026.1001.0 with Pennyworth's patches (D-79). The base stays pinned by digest: update it deliberately,
# and the build fails if a patch no longer matches the code it was written for.
FROM ghcr.io/paperclipai/paperclip:2026.1001.0@sha256:08dbadebd4d40550eb336c25c3691f582322a88bae3f1cca101c5dd096bdc9d3
COPY patch.mjs /tmp/pennyworth-patch.mjs
COPY recovery-sweep.mjs /app/server/dist/services/pennyworth-recovery-sweep.mjs
RUN node /tmp/pennyworth-patch.mjs && rm /tmp/pennyworth-patch.mjs
