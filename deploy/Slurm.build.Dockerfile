# Build only. Does not install or activate a host scheduler.
FROM ubuntu:22.04
ARG SLURM_VERSION=26.05.4
ARG SLURM_SHA256=035f4b193d4de979ba5381beca206a50b6b886b2793b06f68a1ce7e67022b06a
ENV DEBIAN_FRONTEND=noninteractive
ARG UBUNTU_MIRROR=http://archive.ubuntu.com/ubuntu
ARG APT_PROXY=DIRECT
RUN sed -i "s|http://archive.ubuntu.com/ubuntu|${UBUNTU_MIRROR}|g; s|http://security.ubuntu.com/ubuntu|${UBUNTU_MIRROR}|g" /etc/apt/sources.list && \
    apt-get -o Acquire::http::Proxy="${APT_PROXY}" -o Acquire::Retries=2 update && \
    apt-get -o Acquire::http::Proxy="${APT_PROXY}" -o Acquire::Retries=2 install -y --no-install-recommends \
    ca-certificates curl build-essential pkg-config bzip2 \
    libmunge-dev libhwloc-dev libdbus-1-dev libssl-dev libjson-c-dev \
    libmariadb-dev libpam0g-dev libsystemd-dev libyaml-dev libjwt-dev \
    libbpf-dev libhttp-parser-dev && rm -rf /var/lib/apt/lists/*
WORKDIR /build
RUN curl --fail --location --retry 2 --max-time 180 \
      "https://download.schedmd.com/slurm/slurm-${SLURM_VERSION}.tar.bz2" -o slurm.tar.bz2 && \
    echo "${SLURM_SHA256}  slurm.tar.bz2" | sha256sum --check --strict && \
    tar -xjf slurm.tar.bz2 && \
    cd "slurm-${SLURM_VERSION}" && \
    ./configure --prefix="/opt/gpuq-slurm/${SLURM_VERSION}" \
      --sysconfdir=/etc/gpuq-slurm --with-munge --enable-slurmrestd && \
    make -j4 && make DESTDIR=/artifact install && \
    test -f "/artifact/opt/gpuq-slurm/${SLURM_VERSION}/lib/slurm/cgroup_v2.so"
