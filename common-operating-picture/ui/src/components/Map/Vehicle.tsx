import { useMemo, useState, useEffect, useRef } from "react";
import { Marker, Popup } from "react-leaflet";
import L from "leaflet";
import { Typography } from "@mui/material";

interface Coordinate {
  lat: number;
  lng: number;
}

interface VehicleProps {
  markerId: string;
  Position: Coordinate;
  data?: {
    vehicleName: string;
  };
}

interface RotatableIconProps {
  rotationAngle: number;
  iconUrl: string;
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
  const x =
    Math.cos(startLat) * Math.sin(endLat) -
    Math.sin(startLat) * Math.cos(endLat) * Math.cos(dLng);

  const bearing = toDeg(Math.atan2(y, x));
  return (bearing + 360) % 360;
}

const RotatableIcon = ({
  rotationAngle,
  iconUrl,
  iconSize,
  iconAnchor,
}: RotatableIconProps) => {
  const [width, height] = Array.isArray(iconSize)
    ? iconSize
    : ([20, 20] as [number, number]);

  return useMemo(
    () =>
      L.divIcon({
        className: "plane-icon",
        iconSize: iconSize,
        iconAnchor: iconAnchor,
        html: `
            <img
                src="${iconUrl}"
                style="
                    width: ${width}px;
                    height: ${height}px;
                    transform: rotate(${rotationAngle}deg);
                    display: block;
                "
            />
        `,
      }),
    [rotationAngle, iconUrl, iconSize, iconAnchor]
  );
};

const ICON_PROPS = {
  url: "/img/plane.png",
  size: [24, 24] as L.PointExpression,
  anchor: [12, 12] as L.PointExpression,
};

export function VehicleMarker({ markerId, Position, data }: VehicleProps) {
  const [currentPos, setCurrentPos] = useState(Position);
  const [rotationAngle, setRotationAngle] = useState(0);
  const markerRef = useRef<L.Marker>(null);

  useEffect(() => {
    const startPos = currentPos;
    const targetPos = Position;
    const duration = 3000;

    if (startPos.lat !== targetPos.lat || startPos.lng !== targetPos.lng) {
      setRotationAngle(calculateBearing(startPos, targetPos));
    }

    let lngDelta = targetPos.lng - startPos.lng;
    if (lngDelta > 180) lngDelta -= 360;
    else if (lngDelta < -180) lngDelta += 360;

    if (
      Math.abs(lngDelta) > 100 ||
      Math.abs(targetPos.lat - startPos.lat) > 100
    ) {
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
      setCurrentPos({ lat: newLat, lng: newLng });

      if (progress < 1) {
        frameId = requestAnimationFrame(animate);
      }
    };

    frameId = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(frameId);
  }, [Position]);

  const icon = RotatableIcon({
    rotationAngle,
    iconUrl: ICON_PROPS.url,
    iconSize: ICON_PROPS.size,
    iconAnchor: ICON_PROPS.anchor,
  });

  return (
    <Marker position={currentPos} ref={markerRef} icon={icon}>
      <Popup>
        <Typography variant="subtitle2">
          {data?.vehicleName || markerId}
        </Typography>
        <Typography variant="caption">
          {currentPos.lat.toFixed(4)}, {currentPos.lng.toFixed(4)}
        </Typography>
      </Popup>
    </Marker>
  );
}
