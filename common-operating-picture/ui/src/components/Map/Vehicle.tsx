import { useMemo, useState, useEffect, useRef } from "react";
import { Marker, Popup } from "react-leaflet";
import L from "leaflet";
import { 
  Typography, Box, CircularProgress, IconButton, Tooltip, Button,
  Accordion, AccordionSummary, AccordionDetails, Chip, Divider
} from "@mui/material";
import TrendingUpIcon from "@mui/icons-material/TrendingUp";
import AltRouteIcon from "@mui/icons-material/AltRoute";
import MyLocationIcon from "@mui/icons-material/MyLocation";
import GpsFixedIcon from "@mui/icons-material/GpsFixed";
import FlightIcon from '@mui/icons-material/Flight';
import SyncIcon from '@mui/icons-material/Sync';
// import BadgeIcon from '@mui/icons-material/Badge';
// import BusinessIcon from '@mui/icons-material/Business';
import LockIcon from '@mui/icons-material/Lock';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import SecurityIcon from '@mui/icons-material/Security';
import AssignmentIcon from '@mui/icons-material/Assignment';
import RadarIcon from '@mui/icons-material/Radar';
import GroupsIcon from '@mui/icons-material/Groups';
import SettingsInputAntennaIcon from '@mui/icons-material/SettingsInputAntenna';
import VerifiedIcon from '@mui/icons-material/Verified';
import MemoryIcon from '@mui/icons-material/Memory';
// import WarningIcon from '@mui/icons-material/Warning';
// import PublicIcon from '@mui/icons-material/Public';
// import AccessTimeIcon from '@mui/icons-material/AccessTime';
// import FlagIcon from '@mui/icons-material/Flag';
import { mapStringToColor } from "@/pages/SourceTypes/helpers/markers";
import { useRpcClient } from '@/hooks/useRpcClient';
import { useAuth } from '@/hooks/useAuth';
import { TdfObject } from '@/proto/tdf_object/v1/tdf_object_pb';
import { ObjectBanner } from '@/components/ObjectBanner';
import { extractValues } from '@/contexts/BannerContext';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import { fetchManifestFromS4, MilitaryManifest } from '@/services/s4Service';

// Interfaces
interface Coordinate {
  lat: number;
  lng: number;
}

interface VehicleProps {
  markerId: string;
  Position: Coordinate;
  rawObject: TdfObject;
  data?: any;
  onClick: () => void;
  onPopOut: (tdfResponse: any) => void;
}

interface RotatableIconProps {
  color: string;
  iconSize: L.PointExpression;
  iconAnchor: L.PointExpression;
}

function calculateBearing(start: Coordinate, end: Coordinate): number {
  const toRad = (deg: number) => deg * (Math.PI / 180);
  const toDeg = (rad: number) => rad * (180 / Math.PI);

  const startLat = toRad(start.lat);
  const startLng = toRad(start.lng);
  const endLat = toRad(end.lat);
  const endLng = toRad(end.lng);

  const dLng = endLng - startLng;
  const y = Math.sin(dLng) * Math.cos(endLat);
  const x = Math.cos(startLat) * Math.sin(endLat) - Math.sin(startLat) * Math.cos(endLat) * Math.cos(dLng);

  const bearing = toDeg(Math.atan2(y, x));
  return (bearing + 360) % 360;
}

const RotatableIcon = ({ color, iconSize, iconAnchor }: RotatableIconProps) => {
  const [width, height] = Array.isArray(iconSize) ? iconSize : ([20, 20] as [number, number]);

  const planeSvg = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${width}" height="${height}">
      <path fill="${color}" d="M21 16v-2l-8-5V3.5c0-.83-.67-1.5-1.5-1.5S10 2.67 10 3.5V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5z"/>
    </svg>
  `;

  const encodedSvg = encodeURIComponent(planeSvg);

  return useMemo(
    () =>
      L.divIcon({
        className: "plane-icon",
        iconSize: iconSize,
        iconAnchor: iconAnchor,
        html: `<img class="vehicle-icon-img" src="data:image/svg+xml,${encodedSvg}" style="width: ${width}px; height: ${height}px; display: block; transition: transform 0.2s linear;" />`,
      }),
    [color, iconSize, iconAnchor, encodedSvg]
  );
};

const ICON_PROPS = {
  size: [24, 24] as L.PointExpression,
  anchor: [12, 12] as L.PointExpression,
};

const getClassificationColor = (classification?: string | string[]): string => {
  if (!classification) return mapStringToColor('default');
  const classValue = Array.isArray(classification) ? classification[0] : classification;
  return mapStringToColor(classValue || 'default');
};

const getClassificationBgColor = (classification: string): string => {
  const cl = classification.toLowerCase();
  if (cl.includes('topsecret') || cl.includes('top secret')) return '#ff6600';
  if (cl.includes('secret')) return '#c8102e';
  if (cl.includes('confidential')) return '#003f87';
  return '#007a33';
};

const getPriorityColor = (priority: string): string => {
  switch (priority?.toUpperCase()) {
    case 'FLASH': return '#d32f2f';
    case 'IMMEDIATE': return '#f57c00';
    case 'PRIORITY': return '#fbc02d';
    default: return '#4caf50';
  }
};

const getStatusColor = (status: string): string => {
  switch (status?.toUpperCase()) {
    case 'ACTIVE': return '#4caf50';
    case 'ON_STATION': return '#2196f3';
    case 'RTB': return '#ff9800';
    case 'MAINTENANCE': return '#9e9e9e';
    default: return '#607d8b';
  }
};

const MAX_SPEED_KMH = 1000;
const SpeedGauge = ({ speedString }: { speedString: string | undefined }) => {
  const [value, unit] = speedString?.trim().split(' ') || ['0', 'km/h'];
  const speed = parseInt(value, 10);

  if (isNaN(speed)) {
    return (
      <Box className="speed-gauge-na">
        <Typography variant="caption" color="textSecondary" fontWeight="bold">N/A</Typography>
      </Box>
    );
  }

  const progress = Math.min(100, (speed / MAX_SPEED_KMH) * 100);
  const colorClass = progress > 70 ? 'speed-high' : progress > 40 ? 'speed-medium' : 'speed-low';

  return (
    <Box className="speed-gauge-container">
      <CircularProgress variant="determinate" value={100} size={60} thickness={4} className="speed-gauge-bg" sx={{ color: 'rgba(0, 0, 0, 0.2) !important' }} />
      <CircularProgress variant="determinate" value={progress} size={60} thickness={4} className={`speed-gauge-progress ${colorClass}`} />
      <Box className="speed-gauge-content">
        <Typography variant="h6" component="div" className="speed-value">{`${speed}`}</Typography>
        <Typography variant="caption" component="div" className="speed-unit" color="text.secondary">{unit}</Typography>
      </Box>
    </Box>
  );
};

const renderDetail = (Icon: React.ElementType, label: string, value: string | undefined) => (
  <Box className="detail-item">
    <Icon fontSize="small" className="detail-icon" sx={{ color: '#000 !important', fill: '#000 !important' }} />
    <Typography variant="caption" className="detail-label">{label}</Typography>
    <Typography variant="caption" className="detail-value">{value || "N/A"}</Typography>
  </Box>
);

const ManifestField = ({ label, value, mono = false }: { label: string; value: string | number | boolean | undefined | null; mono?: boolean }) => (
  <Box sx={{ display: 'flex', justifyContent: 'space-between', py: 0.25, borderBottom: '1px solid rgba(0,0,0,0.06)' }}>
    <Typography variant="caption" sx={{ color: 'text.secondary', fontWeight: 500 }}>{label}</Typography>
    <Typography variant="caption" sx={{ fontFamily: mono ? 'monospace' : 'inherit', fontWeight: mono ? 600 : 400, maxWidth: '60%', textAlign: 'right', wordBreak: 'break-word' }}>
      {value === true ? '✓ Yes' : value === false ? '✗ No' : value || 'N/A'}
    </Typography>
  </Box>
);

const ChipList = ({ items, color = 'default' }: { items: string[]; color?: 'default' | 'primary' | 'secondary' | 'error' | 'warning' | 'info' | 'success' }) => (
  <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, mt: 0.5 }}>
    {items.map((item, i) => (
      <Chip key={i} label={item} size="small" color={color} variant="outlined" sx={{ fontSize: '0.65rem', height: '20px' }} />
    ))}
  </Box>
);

const formatDateTime = (isoString: string | undefined): string => {
  if (!isoString) return 'N/A';
  try {
    return new Date(isoString).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
  } catch { return isoString; }
};

const ManifestSection = ({ title, icon: Icon, children, defaultExpanded = false }: { title: string; icon: React.ElementType; children: React.ReactNode; defaultExpanded?: boolean }) => (
  <Accordion defaultExpanded={defaultExpanded} disableGutters sx={{ '&:before': { display: 'none' }, boxShadow: 'none', border: '1px solid rgba(0,0,0,0.12)', borderRadius: '4px !important', mb: 0.5, '&.Mui-expanded': { mb: 0.5 } }}>
    <AccordionSummary expandIcon={<ExpandMoreIcon sx={{ fontSize: '1rem' }} />} sx={{ minHeight: '36px !important', '& .MuiAccordionSummary-content': { my: '6px !important' } }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <Icon sx={{ fontSize: '1rem', color: 'primary.main' }} />
        <Typography variant="caption" sx={{ fontWeight: 600 }}>{title}</Typography>
      </Box>
    </AccordionSummary>
    <AccordionDetails sx={{ pt: 0, pb: 1, px: 1.5 }}>{children}</AccordionDetails>
  </Accordion>
);

export function VehicleMarker({ markerId, Position, data, rawObject, onClick, onPopOut }: VehicleProps) {
  const { transformTdfObject } = useRpcClient();
  const { user } = useAuth();
  const [isLoading, setIsLoading] = useState(false);
  const [decryptedData, setDecryptedData] = useState<any>(null);
  const [currentPos, setCurrentPos] = useState(Position);
  
  const [manifest, setManifest] = useState<MilitaryManifest | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);

  const displayData = useMemo(() => ({ ...data, ...decryptedData }), [data, decryptedData]);

  const initialHeading = useMemo(() => {
    const heading = parseInt(displayData?.heading || "0", 10);
    return isNaN(heading) ? 0 : heading;
  }, []);

  const rotationRef = useRef<number>(initialHeading);
  const markerRef = useRef<L.Marker>(null);

  useEffect(() => {
    const markerEl = markerRef.current?.getElement();
    const iconImg = markerEl?.querySelector('.vehicle-icon-img') as HTMLElement;
    if (iconImg) iconImg.style.transform = `rotate(${rotationRef.current}deg)`;
  });

  useEffect(() => {
    const startPos = currentPos;
    const targetPos = Position;
    const duration = 3000;

    if (startPos.lat !== targetPos.lat || startPos.lng !== targetPos.lng) {
      rotationRef.current = calculateBearing(startPos, targetPos);
    } else if (displayData?.heading) {
      const dataHeading = parseInt(displayData.heading, 10);
      if (!isNaN(dataHeading)) rotationRef.current = dataHeading;
    }

    const markerEl = markerRef.current?.getElement();
    const iconImg = markerEl?.querySelector('.vehicle-icon-img') as HTMLElement;
    if (iconImg) iconImg.style.transform = `rotate(${rotationRef.current}deg)`;

    let lngDelta = targetPos.lng - startPos.lng;
    if (lngDelta > 180) lngDelta -= 360;
    else if (lngDelta < -180) lngDelta += 360;

    if (Math.abs(lngDelta) > 100 || Math.abs(targetPos.lat - startPos.lat) > 100) {
      markerRef.current?.setLatLng(targetPos);
      setCurrentPos(targetPos);
      return;
    }

    const startTime = Date.now();
    let frameId: number;
    const animate = () => {
      const now = Date.now();
      const progress = Math.min(1, (now - startTime) / duration);
      const newLat = startPos.lat + (targetPos.lat - startPos.lat) * progress;
      let newLng = startPos.lng + lngDelta * progress;
      newLng = ((newLng + 180) % 360) - 180;
      if (newLng <= -180) newLng += 360;

      markerRef.current?.setLatLng({ lat: newLat, lng: newLng });
      if (markerRef.current?.isPopupOpen()) markerRef.current.getPopup()?.update();

      setCurrentPos({ lat: newLat, lng: newLng });
      if (progress < 1) frameId = requestAnimationFrame(animate);
    };
    frameId = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(frameId);
  }, [Position, displayData?.heading]);

  const handleMarkerClick = async () => {
    if (onClick) onClick();
    if (decryptedData || isLoading) return;

    setIsLoading(true);
    try {
      const result = await transformTdfObject(rawObject);
      setDecryptedData(result.decryptedData);
    } catch (err) {
      console.error("Decryption failed", err);
    } finally {
      setIsLoading(false);
    }
  };

  const handlePopOutClick = () => {
    const tdfResponse: any = { tdfObject: rawObject, decryptedData: displayData };
    onPopOut(tdfResponse);
  };

  const handleSyncWithS3 = async () => {
    const manifestUri = displayData?.manifest;
    if (!manifestUri) { setSyncError('No manifest URI available'); return; }
    if (!user?.accessToken) { setSyncError('Not authenticated'); return; }

    setIsSyncing(true);
    setSyncError(null);

    try {
      const data = await fetchManifestFromS4(user.accessToken, manifestUri);
      setManifest(data);
    } catch (err: any) {
      console.error('Failed to sync with S3:', err);
      if (err.message === 'ENTITLEMENT_DENIED') {
        setSyncError('Access Denied: Insufficient entitlements');
      } else {
        setSyncError(err instanceof Error ? err.message : 'Sync failed');
      }
    } finally {
      setIsSyncing(false);
    }
  };

  const icon = RotatableIcon({
    color: getClassificationColor(displayData?.attrClassification),
    iconSize: ICON_PROPS.size,
    iconAnchor: ICON_PROPS.anchor,
  });

  const objClass = useMemo(() => extractValues(displayData?.attrClassification || []).split(', ').filter(Boolean), [displayData?.attrClassification]);
  const objNTK = useMemo(() => extractValues(displayData?.attrNeedToKnow || []).split(', ').filter(Boolean), [displayData?.attrNeedToKnow]);
  const objRel = useMemo(() => extractValues(displayData?.attrRelTo || []).split(', ').filter(Boolean), [displayData?.attrRelTo]);

  return (
    <Marker position={currentPos} ref={markerRef} icon={icon} eventHandlers={{ click: handleMarkerClick }}>
      <Popup minWidth={340} maxWidth={400} offset={[0, -15]} className="custom-vehicle-popup" closeButton={false}>
        <Box className="tooltip-container" sx={{ opacity: isLoading ? 0.8 : 1, position: 'relative', paddingBottom: '4px', maxHeight: '70vh', overflowY: 'auto' }}>
          <Tooltip title="Pop Out" placement="left">
            <IconButton size="small" onClick={handlePopOutClick} sx={{ position: 'absolute', top: 8, right: 8, zIndex: 10, padding: '4px', backgroundColor: '#1976d2', border: '1px solid #1565c0', '&:hover': { backgroundColor: '#1565c0' } }}>
              <OpenInNewIcon sx={{ fontSize: '16px', color: '#fff' }} />
            </IconButton>
          </Tooltip>

          <Box sx={{ pr: '36px' }}>
            <ObjectBanner objClassification={objClass.length > 0 ? objClass : ['N/A']} objNTK={objNTK} objRel={objRel} notes={[]} />
          </Box>
          
          <Box className="tooltip-header" sx={{ mt: 1 }}>
            <Typography variant="h6" className="vehicle-name" sx={{ pr: 2 }}>
              {isLoading ? "Decrypting..." : (displayData?.vehicleName || `ID: ${markerId.substring(0, 8)}`)}
            </Typography>
            <Box className="callsign-container">
              <Typography variant="caption" className="callsign-label">Callsign:</Typography>
              <Typography variant="caption" className="callsign-value">{displayData?.callsign || "N/A"}</Typography>
            </Box>
          </Box>

          <Box className="tooltip-section">
            <Typography variant="body2" className="section-title">Telemetry</Typography>
            <Box className="telemetry-grid">
              <Box className="speed-gauge-column"><SpeedGauge speedString={displayData?.speed} /></Box>
              <Box className="telemetry-details-column">
                {renderDetail(TrendingUpIcon, "Altitude: ", displayData?.altitude)}
                {renderDetail(GpsFixedIcon, "Heading: ", displayData?.heading)}
                {renderDetail(FlightIcon, "Type: ", displayData?.aircraft_type)}
              </Box>
            </Box>
          </Box>

          <Box className="tooltip-section">
            <Typography variant="body2" className="section-title">Flight Details</Typography>
            {renderDetail(AltRouteIcon, "Origin: ", displayData?.origin)}
            {renderDetail(AltRouteIcon, "Destination: ", displayData?.destination)}
            {renderDetail(MyLocationIcon, "Coordinates: ", `${currentPos.lat.toFixed(4)}, ${currentPos.lng.toFixed(4)}`)}
          </Box>

          <Divider sx={{ my: 1 }} />

          {/* Manifest Sync Section */}
          <Box sx={{ mb: 1 }}>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1 }}>
              <Typography variant="body2" sx={{ fontWeight: 600 }}>Intelligence Manifest</Typography>
              <Button
                variant="contained"
                size="small"
                startIcon={isSyncing ? <CircularProgress size={14} color="inherit" /> : <SyncIcon />}
                onClick={handleSyncWithS3}
                disabled={isSyncing || !displayData?.manifest}
                sx={{ fontSize: '0.7rem', padding: '4px 12px', textTransform: 'none' }}
              >
                {isSyncing ? 'Syncing...' : manifest ? 'Refresh' : 'Load Manifest'}
              </Button>
            </Box>
            
            {syncError && (
              <Box sx={{ bgcolor: 'rgba(211, 47, 47, 0.08)', p: 1, borderRadius: 1, borderLeft: '3px solid #d32f2f', mb: 1, display: 'flex', alignItems: 'center', gap: 1 }}>
                <LockIcon sx={{ fontSize: '16px', color: '#d32f2f' }} />
                <Typography variant="caption" color="error">{syncError}</Typography>
              </Box>
            )}

            {!manifest && !isSyncing && !syncError && displayData?.manifest && (
              <Box sx={{ bgcolor: 'rgba(25, 118, 210, 0.08)', p: 1.5, borderRadius: 1, textAlign: 'center' }}>
                <SecurityIcon sx={{ fontSize: '24px', color: 'primary.main', mb: 0.5 }} />
                <Typography variant="caption" display="block" color="text.secondary">
                  Click "Load Manifest" to fetch classified data from S4
                </Typography>
              </Box>
            )}
          </Box>

          {/* Full Manifest Display */}
          {manifest && (
            <Box sx={{ mt: 1 }}>
              {/* Classification Banner */}
              <Box sx={{ bgcolor: getClassificationBgColor(manifest.documentControl.classification), color: '#fff', p: 1, borderRadius: 1, mb: 1, textAlign: 'center' }}>
                <Typography variant="caption" sx={{ fontWeight: 700, letterSpacing: 1 }}>
                  {manifest.documentControl.classification}
                  {manifest.documentControl.caveats.length > 0 && ` // ${manifest.documentControl.caveats.join(' / ')}`}
                </Typography>
              </Box>

              {/* Document Control */}
              <ManifestSection title="Document Control" icon={SecurityIcon} defaultExpanded>
                <ManifestField label="Manifest ID" value={manifest.documentControl.manifestId.substring(0, 8) + '...'} mono />
                <ManifestField label="Originating Agency" value={manifest.documentControl.originatingAgency} />
                <ManifestField label="Created By" value={manifest.documentControl.createdBy} />
                <ManifestField label="Created At" value={formatDateTime(manifest.documentControl.createdAt)} />
                <ManifestField label="Declassify On" value={manifest.documentControl.declassifyOn} />
              </ManifestSection>

              {/* Vehicle / Platform */}
              <ManifestSection title="Platform" icon={FlightIcon} defaultExpanded>
                <ManifestField label="Designation" value={`${manifest.vehicle.platform.designation} ${manifest.vehicle.platform.name}`} />
                <ManifestField label="Type" value={manifest.vehicle.platform.type} />
                <ManifestField label="Service" value={manifest.vehicle.platform.service} />
                <ManifestField label="Registration" value={manifest.vehicle.registration} mono />
                <ManifestField label="Tail Number" value={manifest.vehicle.tailNumber} mono />
                <ManifestField label="Operator" value={manifest.vehicle.operator} />
                <ManifestField label="Home Station" value={manifest.vehicle.homeStation} />
                <ManifestField label="ICAO Hex" value={manifest.vehicle.icaoHex} mono />
                <ManifestField label="Mode 5" value={manifest.vehicle.mode5Interrogator} mono />
              </ManifestSection>

              {/* Mission */}
              <ManifestSection title="Mission" icon={AssignmentIcon}>
                <Box sx={{ display: 'flex', gap: 0.5, mb: 1, flexWrap: 'wrap' }}>
                  <Chip label={manifest.mission.missionType} size="small" color="primary" sx={{ fontSize: '0.65rem' }} />
                  <Chip label={manifest.mission.priority} size="small" sx={{ fontSize: '0.65rem', bgcolor: getPriorityColor(manifest.mission.priority), color: '#fff' }} />
                  <Chip label={manifest.mission.missionStatus} size="small" sx={{ fontSize: '0.65rem', bgcolor: getStatusColor(manifest.mission.missionStatus), color: '#fff' }} />
                </Box>
                <ManifestField label="Mission ID" value={manifest.mission.missionId} mono />
                <ManifestField label="Operation" value={manifest.mission.operationName} />
                <ManifestField label="Command" value={manifest.mission.commandAuthority} />
                <ManifestField label="ATO" value={manifest.mission.taskingOrder} mono />
                <Divider sx={{ my: 0.5 }} />
                <Typography variant="caption" sx={{ fontWeight: 600, color: 'text.secondary' }}>Timeline</Typography>
                <ManifestField label="Takeoff" value={formatDateTime(manifest.mission.timeline.takeoff)} />
                <ManifestField label="On Station" value={formatDateTime(manifest.mission.timeline.onStation)} />
                <ManifestField label="Off Station" value={formatDateTime(manifest.mission.timeline.offStation)} />
                <ManifestField label="Recovery" value={formatDateTime(manifest.mission.timeline.expectedRecovery)} />
                <Divider sx={{ my: 0.5 }} />
                <ManifestField label="Operating Area" value={manifest.mission.airspace.operatingArea} mono />
                <ManifestField label="Altitude Block" value={manifest.mission.airspace.altitudeBlock} />
                {manifest.mission.airspace.restrictedAreas.length > 0 && (
                  <>
                    <Typography variant="caption" sx={{ color: 'text.secondary' }}>Restricted Areas:</Typography>
                    <ChipList items={manifest.mission.airspace.restrictedAreas} color="warning" />
                  </>
                )}
              </ManifestSection>

              {/* Intelligence */}
              <ManifestSection title="Intelligence" icon={RadarIcon}>
                <Typography variant="caption" sx={{ color: 'text.secondary' }}>Collection Discipline:</Typography>
                <ChipList items={manifest.intelligence.collectionDiscipline} color="info" />
                <Divider sx={{ my: 0.5 }} />
                <Typography variant="caption" sx={{ fontWeight: 600, color: 'text.secondary' }}>Target Deck ({manifest.intelligence.targetDeck.length})</Typography>
                {manifest.intelligence.targetDeck.map((target, i) => (
                  <Box key={i} sx={{ bgcolor: 'rgba(0,0,0,0.03)', p: 0.5, borderRadius: 1, mt: 0.5 }}>
                    <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <Typography variant="caption" sx={{ fontWeight: 600 }}>{target.targetName}</Typography>
                      <Chip label={`P${target.priority}`} size="small" color={target.priority <= 2 ? 'error' : 'default'} sx={{ fontSize: '0.6rem', height: '16px' }} />
                    </Box>
                    <Typography variant="caption" sx={{ color: 'text.secondary', fontSize: '0.65rem' }}>{target.targetId} • {target.targetType}</Typography>
                  </Box>
                ))}
                <Divider sx={{ my: 0.5 }} />
                <ManifestField label="Reporting" value={manifest.intelligence.reportingInstructions} mono />
              </ManifestSection>

              {/* Sensors */}
              <ManifestSection title="Sensors & Datalinks" icon={SettingsInputAntennaIcon}>
                <ManifestField label="Primary Sensor" value={manifest.sensors.primarySensor} />
                <ManifestField label="EMCON" value={manifest.sensors.emissionControl} />
                <Typography variant="caption" sx={{ color: 'text.secondary' }}>Active Sensors:</Typography>
                <ChipList items={manifest.sensors.activeSensors} />
                <Typography variant="caption" sx={{ color: 'text.secondary', mt: 0.5, display: 'block' }}>Datalinks:</Typography>
                <ChipList items={manifest.sensors.datalinks} color="primary" />
              </ManifestSection>

              {/* Coordination */}
              <ManifestSection title="Coordination" icon={GroupsIcon}>
                <ManifestField label="Check-In Point" value={manifest.coordination.checkInPoint} mono />
                <Divider sx={{ my: 0.5 }} />
                <Typography variant="caption" sx={{ fontWeight: 600, color: 'text.secondary' }}>Frequency Plan</Typography>
                <ManifestField label="Primary" value={manifest.coordination.frequencyPlan.primary} mono />
                <ManifestField label="Secondary" value={manifest.coordination.frequencyPlan.secondary} mono />
                <ManifestField label="Guard" value={manifest.coordination.frequencyPlan.guard} mono />
                <Divider sx={{ my: 0.5 }} />
                <Typography variant="caption" sx={{ color: 'text.secondary' }}>Supporting Units:</Typography>
                <ChipList items={manifest.coordination.supportingUnits} />
                {manifest.coordination.coalitionPartners.length > 0 && (
                  <>
                    <Typography variant="caption" sx={{ color: 'text.secondary', mt: 0.5, display: 'block' }}>Coalition Partners:</Typography>
                    <ChipList items={manifest.coordination.coalitionPartners} color="success" />
                  </>
                )}
              </ManifestSection>

              {/* Track Quality */}
              <ManifestSection title="Track Quality" icon={VerifiedIcon}>
                <ManifestField label="Source" value={manifest.trackQuality.source} />
                <ManifestField label="Reliability" value={`${(manifest.trackQuality.reliability * 100).toFixed(1)}%`} />
                <ManifestField label="Position Accuracy" value={`${manifest.trackQuality.positionAccuracy_m} m`} />
                <ManifestField label="Velocity Accuracy" value={`${manifest.trackQuality.velocityAccuracy_mps} m/s`} />
                <ManifestField label="Update Rate" value={`${manifest.trackQuality.updateRate_sec} sec`} />
                <ManifestField label="Last Update" value={formatDateTime(manifest.trackQuality.lastUpdate)} />
              </ManifestSection>

              {/* Processing */}
              <ManifestSection title="Processing" icon={MemoryIcon}>
                <ManifestField label="Pipeline" value={manifest.processing.ingestPipeline} mono />
                <ManifestField label="Node" value={manifest.processing.processingNode} mono />
                <ManifestField label="Processing Time" value={`${manifest.processing.processingTime_ms} ms`} />
                <ManifestField label="Fused Sources" value={manifest.processing.fusedSources} />
                <ManifestField label="Validated" value={manifest.processing.validated} />
                <ManifestField label="Correlation ID" value={manifest.processing.correlationId.substring(0, 8) + '...'} mono />
              </ManifestSection>

              {/* Bottom Classification Banner */}
              <Box sx={{ bgcolor: getClassificationBgColor(manifest.documentControl.classification), color: '#fff', p: 0.5, borderRadius: 1, mt: 1, textAlign: 'center' }}>
                <Typography variant="caption" sx={{ fontWeight: 600, fontSize: '0.65rem' }}>
                  {manifest.documentControl.classification}
                </Typography>
              </Box>
            </Box>
          )}

          {isLoading && <Box sx={{ display: 'flex', justifyContent: 'center', mt: 1 }}><CircularProgress size={20} /></Box>}
        </Box>
      </Popup>
    </Marker>
  );
}