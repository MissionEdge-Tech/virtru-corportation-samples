# Installation Guide

Follow these steps to set up the Data Security Platform (DSP) COP environment. The instructions cover both **local development** (`local-dsp.virtru.com`) and **GCP deployment** (`cop.demo.missionedgetechnologies.com`).

### Prerequisites

Before beginning, ensure your environment meets the following requirements.

1. **Run the Setup Script**
To install necessary dependencies automatically, run the provided script:

```bash
./scripts/ops/ubuntu_cop_prereqs_cop.sh

# Reboot after running script for some changes to take effect
reboot
```

   <details>
   <summary><strong>Manual Installation Details (Optional)</strong></summary>

   If you prefer to install manually or need to debug, the script handles the following:

   - **Container Runtime:** Installs Docker + Docker Compose.
     - _Alternatives supported:_ [Colima (recommended)](https://github.com/abiosoft/colima), [Rancher Desktop](https://rancherdesktop.io), or [Podman Desktop](https://podman-desktop.io).
   - **Languages & Tools:**
     - [Node.js (via nvm)](https://nodejs.org/en/download/package-manager)
     - [Go (Golang)](https://go.dev/doc/install)
     - [GEOS](https://libgeos.org/usage/install/)
     - [Make](https://formulae.brew.sh/formula/make)
     </details>
   - **Local DNS Configuration**
     - Entry added into /etc/hosts
     - ```text
       127.0.0.1    local-dsp.virtru.com
       ```

---

### Step 1: Generate Certificates

**Local development** uses self-signed certs via mkcert. **GCP deployment** uses real certs issued for `cop.demo.missionedgetechnologies.com` — place the `.pem` and `.key.pem` files in `dsp-keys/` and skip this step.

**Option A: Script (local dev)**

```bash
./scripts/ops/ubuntu_cop_keys.sh
```

**Option B: Make Command**

```bash
# Local (default)
make dev-certs

# GCP or custom domain
make dev-certs PLATFORM_HOSTNAME=cop.demo.missionedgetechnologies.com
```

### Step 2: Unpack the Bundle

Unzip the main bundle and unpack the specific DSP tools. Replace `X.X.X`, `<os>`, and `<arch>` with your specific version and system details.

```bash
# 1. Untar the main bundle
mkdir virtru-dsp-bundle && tar -xvf virtru-dsp-bundle-* -C virtru-dsp-bundle/ && cd virtru-dsp-bundle/

# 2. Unpack DSP Tools
tar -xvf tools/dsp/data-security-platform_X.X.X_<os>_<arch>.tar.gz
  #Example - AMD linux:
  tar -xvf tools/dsp/data-security-platform_2.7.1_linux_amd64.tar.gz

# 3. Unpack and setup Helm
tar -xvf tools/helm/helm-vX.X.X-<os>-<arch>.tar.gz
  #Example - AMD linux:
  tar -xvf tools/helm/helm-v3.15.4-linux-amd64.tar.gz
# Then move command into working directory
mv <os>-<arch>/helm ./helm

# 4. Unpack and setup grpcurl
tar -xvf tools/grpcurl/grpcurl_X.X.X_<os>_<arch>.tar.gz
  #Example - AMD linux:
  tar -xvf tools/grpcurl/grpcurl_1.9.1_linux_x86_64.tar.gz

# Make Executable
chmod +x ./grpcurl
```

### Step 3: Setup Local Docker Registry

The DSP images are stored in the bundle as OCI artifacts. You must spin up a local registry and copy the images into it.

```bash
# 1. Start a local registry instance
docker run -d --restart=always -p 5000:5000 --name registry registry:2

# 2. Copy DSP images into local registry
# (Run this from the virtru-dsp-bundle root directory)
./dsp copy-images --insecure localhost:5000/virtru

# 3. Verify images were copied successfully
curl -X GET http://localhost:5000/v2/_catalog
curl -X GET http://localhost:5000/v2/virtru/data-security-platform/tags/list
```

### Step 4: Build and Run

Use Docker Compose to build and start the environment.

**Set up your environment file:**

The env files are not committed to the repo. Copy the example file for your target environment and fill in any values specific to your deployment. The key variable is `PLATFORM_HOSTNAME` — all other URLs are derived from it.

```bash
# For local development
cp env/local.env.example env/local.env

# For GCP deployment
cp env/default.env.example env/default.env
```

To deploy on a new machine/domain, just change `PLATFORM_HOSTNAME` in your env file — no other URL changes needed.

**Start the environment:**

```bash
# Local development
docker compose --env-file env/local.env -f docker-compose.dev.yaml --profile nifi --profile s4 down && \
docker compose --env-file env/local.env -f docker-compose.dev.yaml --profile nifi --profile s4 up -d --build

# GCP deployment
docker compose --env-file env/default.env -f docker-compose.dev.yaml --profile nifi --profile s4 down && \
docker compose --env-file env/default.env -f docker-compose.dev.yaml --profile nifi --profile s4 up -d --build
```

**Application URLs:**
- `https://<PLATFORM_HOSTNAME>:5001/` (e.g. `https://local-dsp.virtru.com:5001/` for local, `https://cop.demo.missionedgetechnologies.com:5001/` for GCP)

**Stop the environment:**

```bash
# Local development
docker compose --env-file env/local.env -f docker-compose.dev.yaml --profile nifi --profile s4 down

# GCP deployment
docker compose --env-file env/default.env -f docker-compose.dev.yaml --profile nifi --profile s4 down
```

### Step 5. Seeding Vehicle Data and Live Data Flow Simulation

Following the successful building of COP:

```bash
# Install the venv module
sudo apt install python3-venv -y

# Create a virtual environment named 'COP_venv' in the current directory
python3 -m venv COP_venv
```

```bash
# Activate the virtual environment.
# Your shell prompt will change to indicate it's active.
source COP_venv/bin/activate
```

```bash
# Pip install all required package from requirements.txt
pip install -r requirements.txt
```

```bash
# Run seeding script to populate database
# 50 is the standard number of objects that the script will inset but is configurable via NUM_RECORDS variable

# Local (defaults connect to cop-db:5432 and https://s4:7070 via Docker network)
python3 scripts/seed/seed_data.py

# GCP — override endpoints to reach services from the host machine
DB_HOST=localhost DB_PORT=<mapped-port> \
  S4_ENDPOINT=https://cop.demo.missionedgetechnologies.com:7070 \
  python3 scripts/seed/seed_data.py
```

```bash
# Start simulation
# NUM_ENTITIES will determine how many moving entities the script will query the database for and apply movement logic to
# UPDATE_INTERVAL_SECONDS determins the frequency of movement for each object
# BOUNDING_BOX_PARAMS define the area for the OpenSky query for live planes (smaller box results in less credits used on init).

# For live data from OpenSky Network login to https://opensky-network.org/, download credentials file (credentials.json),
# place the file in the base director (where the sim_data.py script is located) and then run:
python3 scripts/seed/sim_data.py

# For a fake simulation that does not require the credentials file or use account credits with OpenSky run this script
# for simulated movement:
python3 scripts/seed/sim_data_fake_opensky.py
```

### Troubleshooting & Verification Checklist

If you encounter issues, double-check the following:

- **Config files:** Ensure `config.yaml` (GCP) or `config.local.yaml` (local) exists in the project root. Only `platform_endpoint` needs the hostname — all other URLs (KAS, IDP, TLS certs, public hosts) are derived automatically.
- **Env files:** Ensure `env/default.env` (GCP) or `env/local.env` (local) exists — these are gitignored, copy from the `.example` files. Only `PLATFORM_HOSTNAME` needs to be set — other URLs are derived.
- **S4 config:** The S4 proxy config is generated automatically at container startup from `PLATFORM_HOSTNAME` — no separate S4 config files needed.
- **rootCA.pem:** Ensure `dsp-keys/rootCA.pem` was generated correctly during the cert setup step.
- **Permissions:** Verify that the certificates in `dsp-keys` have `chmod 755` permissions.
- **GCP Firewall:** Ensure ports 5001, 5002, 7070, 8080, and 8443 are open in the GCP firewall rules for your VM.
