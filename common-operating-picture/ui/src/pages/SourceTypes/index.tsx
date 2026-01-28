import { useEffect, useState, useContext, useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { LayersControl, MapContainer, TileLayer } from 'react-leaflet';
import { LatLng, Map } from 'leaflet';
import { Box, Button, Grid, IconButton, Typography, CircularProgress } from '@mui/material';
import { AddCircle, Sync as SyncIcon } from '@mui/icons-material';
import { TdfObjectResponse, useRpcClient } from '@/hooks/useRpcClient';
import { PageTitle } from '@/components/PageTitle';
import { SourceTypeProvider } from './SourceTypeProvider';
import { CreateDialog } from './CreateDialog';
import { SourceTypeSelector } from './SourceTypeSelector';
import { SearchFilter } from './SearchFilter';
import { SearchResults } from './SearchResults';
import { SrcType, TdfObject } from '@/proto/tdf_object/v1/tdf_object_pb.ts';
import { config } from '@/config';
import { TdfObjectsMapLayer } from '@/components/Map/TdfObjectsMapLayer';
import { BannerContext } from '@/contexts/BannerContext';
import { VehicleLayer } from '@/components/Map/VehicleLayer';
import { TimestampSelector } from '@/proto/tdf_object/v1/tdf_object_pb.ts';
import { Timestamp } from '@bufbuild/protobuf';
import dayjs from 'dayjs';
import CloseIcon from '@mui/icons-material/Close';
import { TdfObjectResult } from './TdfObjectResult';
import { useEntitlements } from '@/hooks/useEntitlements';

// S3/STS Integration
import { stsService } from '@/services/STSService'; 
import { S3Provider } from '@/types/s3';
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";

export interface VehicleDataItem {
  id: string;
  pos: { lat: number; lng: number };
  rawObject: TdfObject;
  data?: {
    vehicleName?: string;
    callsign?: string;
    origin?: string;
    destination?: string;
    speed?: string;
    altitude?: string;
    heading?: string;
    aircraft_type?: string;
    attrClassification?: string | string[];
    attrNeedToKnow?: string[];
    attrRelTo?: string[];
  };
}

// Ensure bucket matches your docker-compose 'cop-demo'
// Define based on environment
const isBrowser = typeof window !== 'undefined';

const STS_CONFIG: S3Provider = {
  useSts: true,
  // If the browser is calling this, use localhost. 
  // If a server-side component uses this, it must use 'minio'
  stsEndpoint: isBrowser ? 'http://localhost:7070' : 'http://minio:9000',
  roleArn: 'arn:aws:iam::123456789012:role/cop-role',
  region: 'us-east-1',
  bucket: 'cop-demo' 
};

export function SourceTypes() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [srcTypeId, setSrcTypeId] = useState<string | null>(null);
  const [selectable, setSelectable] = useState<boolean | null>();
  const [map, setMap] = useState<Map | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [srcType, setSrcType] = useState<SrcType>();
  const [vehicleData, setVehicleData] = useState<VehicleDataItem[]>([]);
  const [vehicleSrcType, setVehicleSrcType] = useState<SrcType>();
  const [poppedOutVehicle, setPoppedOutVehicle] = useState<TdfObjectResponse | null>(null);
  
  const [isSyncing, setIsSyncing] = useState(false);
  const [s3Client, setS3Client] = useState<S3Client | null>(null);

  const { getSrcType, queryTdfObjectsLight } = useRpcClient();
  const { tdfObjects, setTdfObjects, activeEntitlements } = useContext(BannerContext);
  const { categorizedData } = useEntitlements();

  const vehicleSourceTypeId = "vehicles";

  // Initialize S3 Client via STS with MinIO specifics
  useEffect(() => {
    const initS3 = async () => {
      try {
        const authDataRaw = sessionStorage.getItem('dsp:cop:user');
        if (!authDataRaw) return;
        const authData = JSON.parse(authDataRaw);
        const oidcToken = authData.idToken || authData.accessToken;
        
        if (oidcToken) {
          const creds = await stsService.assumeRoleWithWebIdentity(STS_CONFIG, oidcToken);
                setS3Client(new S3Client({
          region: STS_CONFIG.region,
          endpoint: "http://localhost:7070", 
          forcePathStyle: true,
          credentials: {
            accessKeyId: creds.accessKeyId,
            secretAccessKey: creds.secretAccessKey,
            sessionToken: creds.sessionToken,
          },
        }));
        }
      } catch (err) { 
        console.error("S3/MinIO Init Error", err); 
      }
    };
    initS3();
  }, []);

  const downloadObject = useCallback(async (key: string): Promise<any> => {
    if (!s3Client) throw new Error('S3 client not configured');
    
    const response = await s3Client.send(new GetObjectCommand({ 
        Bucket: STS_CONFIG.bucket, 
        Key: key 
    }));

    if (!response.Body) throw new Error('No data received');
    
    // Modern SDK helper for string conversion
    const bodyString = await response.Body.transformToString();
    return JSON.parse(bodyString);
  }, [s3Client]);

  const fetchVehicles = useCallback(async (id: string) => {
    try {
      const tsRange = new TimestampSelector();
      const dayjsStart = dayjs().subtract(24, 'hour');
      tsRange.greaterOrEqualTo = Timestamp.fromDate(dayjsStart.toDate());
      
      const response = await queryTdfObjectsLight({ srcType: id, tsRange: tsRange });
      const transformedData: VehicleDataItem[] = response
        .filter(o => o.geo)
        .map(o => {
          const geoJson = JSON.parse(o.geo);
          const [lng, lat] = geoJson.coordinates;
          let telemetry = {};
          try { if (o.metadata && o.metadata !== "null") telemetry = JSON.parse(o.metadata); } catch (e) {}
          let attributes = {};
          try { if (o.search && o.search !== "null") attributes = JSON.parse(o.search); } catch (e) {}
          return { id: o.id, pos: { lat, lng }, rawObject: o, data: { ...telemetry, ...attributes } };
        });
      setVehicleData(transformedData);
    } catch (error) { 
      setVehicleData([]); 
    }
  }, [queryTdfObjectsLight]);

  const handleSyncVehicleDetails = async (vehicleId: string) => {
    setIsSyncing(true);
    try {
      const authDataRaw = sessionStorage.getItem('dsp:cop:user');
      if (!authDataRaw) throw new Error("No session");
      const authData = JSON.parse(authDataRaw);
      const oidcToken = authData.idToken || authData.accessToken;
      
      const creds = await stsService.assumeRoleWithWebIdentity(STS_CONFIG, oidcToken);

      let s3Payload = null;
      try {
        s3Payload = await downloadObject(`sync-configs/${vehicleId}.json`);
        console.log("Retrieved MinIO sync configuration:", s3Payload);
      } catch (e) {
        console.warn("No sync config found in MinIO, proceeding with default.");
      }

      const response = await fetch(`/api/vehicles/${vehicleId}/sync`, { 
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Amz-Security-Token': creds.sessionToken,
          'X-Amz-Access-Key': creds.accessKeyId,
          'X-Amz-Secret-Key': creds.secretAccessKey,
        },
        body: s3Payload ? JSON.stringify({ config: s3Payload }) : undefined
      });

      if (!response.ok) throw new Error(`Backend Sync Failed: ${response.statusText}`);
      
      await fetchVehicles(vehicleSourceTypeId);
      alert("Sync Successful");
    } catch (error: any) { 
  // This unmasks the "Deserialization error"
  if (error.$response) {
    const rawBody = await error.$response.body.transformToString();
    console.error("DEBUG: Raw Server Response:", rawBody);
  }
  console.error(error);
  alert(error.message); 
} finally { 
      setIsSyncing(false); 
    }
  };

  const filteredVehicleData = useMemo(() => {
    if (!activeEntitlements || activeEntitlements.size === 0 || activeEntitlements.has("NoAccess")) {
      return vehicleData;
    }
    return vehicleData.filter(vehicle => {
      const classification = vehicle.data?.attrClassification;
      if (!classification) return true;
      const classStr = Array.isArray(classification) ? classification[0] : classification;
      return classStr ? activeEntitlements.has(classStr) : true;
    });
  }, [vehicleData, activeEntitlements]);

  const fetchSrcType = useCallback(async (id: string) => {
    try {
      const { srcType } = await getSrcType({ srcType: id });
      setSrcType(srcType);
    } catch (err) {
      setSrcType(undefined);
      setSearchParams(new URLSearchParams());
    }
  }, [getSrcType, setSearchParams]);

  const handleSrcTypeIdChange = useCallback((id: string) => {
    const newSearchParams = new URLSearchParams(searchParams);
    newSearchParams.set('type', id);
    if (id !== srcTypeId) newSearchParams.delete('q');
    setSearchParams(newSearchParams);
  }, [searchParams, srcTypeId, setSearchParams]);

  const handleDialogOpen = () => {
    const newSearchParams = new URLSearchParams(searchParams);
    newSearchParams.set('mode', 'create');
    setSearchParams(newSearchParams);
    setDialogOpen(true);
  };

  const handleDialogClose = () => {
    const newSearchParams = new URLSearchParams(searchParams);
    newSearchParams.delete('mode');
    setSearchParams(newSearchParams);
    setDialogOpen(false);
  };

  const handleFlyToClick = useCallback(({ lat, lng }: LatLng) => {
    if (map) map.flyTo({ lat, lng }, map.getZoom());
  }, [map]);

  const handleVehicleClick = useCallback((vehicle: VehicleDataItem) => {
    console.log("Selected vehicle:", vehicle);
  }, []);

  useEffect(() => {
    if (vehicleSrcType) return;
    const getVehicleSchema = async () => {
      try {
        const { srcType } = await getSrcType({ srcType: vehicleSourceTypeId });
        setVehicleSrcType(srcType);
      } catch (err) {}
    };
    getVehicleSchema();
  }, [getSrcType, vehicleSrcType]);

  useEffect(() => {
    fetchVehicles(vehicleSourceTypeId);
  }, [fetchVehicles]);

  useEffect(() => {
    const intervalId = setInterval(() => fetchVehicles(vehicleSourceTypeId), 5000);
    return () => clearInterval(intervalId);
  }, [fetchVehicles]);

  useEffect(() => {
    const type = searchParams.get('type');
    const mode = searchParams.get('mode');
    setSelectable(searchParams.get('select') !== 'false');
    if (!type) { setSrcType(undefined); setSrcTypeId(null); return; }
    if (type !== srcTypeId) {
      setSrcTypeId(type);
      setTdfObjects([]);
      fetchSrcType(type);
    }
    if (mode === 'create') setDialogOpen(true);
  }, [searchParams, fetchSrcType, srcTypeId, setTdfObjects]);

  const searchResultsTdfObjects = srcTypeId === vehicleSourceTypeId ? [] : tdfObjects; 

  return (
    <>
      <PageTitle
        title="Source Types"
        subContent={selectable ? <SourceTypeSelector value={srcTypeId} onChange={handleSrcTypeIdChange} /> : null} />
      <SourceTypeProvider srcType={srcType}>
        <Grid container spacing={3}>
          <Grid item xs={12} md={7}>
            <MapContainer style={{ width: '100%', height: '80vh' }} center={[0, 0]} zoom={3} ref={setMap}>
              <LayersControl position="topright">
                <LayersControl.BaseLayer checked name="Street">
                  <TileLayer
                    url={config.tileServerUrl || "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"}
                    attribution='&copy; OpenStreetMap contributors'
                  />
                </LayersControl.BaseLayer>
                {filteredVehicleData.length > 0 && (
                  <LayersControl.Overlay name="Vehicles" checked>
                    <VehicleLayer
                      key={`vehicles-${activeEntitlements.size}`}
                      vehicleData={filteredVehicleData}
                      onMarkerClick={handleVehicleClick}
                      onPopOut={setPoppedOutVehicle}
                    />
                  </LayersControl.Overlay>
                )}
                {tdfObjects.length > 0 && (
                  <LayersControl.Overlay name="TDF Objects" checked>
                    <TdfObjectsMapLayer tdfObjects={tdfObjects} />
                  </LayersControl.Overlay>
                )}
              </LayersControl>
            </MapContainer>
          </Grid>
          <Grid item xs={12} md={5}>
            <Box display="flex" gap={1} mb={2}>
              <SearchFilter map={map} />
              <Button variant="contained" color="primary" onClick={handleDialogOpen} startIcon={<AddCircle />}>New</Button>
            </Box>
            <SearchResults tdfObjects={searchResultsTdfObjects} onFlyToClick={handleFlyToClick} />
          </Grid>
        </Grid>
        
        <CreateDialog open={dialogOpen} onClose={handleDialogClose} />
        
        {poppedOutVehicle && (
          <Box 
            sx={{ 
              position: 'fixed', bottom: 20, right: 20, width: 400, 
              zIndex: 1000, boxShadow: 3, borderRadius: 1, overflow: 'hidden' 
            }}
          >
            <Box sx={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              p: 1, bgcolor: 'primary.main', color: 'white'
            }}>
              <Typography variant="subtitle2">Vehicle Details</Typography>
              <Box display="flex" alignItems="center">
                <Button 
                  size="small" 
                  variant="contained" 
                  color="secondary"
                  disabled={isSyncing}
                  onClick={() => handleSyncVehicleDetails(poppedOutVehicle.tdfObject.id)}
                  startIcon={isSyncing ? <CircularProgress size={14} color="inherit" /> : <SyncIcon sx={{ fontSize: 14 }} />}
                  sx={{ mr: 1, fontSize: '0.7rem', py: 0, minWidth: '90px' }}
                >
                  {isSyncing ? 'Syncing...' : 'Sync API'}
                </Button>
                <IconButton size="small" onClick={() => setPoppedOutVehicle(null)} sx={{ color: 'white' }}>
                  <CloseIcon fontSize="small" />
                </IconButton>
              </Box>
            </Box>

            <Box sx={{ p: 2, maxHeight: '60vh', overflowY: 'auto', bgcolor: 'background.paper' }}>
              <Typography variant="overline" color="textSecondary">
                System ID: {poppedOutVehicle.tdfObject.id}
              </Typography>

              <SourceTypeProvider srcType={vehicleSrcType}>
                <TdfObjectResult
                  key={poppedOutVehicle.tdfObject.id}
                  tdfObjectResponse={poppedOutVehicle}
                  categorizedData={categorizedData || {}}
                  onFlyToClick={handleFlyToClick}
                  onNotesUpdated={(objectId, notes) => console.log(objectId, notes)}
                />
              </SourceTypeProvider>
            </Box>
          </Box>
        )}
      </SourceTypeProvider>
    </>
  );
}