FROM mcr.microsoft.com/playwright:v1.60.0-noble

# Playwright image already has Node.js, browser system dependencies, fonts,
# sandbox configuration, and user 'ubuntu' (UID 1000).

RUN npm install -g @playwright/cli@latest \
    && playwright-cli install-browser chromium

RUN apt-get update && apt-get install -y --no-install-recommends sudo \
    && echo "ubuntu ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers.d/ubuntu \
    && rm -rf /var/lib/apt/lists/*
