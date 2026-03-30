# Trino-Proxy
Trino Proxy connector plugins add TDF encryption and enforce attribute-based access control (ABAC) on various data sources. See [docs](./docs) for details of each plugin, including configuration instructions.

### Contributing
This repository uses [pre-commit](https://pre-commit.com/) hooks for code consistency. Set up `pre-commit` as described in the linked docs before contributing to this codebase.

The `google-java-format` `pre-commit` hook reformats any staged Java code in the `plugin` directory before commit. The developer must re-stage reformatted files. A github action will fail any PRs that did not invoke the `pre-commit` hook. See [google-java-format](https://github.com/google/google-java-format) docs for configuring IDEs to adjust formatting on save, if desired.

The maven `sortpom` plugin is also activated. If you get a sort error during a build, run `make sort-pom`

 ### Building tdf-trino Image
Build tests use [Testcontainers for Java](https://java.testcontainers.org/), including its compose functionality. Running `trino-proxy` tests requires some setup depending on your environment:
* [See Using Colima](https://golang.testcontainers.org/system_requirements/using_colima/)
* Set:
  * `DOCKER_HOST` = the value of `docker context ls` = `unix://$HOME/.colima/default/docker.sock`
  * `TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock`
  * `make` targets set these for you
* When running Colima:  `colima start --network-address`
* `make` target options
  * `make build` - cleans, builds plugins, runs unit tests, skips BDD tests
  * `make image` - invokes `make build` then builds `tdf-trino` image
  * `make bdd` - runs BDD tests without remaking image (use this if you only changed `plugin/bdd-tests` and not other plugin code)
    * you can use the `TAGS` variable to only run certain scenarios - example: `TAGS="@tdf-postgresql and @access-modes" make bdd`
  * `make all` - invokes `make image` then runs BDD tests
* when running BDD tests, you must set `TRINO_IMAGE_NAME` and `TRINO_IMAGE_TAG` environment variables with the image you want to test against

Set `DOCKER_AUTH_CONFIG` environment variable for tests to run. The tests leverage a platform/keycloak docker compose stack where the inner containers need to pull from the corporate docker registry. Setting this variable will ensure your creds are passed to the inner containers.
```shell
# Get GCP access token
GCP_ACCESS_TOKEN=$(gcloud auth print-access-token)
# Create base64 encoded auth string using printf (more portable than echo -n)
BASE64_AUTH_JSON=$(printf "oauth2accesstoken:%s" "$GCP_ACCESS_TOKEN" | base64)
# Remove any newlines from base64 output (macOS base64 may add them)
BASE64_AUTH_JSON=$(echo "$BASE64_AUTH_JSON" | tr -d '\n')
# Export DOCKER_AUTH_CONFIG
export DOCKER_AUTH_CONFIG="{\"auths\":{\"us-docker.pkg.dev\":{\"auth\":\"${BASE64_AUTH_JSON}\"}}}"
```

Add the following to `/etc/hosts` for tests to run.
```shell
127.0.0.1    trino-keycloak.virtru.com
127.0.0.1    trino-platform.virtru.com
```

### Local Testing
#### Configurations
Highly recommended using default OpenTDF's Platform Configuration.
* Update TDF Connnector Config: Located in `etc/catalog/tdf_<connector>.properties`
  * Update Platform, Keycloak and Client ID/Secret verify token exchange and `getEntitlements`
* Update TDF Header Authentication: Located in `etc/header-authenticator.properties`
  * Update Keycloak Realm URL to validate JWT.

#### Deploying Local Trino
Deploy with a jvm setting (`/etc/jvm.config`) to enable remote debugging.  This should only be used for local debugging.

```shell
-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=*:5005
```

### Data Clean Room QuickStart

#### Build Image

The upstream docker image is in Google Artifact Registry.  This requires gcloud auth:

```shell
gcloud auth login
```

```shell
gcloud auth print-access-token | docker login -u oauth2accesstoken --password-stdin https://us-docker.pkg.dev
```

Build Image using Maven and Docker. Github Credentials as Environmental Variables are required: `GITHUB_USER` and `GITHUB_PASSWORD`.

```
make image
```

#### Deploy Trino Server with PostgreSQL in DCR
This will deploy the TDF Trino Server in DCR. Ensure `dcrctl` installed.
TDF Trino will be available at `http://trino.virtru.internal:80`.
```
make dcr-server-deploy
```

#### Deploy E2E Trino Test Job
To deploy a E2E Test Trino Job, run this make command.
```
make dcr-test-deploy
```

When the pod has initialized, you can exec in.
```
kubectl logs -n dcr-compute jobs/dcr-trino-test -f
```

### Local Development Server Debugging Setup

The local_config uses the trino `plugin.bundles` property to use the local plugin pom.xml plus links to plugins 
downloaded from a trino install (download and install below)

Download installation and unzip
```shell
trino_version=476
curl -O https://repo1.maven.org/maven2/io/trino/trino-server/$trino_version/trino-server-$trino_version.tar.gz
tar -zxvf trino-server-$trino_version.tar.gz
```