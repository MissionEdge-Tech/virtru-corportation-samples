#!/bin/bash
# Installs all keys for the Virtru DSP COP on Ubuntu 24.04 LTS

set -e

echo "=== Making dsp-keys/ Directory ==="
mkdir -p dsp-keys 2> /dev/null

echo "=== Installing CA Authority ==="
if ! command -v mkcert &> /dev/null
then
    echo "ERROR: mkcert is not installed."
    echo "Please ensure all prerequisites are installed. Run the ./ubuntu_cop_prereqs_cop.sh script."
    exit 1
fi
mkcert -install

echo "=== Generating Certs ==="
mkcert -cert-file dsp-keys/local-dsp.virtru.com.pem \
-key-file dsp-keys/local-dsp.virtru.com.key.pem local-dsp.virtru.com "*.local-dsp.virtru.com" localhost

# Check for OpenJDK 17
echo "=== Installing OpenJDK 17 ==="

if command -v java >/dev/null 2>&1 && java -version 2>&1 | grep -q 'version "17\.' ; then
    echo "OpenJDK 17 is already installed."
else
    echo "Installing OpenJDK 17..."
    sudo apt update
    sudo apt install openjdk-17-jdk -y
fi

# Generate keys for KAS and PolicyImportExport artifact signing
echo "=== Generating keys for KAS and PolicyImportExport artifact signing ==="
./.github/scripts/init-temp-keys.sh

# Generate temporary x509 certificates
echo "=== Generating Temporary x509 Certificates ==="
bash ./.github/scripts/x509-temp-keys.sh

# Set permissions for key files
chmod 644 dsp-keys/local-dsp.virtru.com.key.pem \
dsp-keys/local-dsp.virtru.com.pem \
dsp-keys/kas-ec-cert.pem \
dsp-keys/kas-ec-private.pem \
dsp-keys/kas-cert.pem \
dsp-keys/kas-private.pem

# ------------------------------------------------------------
# Post-install instructions
# ------------------------------------------------------------

echo "===================================="
echo "=== Key Setup Complete! ==="
echo "===================================="


