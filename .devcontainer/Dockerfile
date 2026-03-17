FROM ubuntu:24.04

RUN apt-get update && apt-get install -y \
    git \
    curl

# Install Node.js 22
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && \
    apt-get install -y nodejs

# Install Forge CLI
RUN npm install -g @forge/cli

RUN curl -fsSL https://claude.ai/install.sh | bash

ENV PATH="${PATH}:/root/.local/bin"