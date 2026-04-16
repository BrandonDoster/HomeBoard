ARG BUILD_FROM=python:3.12-slim
FROM ${BUILD_FROM}

# The Supervisor injects BUILD_FROM at build time with the correct
# architecture-specific HA base image. The default above is used for
# local builds only (e.g. docker build . during development).

WORKDIR /app

# Install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application files
COPY main.py .
COPY static/ ./static/

# Entrypoint script sets env vars and launches the app
COPY run.sh /run.sh
RUN chmod +x /run.sh

# Add-on containers run as root — isolation is managed by the Supervisor
EXPOSE 8000

CMD ["/run.sh"]
