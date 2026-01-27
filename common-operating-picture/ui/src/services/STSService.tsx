// src/services/STSService.ts
import { STSClient, AssumeRoleWithWebIdentityCommand } from '@aws-sdk/client-sts';
import { S3Provider } from '../types/s3';

export interface STSCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
}

class STSService {
  async assumeRoleWithWebIdentity(
    provider: S3Provider,
    webIdentityToken: string
  ): Promise<STSCredentials> {
    if (!provider.useSts || !provider.stsEndpoint || !provider.roleArn) {
      throw new Error('Provider is not configured for STS authentication');
    }

    const stsClient = new STSClient({
      region: provider.stsRegion || provider.region,
      endpoint: provider.stsEndpoint,
    });

    const command = new AssumeRoleWithWebIdentityCommand({
      RoleArn: provider.roleArn,
      WebIdentityToken: webIdentityToken,
      RoleSessionName: `s3-browser-session-${Date.now()}`,
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

  // Helper to peek at token contents if needed for debugging
  decodeOidcAccessToken(token: string) {
    const parts = token.split('.');
    if (parts.length !== 3) throw new Error('Invalid token format');
    return JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
  }
}

export const stsService = new STSService();