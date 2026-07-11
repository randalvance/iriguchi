# syntax=docker/dockerfile:1
#
# Custom devcontainer image for iriguchi.
# Base: Debian 12 (bookworm) slim — the standard base for VS Code devcontainers.
# Ships: latest Node.js + npm, latest Python (built from source), and Claude Code.
#
FROM debian:bookworm-slim

# --- Build-time configuration (bump these to upgrade) -------------------------
# Node.js major version installed from the NodeSource apt repo.
ARG NODE_MAJOR=24
# Python version built from source (must be a real python.org release tag).
ARG PYTHON_VERSION=3.14.0
# Non-root user created for the devcontainer.
ARG USERNAME=vscode
ARG USER_UID=1000
ARG USER_GID=${USER_UID}

# Never prompt during apt operations in an image build.
ENV DEBIAN_FRONTEND=noninteractive

# --- Base system packages, locale, and a non-root sudo user -------------------
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        wget \
        git \
        gnupg \
        sudo \
        less \
        locales \
        openssh-client \
        # toolchain + headers needed to build CPython from source
        build-essential \
        pkg-config \
        zlib1g-dev \
        libssl-dev \
        libffi-dev \
        libsqlite3-dev \
        libbz2-dev \
        libreadline-dev \
        libncurses-dev \
        liblzma-dev \
        libgdbm-dev \
        uuid-dev \
        tk-dev \
    && rm -rf /var/lib/apt/lists/* \
    # generate a UTF-8 locale
    && sed -i 's/# en_US.UTF-8/en_US.UTF-8/' /etc/locale.gen \
    && locale-gen \
    # create the non-root user with passwordless sudo
    && groupadd --gid ${USER_GID} ${USERNAME} \
    && useradd --uid ${USER_UID} --gid ${USER_GID} -m -s /bin/bash ${USERNAME} \
    && echo "${USERNAME} ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/${USERNAME} \
    && chmod 0440 /etc/sudoers.d/${USERNAME}

ENV LANG=en_US.UTF-8 \
    LC_ALL=en_US.UTF-8

# --- Python (latest) built from source ---------------------------------------
# Debian's apt only carries Python 3.11, so build the requested version from the
# official python.org source tarball and expose it as python / python3 / pip.
RUN set -eux; \
    curl -fsSL "https://www.python.org/ftp/python/${PYTHON_VERSION}/Python-${PYTHON_VERSION}.tgz" -o /tmp/python.tgz; \
    mkdir -p /tmp/python-src; \
    tar -xzf /tmp/python.tgz -C /tmp/python-src --strip-components=1; \
    cd /tmp/python-src; \
    ./configure --prefix=/usr/local --with-ensurepip=install --enable-loadable-sqlite-extensions; \
    make -j"$(nproc)"; \
    make altinstall; \
    cd /; \
    rm -rf /tmp/python-src /tmp/python.tgz; \
    PY_MINOR="${PYTHON_VERSION%.*}"; \
    ln -sf "/usr/local/bin/python${PY_MINOR}" /usr/local/bin/python3; \
    ln -sf "/usr/local/bin/python${PY_MINOR}" /usr/local/bin/python; \
    ln -sf "/usr/local/bin/pip${PY_MINOR}" /usr/local/bin/pip3; \
    ln -sf "/usr/local/bin/pip${PY_MINOR}" /usr/local/bin/pip; \
    python3 --version; \
    pip3 --version; \
    python3 -m pip install --no-cache-dir --upgrade pip

# --- Node.js (latest) + npm + Claude Code ------------------------------------
RUN set -eux; \
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -; \
    apt-get install -y --no-install-recommends nodejs; \
    rm -rf /var/lib/apt/lists/*; \
    npm install -g npm@latest; \
    npm install -g @anthropic-ai/claude-code; \
    node --version; \
    npm --version; \
    claude --version

# --- Runtime user -------------------------------------------------------------
USER ${USERNAME}
WORKDIR /workspaces/iriguchi

CMD ["bash"]
