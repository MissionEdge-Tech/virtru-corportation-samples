import { STSClient, AssumeRoleWithWebIdentityCommand } from '@aws-sdk/client-sts';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';

// S4 Configuration - adjust these based on your environment
const S4_ENDPOINT = 'http://localhost:7070';
const S4_REGION = 'us-east-1';
const ROLE_ARN = 'arn:aws:iam::xxxx:xxx/xxx'; // S4 ignores this but requires it

export interface STSCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
}

export interface ManifestVehicleInfo {
  registration: string | null;
  operator: string | null;
}

/**
 * Exchange JWT for temporary S3 credentials via S4 STS
 */
export async function getS4Credentials(accessToken: string): Promise<STSCredentials> {
  const stsClient = new STSClient({
    region: S4_REGION,
    endpoint: S4_ENDPOINT,
  });

  const command = new AssumeRoleWithWebIdentityCommand({
    RoleArn: ROLE_ARN,
    WebIdentityToken: accessToken,
    RoleSessionName: `cop-ui-session-${Date.now()}`,
    DurationSeconds: 3600,
  });

  const response = await stsClient.send(command);

  if (!response.Credentials) {
    throw new Error('No credentials returned from STS');
  }

  return {
    accessKeyId: response.Credentials.AccessKeyId!,
    secretAccessKey: response.Credentials.SecretAccessKey!,
    sessionToken: response.Credentials.SessionToken!,
  };
}

/**
 * Parse S3 URI into bucket and key
 */
export function parseS3Uri(s3Uri: string): { bucket: string; key: string } | null {
  if (!s3Uri || !s3Uri.startsWith('s3://')) {
    return null;
  }
  
  const path = s3Uri.slice(5); // Remove 's3://'
  const parts = path.split('/', 1);
  
  if (parts.length === 0) {
    return null;
  }
  
  const bucket = parts[0];
  const key = path.slice(bucket.length + 1);
  
  return { bucket, key };
}

/**
 * Fetch manifest from S4 and extract vehicle info
 */
export async function fetchManifestFromS4(
  accessToken: string,
  manifestUri: string
): Promise<ManifestVehicleInfo> {
  // Parse the S3 URI
  const parsed = parseS3Uri(manifestUri);
  if (!parsed) {
    throw new Error(`Invalid S3 URI: ${manifestUri}`);
  }

  // Get STS credentials
  const credentials = await getS4Credentials(accessToken);

  // Create S3 client with STS credentials
  const s3Client = new S3Client({
    region: S4_REGION,
    endpoint: S4_ENDPOINT,
    forcePathStyle: true,
    credentials: {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      sessionToken: credentials.sessionToken,
    },
  });

  // Fetch the manifest
  const command = new GetObjectCommand({
    Bucket: parsed.bucket,
    Key: parsed.key,
  });

  const response = await s3Client.send(command);

  if (!response.Body) {
    throw new Error('No data received from S4');
  }

  // Read the response body
  let bodyText: string;
  
  // Handle browser ReadableStream
  const reader = (response.Body as any).getReader?.();
  if (reader) {
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const combined = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.length;
    }
    bodyText = new TextDecoder().decode(combined);
  } else {
    // Node.js stream fallback
    const arrayBuffer = await (response.Body as any).transformToByteArray();
    bodyText = new TextDecoder().decode(new Uint8Array(arrayBuffer));
  }

  // Parse JSON and extract vehicle info
  const manifest = JSON.parse(bodyText);

  return {
    registration: manifest?.vehicle?.registration || null,
    operator: manifest?.vehicle?.operator || null,
  };
}