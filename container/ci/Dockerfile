# The image maggot Actions jobs run in on Cloudflare (`runs-on: cloudflare`), named "ci" in the
# Container's image map. Without it, jobs boot Cloudflare's managed cloudflare/debian-trixie and
# install git on every run. Node.js 24 on Debian Trixie, like the managed image, plus the tools most
# builds reach for.
FROM node:24-trixie-slim

RUN apt-get update \
	&& DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
		build-essential ca-certificates curl git jq openssh-client python3 unzip xz-utils zip \
	&& rm -rf /var/lib/apt/lists/*

WORKDIR /workspace
# Jobs start their steps with exec; the container itself only needs to stay up.
ENTRYPOINT ["sleep", "infinity"]
