# Overview

This chart was created by Kompose from the origianl docker-compose.cop-web-server.yaml

### Prerequisites

Infrastructure that must be deployed before starting COP Web UI in Kuberenetes:
 - DSP Service
 - Keycloak
 - COP DB Configured

 Endpoints for these items must be updates in the CopCharts/values.yaml file

 # Start Up Instructions:

- Kubernetes K3s Install:
```bash
    curl -sfL https://get.k3s.io | sh -

    # To allow your user to run kubectl without sudo:
    sudo chmod 644 /etc/rancher/k3s/k3s.yaml
    export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
```
- Verify with:
```bash
kubectl get nodes
```

- Kompose Install:
```bash
    # Download the binary
    curl -L https://github.com/kubernetes/kompose/releases/download/v1.31.2/kompose-linux-amd64 -o kompose

    # Make it executable and move to path
    chmod +x kompose
    sudo mv ./kompose /usr/local/bin/kompose
```

- Verify with:
```bash
kompose version
```
- Set up local registry access
```bash
sudo nano /etc/rancher/k3s/registries.yaml

# Paste in:
mirrors:
  "localhost:5000":
    endpoint:
      - "http://localhost:5000"
```
- Restart K3s:
```bash
sudo systemctl restart k3s
```
- Creation process for the helm charts

This process may not be needed if using already existing helm charts in the repo.
```bash
# From repo root directory (common-operating-picture$)
mkdir -p CopCharts/

# Generate helm chart from docker-compose for the web server
kompose convert -f compose/docker-compose.cop-web-server.yaml -c -o CopCharts/
```
- Create config maping for Kubernetes deployment
```bash
# Mapping for config file
sudo kubectl create configmap cop-config --from-file=config.yaml=./config.yaml -n default

# Mapping for keys and certs
sudo kubectl create secret generic dsp-certs \
  --from-file=rootCA.pem=./dsp-keys/rootCA.pem \
  --from-file=dsp-cert.pem=./dsp-keys/local-dsp.virtru.com.pem \
  --from-file=dsp-key.pem=./dsp-keys/local-dsp.virtru.com.key.pem
```
- Build the COP Image for the deployment

Unlike Docker where the images can be built at run time, Kubernetes needs a prebuilt image to be supplied for the build. Here will will build the cop image and upload it into our local docker registry. To ensure that Kubernetes can pull this image, ensure the step titled "Set up local registry access" was completed with matching url to the registry planned to be used.

```bash
# From the root directory of the repo (common-operating-picture$) built image:
docker build -t localhost:5000/virtru-dsp-cop-web-server:dev \
  -f cop.Dockerfile \
  --build-arg VITE_TILE_SERVER_URL=https://tile.openstreetmap.org/{z}/{x}/{y}.png \
  --build-arg VITE_GRPC_SERVER_URL=https://local-dsp.virtru.com:5002 \
  --build-arg VITE_DSP_BASE_URL=https://local-dsp.virtru.com:8080 \
  --build-arg VITE_DSP_KAS_URL=https://local-dsp.virtru.com:8080/kas \
  --build-arg VITE_DSP_KC_SERVER_URL=https://local-dsp.virtru.com:8443/auth/realms/opentdf \
  --build-arg VITE_DSP_KC_CLIENT_ID=dsp-cop-client \
  --build-arg VITE_DSP_KC_DIRECT_AUTH=false \
  .

# Push COP image to the repository
docker push localhost:5000/virtru-dsp-cop-web-server:dev

# Verify push
docker images

# Output:
REPOSITORY                                 TAG         IMAGE ID       CREATED          SIZE
localhost:5000/virtru-dsp-cop-web-server   dev         8044d7a9428b   7 minutes ago    331MB
```

- Check and run helm charts
```bash
# Verify the Helm Charts
virtru-dsp-bundle/helm lint ./CopCharts

# If no error on previous command, start up COP Kubernetes
./virtru-dsp-bundle/helm install cop-frontend ./CopCharts

# Expected output:
NAME: cop-frontend
LAST DEPLOYED: Thu Jan 22 07:06:44 2026
NAMESPACE: default
STATUS: deployed
REVISION: 1
TEST SUITE: None

# If getting an error related to not being able to run Kube this process might fix it:
# 1. Create the .kube directory if it doesn't exist
mkdir -p ~/.kube

# 2. Copy the config and change ownership so your user can read it
sudo cp /etc/rancher/k3s/k3s.yaml ~/.kube/config
sudo chown $USER:$USER ~/.kube/config

# 3. Test it
kubectl get nodes
```

- Networking Config
```bash
# Just incase make sure no interfering firewall rules
sudo ufw allow 31777/tcp

# Check that the pod is running
kubectl get pods -w

NAME                              READY   STATUS    RESTARTS   AGE
cop-web-server-6cdfccf4cb-5f55d   1/1     Running   0          10m

# Grab Cluster-IP
kubectl get svc cop-web-server

NAME             TYPE       CLUSTER-IP     EXTERNAL-IP   PORT(S)                         AGE
cop-web-server   NodePort   10.43.147.67   <none>        5001:31234/TCP,5002:31777/TCP   10h

# Update /etc/hosts:
127.0.0.1       localhost.localdomain   localhost
::1             localhost6.localdomain6 localhost6

127.0.0.1       local-dsp.virtru.com
172.17.0.1      local-dsp.virtru.com
10.0.2.15       local-dsp.virtru.com
10.43.147.67    local-dsp.virtru.com # Cluster IP from previous command

# The following lines are desirable for IPv6 capable hosts
::1     localhost ip6-localhost ip6-loopback
fe00::0 ip6-localnet
ff02::1 ip6-allnodes
ff02::2 ip6-allrouters
ff02::3 ip6-allhosts
```


# Troubleshooting:
- Verify these are completed:
    # Create the ConfigMap for your application logic
    sudo kubectl create configmap cop-config --from-file=config.yaml=./config.yaml

    # Create the Secret for your security keys/certs
    sudo kubectl create secret generic dsp-certs \
    --from-file=rootCA.pem=./dsp-keys/rootCA.pem \
    --from-file=dsp-cert.pem=./dsp-keys/local-dsp.virtru.com.pem \
    --from-file=dsp-key.pem=./dsp-keys/local-dsp.virtru.com.key.pem

    sudo nano /etc/rancher/k3s/registries.yaml
    mirrors:
    "localhost:5000":
        endpoint:
        - "http://localhost:5000"

    sudo systemctl restart k3s

    # Update to /etc/hosts
    10.43.147.67    local-dsp.virtru.com

    With Cluster-IP from:
    kubectl get svc cop-web-server

