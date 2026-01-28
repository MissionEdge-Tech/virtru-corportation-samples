import os
import uuid
import json
import random
import psycopg2
import argparse
import requests
import boto3
import base64
import urllib3
from io import BytesIO
from faker import Faker
from datetime import datetime, timedelta
from psycopg2.extras import execute_batch
from otdf_python.sdk_builder import SDKBuilder
from otdf_python.config import NanoTDFConfig, KASInfo
from botocore.config import Config

# --- Suppress SSL Warnings for local dev ---
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

# --- User/Auth Configs ---
KEYCLOAK_URL = os.getenv("KEYCLOAK_URL", "https://local-dsp.virtru.com:8443/auth")
REALM = os.getenv("REALM", "opentdf")
CLIENT_ID = 'secure-object-proxy-test'
CLIENT_SECRET = 'secret'
# Fixed: Renamed to avoid 'harshil' system variable conflict
KC_USER = os.getenv("KC_USER", "top-secret-gbr-bbb") 
KC_PASS = os.getenv("PASSWORD", "testuser123")
TOKEN_URL = f"{KEYCLOAK_URL}/realms/{REALM}/protocol/openid-connect/token"

# --- DB Configs ---
DB_NAME, DB_USER, DB_PASSWORD = "postgres", "postgres", "changeme"
DB_HOST, DB_PORT = "localhost", 15432
NUM_RECORDS = 5
BATCH_SIZE = 1

# --- S4 / S3 Configs ---
S4_STS_ENDPOINT = "http://localhost:7070"
S4_S3_ENDPOINT = "http://localhost:7070" 
S4_BUCKET = "cop-demo"
S4_REGION = "us-east-1"

# --- Fixed Data for TdfObjects ---
FIXED_SRC_TYPE = 'vehicles'
FIXED_TDF_URI = None
FIXED_CREATED_BY = KC_USER

# --- DSP Configs ---
PLATFORM_ENDPOINT = "https://local-dsp.virtru.com:8080"
CA_CERT_PATH = "./dsp-keys/rootCA.pem"
ISSUER_ENDPOINT = "https://local-dsp.virtru.com:8443/auth/realms/opentdf"

CLASSIFICATIONS = ["unclassified", "confidential", "secret", "topsecret"]

# --- SQL Queries ---
DELETE_SQL = "DELETE FROM tdf_objects WHERE src_type = %s"
INSERT_SQL = """
INSERT INTO tdf_objects (
    id,
    ts,
    src_type,
    geo,
    search,
    metadata,
    tdf_blob,
    tdf_uri,
    _created_at,
    _created_by
)
VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
"""

# --- 1. Authentication & S3 Client (STS Flow) ---
def get_auth_token():
    """Fetches a JWT token using Basic Auth for the client and Password Grant for the user."""
    auth = f"{CLIENT_ID}:{CLIENT_SECRET}"
    headers = {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': 'Basic ' + base64.b64encode(auth.encode()).decode()
    }
    payload = {
        'grant_type': 'password',
        'username': KC_USER,
        'password': KC_PASS,
    }
    response = requests.post(TOKEN_URL, headers=headers, data=payload, verify=False)
    if response.status_code != 200:
        print(f"Auth Error: {response.text}")
        response.raise_for_status()
    return response.json()['access_token']


def get_s4_s3_client():
    """Exchanges JWT for temporary S3 credentials via S4 STS."""
    token = get_auth_token()
    sts_client = boto3.client('sts', endpoint_url=S4_STS_ENDPOINT, verify=False)
    
    # Exchanging JWT for temporary S3 credentials
    response = sts_client.assume_role_with_web_identity(
        RoleArn='arn:aws:iam::xxxx:xxx/xxx',
        RoleSessionName='WebIdentitySession',
        WebIdentityToken=token,
        DurationSeconds=3600 
    )
    
    creds = response['Credentials']
    return boto3.client(
        's3',
        endpoint_url=S4_S3_ENDPOINT,
        aws_access_key_id=creds['AccessKeyId'],
        aws_secret_access_key=creds['SecretAccessKey'],
        aws_session_token=creds.get('SessionToken'),
        region_name=S4_REGION,
        verify=False
    )


# --- 2. S4 / S3 Operations ---
def upload_to_s4(s3_client, filename, data_dict, attr_url):
    """Uploads data to S4 using temporary STS credentials."""
    payload = json.dumps(data_dict).encode('utf-8')
    s3_client.put_object(
        Bucket=S4_BUCKET,
        Key=filename,
        Body=payload,
        Metadata={'tdf-data-attribute-0': attr_url}
    )
    return f"s3://{S4_BUCKET}/{filename}"


# --- 3. Encryption & SDK ---
def get_sdk_instance(platform_endpoint, client_id, client_secret, ca_cert_path, issuer_endpoint):
    builder = SDKBuilder()
    builder.set_platform_endpoint(platform_endpoint)
    builder.client_secret(client_id, client_secret)
    builder.cert_paths = ca_cert_path
    builder.use_insecure_skip_verify(True)
    return builder.build()


def encrypt_data(sdk, plaintext: str, attributes: list[str]) -> bytes:
    """Encrypts a string payload using the TDF SDK."""
    target_kas_url = "https://local-dsp.virtru.com:8080/kas"
    kas_info = KASInfo(url=target_kas_url)

    config = NanoTDFConfig(
        attributes=attributes,
        ecc_mode="secp256r1",
        kas_info_list=[kas_info]
    )

    input_data_stream = BytesIO(plaintext.encode('utf-8'))
    output_stream = BytesIO()

    sdk.create_nano_tdf(
        input_data_stream,
        output_stream,
        config
    )

    return output_stream.getvalue()


# --- 4. Data Generation Helpers ---
def generate_random_point_wkb():
    """Generates a random GEO in WKB format."""
    min_lat, max_lat = 25, 45
    min_lon, max_lon = -85, -65

    lat = random.uniform(min_lat, max_lat)
    lon = random.uniform(min_lon, max_lon)

    return f'POINT({lon} {lat})'


def generate_fake_manifest(fake, record_id, classification):
    """Generates fake manifest data for a vehicle record."""
    manifest = {
        "manifestId": str(uuid.uuid4()),
        "recordId": record_id,
        "version": "1.0",
        "classification": classification,
        "createdAt": datetime.now().isoformat(),
        "source": {
            "system": fake.company(),
            "feed": random.choice(["ADS-B", "RADAR", "SATELLITE", "GROUND_STATION"]),
            "reliability": round(random.uniform(0.7, 1.0), 2)
        },
        "vehicle": {
            "registration": fake.bothify('?-#####').upper(),
            "operator": fake.company(),
            "category": random.choice(["COMMERCIAL", "MILITARY", "PRIVATE", "CARGO"]),
            "icao24": fake.hexify('^^^^^^').lower()
        },
        "route": {
            "flightNumber": fake.bothify('??####').upper(),
            "departureTime": (datetime.now() - timedelta(hours=random.randint(1, 12))).isoformat(),
            "estimatedArrival": (datetime.now() + timedelta(hours=random.randint(1, 12))).isoformat(),
            "waypoints": [
                {"lat": round(random.uniform(25, 45), 4), "lon": round(random.uniform(-85, -65), 4)}
                for _ in range(random.randint(2, 5))
            ]
        },
        "telemetry": {
            "lastUpdate": datetime.now().isoformat(),
            "positionAccuracy": round(random.uniform(1, 50), 1),
            "velocityAccuracy": round(random.uniform(0.1, 5), 2)
        },
        "processing": {
            "pipeline": f"v{random.randint(1, 3)}.{random.randint(0, 9)}.{random.randint(0, 99)}",
            "processingTime": round(random.uniform(0.01, 2.0), 3),
            "validated": random.choice([True, False])
        }
    }
    return manifest


# --- 5. Record Generation ---
def generate_tdf_records(count, sdk):
    """Generates a list of tdf_object records."""
    records = []
    fake = Faker()

    # Start date to be used for random timestamp generation
    start_date = datetime.now() - timedelta(days=30)

    # Initialize the S3 client once for this run
    try:
        print("Initializing S4 S3 client...")
        s3_client = get_s4_s3_client()
        print("S4 S3 client initialized successfully.")
    except Exception as e:
        print(f"Failed to initialize S4 client: {e}")
        return []

    print(f"Generating {count} records with manifests...")

    for i in range(count):
        # 1. Rotate Classifications (one of each)
        cls_type = CLASSIFICATIONS[i % len(CLASSIFICATIONS)]
        attr_url = f"https://demo.com/attr/classification/value/{cls_type}"

        # 2. Generate unique ID first (needed for manifest)
        random_id = str(uuid.uuid4())

        # 3. Randomize Vehicle Data
        vehicle_data = {
            "vehicleName": f"{fake.lexify('??').upper()}-{fake.numerify('###')}",
            "origin": fake.lexify('???').upper(),
            "destination": fake.lexify('???').upper(),
            "aircraft_type": random.choice(["Boeing 747", "Airbus A320", "Cessna 172", "F-35", "Global 6000"])
        }

        # Encrypt with specific classification
        tdf_blob = encrypt_data(sdk, json.dumps(vehicle_data), [attr_url])

        # Prepare search JSONB to match classification
        search_jsonb = json.dumps({
            "attrRelTo": [],
            "attrNeedToKnow": [],
            "attrClassification": [attr_url]
        })

        # 4. Generate and upload manifest to S4
        manifest_data = generate_fake_manifest(fake, random_id, cls_type)
        manifest_key = f"manifests/{random_id}.json.tdf"
        try:
            manifest_uri = upload_to_s4(s3_client, manifest_key, manifest_data, attr_url)
        except Exception as e:
            print(f"Manifest upload failed for record {i}: {e}")
            manifest_uri = None

        # 5. Prepare metadata JSONB with manifest reference
        metadata_jsonb = json.dumps({
            "callsign": fake.bothify('??-####').upper(),
            "speed": f"{random.randint(0, 900)} km/h",
            "altitude": f"{random.randint(0, 40000)} m",
            "heading": str(random.randint(0, 359)),
            "manifest": manifest_uri  # S3 URI reference to manifest
        })

        # Randomized Data Fields
        random_ts = datetime.now()
        random_geo = generate_random_point_wkb()
        random_created_at = random_ts + timedelta(seconds=random.uniform(0.01, 0.1))

        # Build the record
        record = (
            random_id,
            random_ts,
            FIXED_SRC_TYPE,
            random_geo,
            search_jsonb,
            metadata_jsonb,
            tdf_blob,
            FIXED_TDF_URI,
            random_created_at,
            FIXED_CREATED_BY
        )
        records.append(record)

        if (i + 1) % 10 == 0:
            print(f"  Generated {i + 1}/{count} records...")

    return records


# --- 6. Insert Logic ---
def insert_seed_data(sdk, should_delete: bool):
    conn = None
    records = generate_tdf_records(NUM_RECORDS, sdk)

    if not records:
        print("No records generated. Exiting.")
        return

    print(f"Attempting to insert {NUM_RECORDS} records in batches of {BATCH_SIZE}...")

    try:
        # Connection
        conn = psycopg2.connect(
            dbname=DB_NAME,
            user=DB_USER,
            password=DB_PASSWORD,
            host=DB_HOST,
            port=DB_PORT
        )
        cursor = conn.cursor()

        # --- Conditional Delete logic based on flag ---
        if should_delete:
            print(f"Flag --delete detected. Cleaning up records for src_type: {FIXED_SRC_TYPE}")
            cursor.execute(DELETE_SQL, (FIXED_SRC_TYPE,))
            print(f"Successfully deleted {cursor.rowcount} records.")

        # Batch Chunks Insert
        execute_batch(
            cursor,
            INSERT_SQL,
            records,
            page_size=BATCH_SIZE
        )

        # Commit updates
        conn.commit()
        print(f"Successfully inserted {NUM_RECORDS} records into the tdf_objects table.")

    except psycopg2.OperationalError as e:
        print(f"CONNECTION ERROR: Could not connect to the database.")
        print(f"Details: {e}")
        if conn: conn.rollback()

    except Exception as e:
        print(f"An error occurred during insertion: {e}")
        if conn: conn.rollback()

    finally:
        if conn:
            cursor.close()
            conn.close()


if __name__ == "__main__":
    # --- Argparse setup ---
    parser = argparse.ArgumentParser(description="Seed script for TDF objects.")
    parser.add_argument(
        "--delete",
        action="store_true",
        help="Delete existing records matching the FIXED_SRC_TYPE before inserting new ones."
    )
    args = parser.parse_args()

    try:
        # 1. Get TDF SDK instance
        print("Initializing TDF SDK...")
        sdk_instance = get_sdk_instance(PLATFORM_ENDPOINT, CLIENT_ID, CLIENT_SECRET, CA_CERT_PATH, ISSUER_ENDPOINT)

        # 2. Run the seed data insertion
        insert_seed_data(sdk_instance, args.delete)

    except Exception as e:
        print(f"An error occurred: {e}")
        import traceback
        traceback.print_exc()