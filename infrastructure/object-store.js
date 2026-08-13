'use strict';

class S3ObjectStore {
  constructor(options={}) {
    let sdk=options.sdk; if (!sdk) { try { sdk=require('@aws-sdk/client-s3'); } catch { throw new Error('S3 object storage requires the "@aws-sdk/client-s3" package. Run npm install.'); } }
    this.commands=sdk; this.bucket=options.bucket; this.createBucket=options.createBucket === true;
    this.client=options.client || new sdk.S3Client({ region:options.region || 'eu-central-1',endpoint:options.endpoint || undefined,forcePathStyle:options.forcePathStyle === true,credentials:options.accessKeyId ? { accessKeyId:options.accessKeyId,secretAccessKey:options.secretAccessKey } : undefined });
    this.ready=false; this.lastError=null;
  }
  async initialize() { try { await this.client.send(new this.commands.HeadBucketCommand({ Bucket:this.bucket })); } catch(error) { if (!this.createBucket) { this.lastError=error.message; throw error; } await this.client.send(new this.commands.CreateBucketCommand({ Bucket:this.bucket })); } this.ready=true; this.lastError=null; }
  async put(key,content,metadata) { await this.client.send(new this.commands.PutObjectCommand({ Bucket:this.bucket,Key:key,Body:content,ContentType:metadata.contentType,Metadata:{ sha256:metadata.sha256,originalname:encodeURIComponent(metadata.name) },ServerSideEncryption:metadata.serverSideEncryption || undefined })); return { objectKey:key }; }
  async get(key) { const response=await this.client.send(new this.commands.GetObjectCommand({ Bucket:this.bucket,Key:key })); if (!response.Body) throw new Error('Object storage returned an empty attachment'); return Buffer.from(await response.Body.transformToByteArray()); }
  health() { return { driver:'s3',ready:this.ready,error:this.lastError,bucket:this.bucket }; }
  async close() { this.client.destroy(); }
}
module.exports={ S3ObjectStore };
