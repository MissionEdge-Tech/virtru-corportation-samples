import asyncio
import time
import uuid
import psycopg2
import httpx
from shapely.geometry import Point
import random
import math

# Run attached requirements.txt to install dependencies.
# pip install -r requirements.txt

# Credit:
# Using the The OpenSky Network, https://opensky-network.org for the Live Data
# Api guide: https://openskynetwork.github.io/opensky-api/
# This script uses the REST API via HTTPX instead of the python_opensky library

# --- Configs ---
DB_NAME = "postgres"
DB_USER = "postgres"
DB_PASSWORD = "changeme"
DB_HOST = "localhost"
DB_PORT = 15432
TABLE_NAME = "tdf_objects"

# OpenSky Network API credentials
OS_USER = "AddYourCreds"
OS_PASS = "AddYourPass"

# OpenSky REST API Endpoint
BASE_URL = "https://opensky-network.org/api/states/all"

# Script parameters
NUM_ENTITIES = 50
# UPDATED: 5 updates per second for smoother animation
UPDATE_INTERVAL_SECONDS = 0.2  

# Bounding box to limit querying for credit savings
# Format: lamin, lomin, lamax, lomax
BOUNDING_BOX = {
    'lamin': -55.0,
    'lomin': -160.0,
    'lamax': 55.0,
    'lomax': 160.0
}

# --- Track UUID:ICAO24 Associations ---
# Map the DB UUID to flight ICAO24 addresses from OpenSky to track database entry to live plane
UUID_TO_FLIGHT = {}

FAKE_FLIGHT_POSITIONS = {}

# --- Navigation Math Helpers ---

def calculate_initial_compass_bearing(pointA, pointB):
    """
    Calculates the bearing between two points.
    """
    if (type(pointA) != tuple) or (type(pointB) != tuple):
        raise TypeError("Only tuples are supported as arguments")

    lat1 = math.radians(pointA[0])
    lat2 = math.radians(pointB[0])
    diffLong = math.radians(pointB[1] - pointA[1])

    x = math.sin(diffLong) * math.cos(lat2)
    y = math.cos(lat1) * math.sin(lat2) - (math.sin(lat1) * math.cos(lat2) * math.cos(diffLong))

    initial_bearing = math.atan2(x, y)
    initial_bearing = math.degrees(initial_bearing)
    compass_bearing = (initial_bearing + 360) % 360
    return compass_bearing

def get_next_point(lat, lon, bearing, distance_km):
    """
    Moves a point (lat/lon) a certain distance (km) along a bearing.
    """
    R = 6378.1 # Radius of the Earth in km
    
    brng = math.radians(bearing)
    lat1 = math.radians(lat)
    lon1 = math.radians(lon)

    lat2 = math.asin( math.sin(lat1)*math.cos(distance_km/R) +
                      math.cos(lat1)*math.sin(distance_km/R)*math.cos(brng))

    lon2 = lon1 + math.atan2(math.sin(brng)*math.sin(distance_km/R)*math.cos(lat1),
                             math.cos(distance_km/R)-math.sin(lat1)*math.sin(lat2))

    return (math.degrees(lat2), math.degrees(lon2))

def get_distance_km(lat1, lon1, lat2, lon2):
    """
    Haversine distance approximation to check if we reached the target.
    """
    R = 6371  # km
    dLat = math.radians(lat2 - lat1)
    dLon = math.radians(lon2 - lon1)
    a = math.sin(dLat / 2) * math.sin(dLat / 2) + \
        math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * \
        math.sin(dLon / 2) * math.sin(dLon / 2)
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return R * c

# --- Simulation Logic ---

async def fake_initialize_associations(uuids):
    """
    Initializes planes with a Start Position, a Destination, and High Speed.
    """
    if not uuids:
        print("No UUIDs to associate. Exiting initialization.")
        return

    lamin, lomin = BOUNDING_BOX['lamin'], BOUNDING_BOX['lomin']
    lamax, lomax = BOUNDING_BOX['lamax'], BOUNDING_BOX['lomax']

    for i, uuid_obj in enumerate(uuids):
        icao24 = f"FAKE{i:03d}"
        
        # 1. Start Position
        start_lat = random.uniform(lamin, lamax)
        start_lon = random.uniform(lomin, lomax)
        
        # 2. Target Destination
        target_lat = random.uniform(lamin, lamax)
        target_lon = random.uniform(lomin, lomax)

        # 3. Speed (km per tick)
        # UPDATED: Multiplied by 80 to account for 0.2s tick rate and "fast" visual movement.
        speed = random.uniform(2.0, 5.0) * 20

        # 4. Initial Heading (Random)
        heading = random.uniform(0, 360)

        UUID_TO_FLIGHT[uuid_obj] = icao24
        FAKE_FLIGHT_POSITIONS[icao24] = {
            "lat": start_lat,
            "lon": start_lon,
            "heading": heading,
            "speed": speed,
            "target_lat": target_lat,
            "target_lon": target_lon
        }

    print(f"Successfully initialized {len(UUID_TO_FLIGHT)} fake flight associations.")

async def fake_update_data(conn_params):
    """
    Updates plane positions using smooth turning logic towards destinations.
    """
    if not UUID_TO_FLIGHT:
        print("No UUIDs are associated with flights.")
        return

    updates = []
    
    # Physics Constants
    # UPDATED: Increased turn rate (15 deg) so they don't circle forever at high speeds
    MAX_TURN_RATE = 5.0 
    # UPDATED: Increased threshold (150km) so they hit the target easier at Mach 10
    ARRIVAL_THRESHOLD_KM = 80.0 
    
    lamin, lomin = BOUNDING_BOX['lamin'], BOUNDING_BOX['lomin']
    lamax, lomax = BOUNDING_BOX['lamax'], BOUNDING_BOX['lomax']

    for uuid_obj, icao24 in UUID_TO_FLIGHT.items():
        plane = FAKE_FLIGHT_POSITIONS.get(icao24)
        if not plane:
            continue

        # --- 1. Check Arrival ---
        dist = get_distance_km(plane["lat"], plane["lon"], plane["target_lat"], plane["target_lon"])
        
        if dist < ARRIVAL_THRESHOLD_KM:
            # Re-roll destination
            plane["target_lat"] = random.uniform(lamin, lamax)
            plane["target_lon"] = random.uniform(lomin, lomax)
        
        # --- 2. Calculate Steering ---
        target_bearing = calculate_initial_compass_bearing(
            (plane["lat"], plane["lon"]), 
            (plane["target_lat"], plane["target_lon"])
        )

        # Calculate smallest turn angle
        diff = target_bearing - plane["heading"]
        if diff > 180: diff -= 360
        if diff < -180: diff += 360

        # Limit the turn (smooth curve)
        turn = max(-MAX_TURN_RATE, min(MAX_TURN_RATE, diff))
        plane["heading"] = (plane["heading"] + turn) % 360

        # --- 3. Move ---
        new_lat, new_lon = get_next_point(plane["lat"], plane["lon"], plane["heading"], plane["speed"])

        # Update Memory
        plane["lat"] = new_lat
        plane["lon"] = new_lon

        # Prepare DB Update
        geos_wkb = lat_lon_to_wkb(new_lat, new_lon)
        updates.append((geos_wkb, uuid_obj))

    # --- 4. Commit to DB ---
    if not updates:
        return

    conn = None
    try:
        conn = psycopg2.connect(**conn_params)
        cursor = conn.cursor()

        update_query = f"""
        UPDATE {TABLE_NAME} AS t
        SET
            geo = ST_SetSRID(ST_GeomFromWKB(src.wkb_geos), 4326)
        FROM
            (SELECT unnest(%s) as wkb_geos, unnest(%s) as entity_uuid) AS src
        WHERE
            t.id = src.entity_uuid::uuid;
        """

        wkb_list = [item[0] for item in updates]
        uuid_list = [item[1] for item in updates]

        cursor.execute(update_query, (wkb_list, uuid_list))
        conn.commit()
        # print(f"Updated {cursor.rowcount} records.")

    except Exception as e:
        print(f"Database update failed: {e}")
        if conn:
            conn.rollback()
    finally:
        if conn:
            conn.close()

# --- Helper Functions ---
def get_db_uuids(conn_params, num_entities):
    """Fetches a set of UUIDs from the database to be tracked."""
    conn = None
    uuids = []
    try:
        conn = psycopg2.connect(**conn_params)
        cursor = conn.cursor()
        # Fetch the UUIDs
        cursor.execute(f"SELECT id FROM {TABLE_NAME} WHERE src_type = 'vehicles' LIMIT %s;", (num_entities,))
        uuids = [row[0] for row in cursor.fetchall()]
        print(f"Found {len(uuids)} UUIDs for tracking.")
    except Exception as e:
        print(f"Database error: {e}")
    finally:
        if conn:
            conn.close()

    # Warning if not enough are found.
    if len(uuids) < num_entities:
         print(f"WARNING: Not enough UUIDs in the database. Please ensure your table has at least {num_entities} 'vehicles' entries.")
         return

    return uuids


def lat_lon_to_wkb(latitude, longitude):
    """ Converts a latitude and longitude into expected WKB """
    if latitude is not None and longitude is not None:
        point = Point(longitude, latitude)
        # Convert to WKB and return as a byte string for psycopg2
        return point.wkb
    return None

# --- REST API Data Structures ---
class StateVector:
    def __init__(self, data):
        self.icao24 = data[0]
        # data[5] is longitude, data[6] is latitude
        self.longitude = data[5]
        self.latitude = data[6]

async def main():
    print("Starting Live Data Updater...")

    # Connection parameters
    conn_params = {
        "dbname": DB_NAME,
        "user": DB_USER,
        "password": DB_PASSWORD,
        "host": DB_HOST,
        "port": DB_PORT
    }

    # Initialize API and Fetch UUIDs
    async with httpx.AsyncClient(auth=(OS_USER, OS_PASS), timeout=30.0) as client:
        uuids_to_track = get_db_uuids(conn_params, NUM_ENTITIES)

        # Makes associations
        await fake_initialize_associations(uuids_to_track)

        if not UUID_TO_FLIGHT:
            print("Initial association failed. Cannot start update loop.")
            return

        # Start the continuous update loop
        print("\n--- Starting Live Update Loop ---")
        try:
            while True:
                start_time = time.time()
                # print(f"\n[{time.strftime('%Y-%m-%d %H:%M:%S', time.localtime())}] Fetching and updating data...")

                await fake_update_data(conn_params)

                # Wait
                elapsed = time.time() - start_time
                wait_time = max(0, UPDATE_INTERVAL_SECONDS - elapsed)
                
                # print(f"Cycle completed in {elapsed:.2f}s. Waiting for {wait_time:.2f}s...")
                time.sleep(wait_time)

        except KeyboardInterrupt:
            print("\nScript Terminated. Bye Bye!")
        except Exception as e:
            print(f"\nFatal error: {e}")

if __name__ == "__main__":
    asyncio.run(main())