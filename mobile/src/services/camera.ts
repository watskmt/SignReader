/**
 * CameraService — handles camera/location permissions and frame capture.
 */
import { Platform } from 'react-native';
import Geolocation from '@react-native-community/geolocation';
import { check, PERMISSIONS, request, RESULTS } from 'react-native-permissions';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let Camera: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  Camera = require('react-native-vision-camera').Camera;
} catch { /* native module not available */ }
import RNFS from 'react-native-fs';

export interface GpsCoordinates {
  latitude: number;
  longitude: number;
  altitude: number | null;
}

export class CameraService {
  /**
   * Request camera permission.
   * Returns true if granted, false otherwise.
   */
  async requestCameraPermission(): Promise<boolean> {
    const status = await Camera.requestCameraPermission();
    return status === 'granted';
  }

  /**
   * Request location permission.
   * Returns true if granted, false otherwise.
   */
  async requestLocationPermission(): Promise<boolean> {
    const permission =
      Platform.OS === 'ios'
        ? PERMISSIONS.IOS.LOCATION_WHEN_IN_USE
        : PERMISSIONS.ANDROID.ACCESS_FINE_LOCATION;

    const current = await check(permission);
    if (current === RESULTS.GRANTED) {
      return true;
    }

    const result = await request(permission);
    return result === RESULTS.GRANTED;
  }

  /**
   * Get the current GPS position.
   * Rejects if location permission is not granted or unavailable.
   */
  getCurrentLocation(): Promise<GpsCoordinates> {
    return new Promise((resolve, reject) => {
      Geolocation.getCurrentPosition(
        (position) => {
          resolve({
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
            altitude: position.coords.altitude ?? null,
          });
        },
        (error) => {
          reject(new Error(`Location error (${error.code}): ${error.message}`));
        },
        {
          enableHighAccuracy: true,
          timeout: 10_000,
          maximumAge: 5_000,
        },
      );
    });
  }

  /**
   * Capture a single frame from the camera reference as a base64 JPEG string.
   *
   * @param cameraRef - React ref pointing to a Vision Camera instance.
   * @returns base64-encoded JPEG data (no data: URL prefix).
   */
  async captureFrame(cameraRef: React.RefObject<Camera>): Promise<string> {
    if (!cameraRef.current) {
      throw new Error('Camera reference is not available');
    }

    // Ensure cache directory exists before Vision Camera writes the photo
    const cacheDir = RNFS.CachesDirectoryPath;
    await RNFS.mkdir(cacheDir).catch(() => {});

    const photo = await cameraRef.current.takePhoto({
      flash: 'off',
      enableShutterSound: false,
    });

    // photo.path may or may not have a file:// prefix — normalise to plain path
    const filePath = photo.path.replace(/^file:\/\//, '');
    const base64 = await RNFS.readFile(filePath, 'base64');

    RNFS.unlink(filePath).catch(() => {});

    return base64;
  }

  /**
   * Start capturing frames at *intervalMs* milliseconds.
   * Calls *callback* with the base64-encoded frame on each capture.
   * Returns the interval ID — pass it to stopFrameCapture to stop.
   */
  startFrameCapture(
    cameraRef: React.RefObject<Camera>,
    intervalMs: number,
    callback: (frame: string) => void,
  ): ReturnType<typeof setInterval> {
    const id = setInterval(async () => {
      try {
        const frame = await this.captureFrame(cameraRef);
        callback(frame);
      } catch (err) {
        // Silently skip failed frames — camera may not be ready yet
        console.warn('[CameraService] Frame capture error:', err);
      }
    }, intervalMs);
    return id;
  }

  /**
   * Stop an active frame capture interval.
   */
  stopFrameCapture(intervalId: ReturnType<typeof setInterval>): void {
    clearInterval(intervalId);
  }
}

export default new CameraService();
