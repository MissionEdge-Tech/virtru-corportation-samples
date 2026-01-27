import { StorageClass } from '@aws-sdk/client-s3';

export interface S3Provider {
  useSts: boolean;
  stsEndpoint: string;
  roleArn: string;
  region: string;
  stsRegion?: string;
  endpointUrl?: string;
  bucket?: string;           // Added '?' to make it optional
  forcePathStyle?: boolean;
}

export interface S3Object {
  key: string;
  isFolder: boolean;
  lastModified?: Date;
  size?: number;
  storageClass?: StorageClass | string;
}