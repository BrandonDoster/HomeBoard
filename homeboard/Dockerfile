ARG BUILD_FROM
FROM ${BUILD_FROM}

# The HA Supervisor injects BUILD_FROM at build time (e.g. ghcr.io/home-assistant/amd64-base-python:3.12).
# This means we get a HA-maintained Python base image for each target architecture
# automatically — we do not need to specify python:3.12-slim ourselves.

WORKDIR /app

# Install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application files
COPY main.py .
COPY static/ ./static/

# run.sh is the container entrypoint — it sets environment variables
# that the Supervisor provides (PORT via ingress, /data for persistence)
# and then starts the app.
COPY run.sh /run.sh
RUN chmod +x /run.sh

# HA add-on containers run as root by convention — the Supervisor
# manages isolation at a higher level. We do NOT create a non-root user here.

EXPOSE 8000

CMD ["/run.sh"]
